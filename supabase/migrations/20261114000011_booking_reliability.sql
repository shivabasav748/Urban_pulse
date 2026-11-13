-- 0011: booking reliability (14 Nov 2026). Forward-only; no data changes.
--   1. _accept_offer records who accepted: 'captain' (respond_offer) or 'simulated_auto_accept' (fast-demo sweep, simulated
--      captains only). Same locks, same validation, same persistence path; the audit trail now tells them apart.
--   2. retry_ride can widen the search area (2 -> 3 -> 5 km, never shrink) after "no captain found". The category is never
--      changed by a retry.

drop function public._accept_offer(uuid);
create function public._accept_offer(p_offer uuid, p_auto boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.ride_offers; g public.trip_groups;
begin
  select * into o from public.ride_offers where id = p_offer;
  select * into g from public.trip_groups where id = o.group_id for update;
  perform 1 from public.driver_profiles where user_id = o.driver_id for update;
  select * into o from public.ride_offers where id = p_offer for update;
  if o.outcome <> 'pending' then raise exception 'conflict: offer already %', o.outcome; end if;
  if o.expires_at < now() then  -- too late: treat as no response and reassign (no raise, or the reassignment rolls back)
    perform public._fail_offer(p_offer, 'no_response', 'expired'); return;
  end if;
  if not public._pref_ok(g.women_driver_pref, o.driver_id) then  -- withdrew the opt-in after the offer was made
    perform public._fail_offer(p_offer, 'cancelled', 'captain_not_eligible_for_preference'); return;
  end if;
  update public.ride_offers set outcome = 'accepted', responded_at = now() where id = p_offer;
  update public.trip_groups set status = 'accepted', driver_id = o.driver_id, accepted_at = now() where id = o.group_id;
  update public.driver_profiles set offers_accepted = offers_accepted + 1, idle_since = null where user_id = o.driver_id;
  -- a captain who takes a ride stops repositioning
  update public.reposition_moves set status = 'cancelled', closed_reason = 'took_a_ride', responded_at = coalesce(responded_at, now())
  where driver_id = o.driver_id and status in ('recommended', 'accepted');
  perform public._event(o.group_id, 'offer_accepted', 'offered', 'accepted',
    jsonb_build_object('offer_id', p_offer, 'driver_id', o.driver_id, 'attempt', o.attempt_no,
      'acceptance', case when p_auto then 'simulated_auto_accept' else 'captain' end));
  perform public._sync(o.group_id);
end $$;

create or replace function public.sweep_exceptions() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.settings; o record; g record; n_timeout int := 0; n_delay int := 0; n_auto int := 0; n_unavail int := 0;
  n_inelig int := 0; n_unreach int := 0; n_retry int := 0; errs jsonb := '[]'; repo jsonb;
begin
  if auth.uid() is null then raise exception 'forbidden'; end if;
  if not pg_catalog.pg_try_advisory_xact_lock(727201, 1) then
    return jsonb_build_object('timeouts', 0, 'delays', 0, 'auto', 0, 'errors', '[]'::jsonb, 'skipped', true, 'reason', 'sweep_in_progress');
  end if;
  select * into s from public.settings;
  for o in select id from public.ride_offers where outcome = 'pending' and expires_at < now() loop
    begin perform public._fail_offer(o.id, 'no_response', 'timeout'); n_timeout := n_timeout + 1;
    exception when others then errs := errs || jsonb_build_object('step', 'timeout', 'id', o.id, 'error', sqlerrm); end;
  end loop;
  -- captain went offline / location went stale while holding an offer
  for o in select ro.id from public.ride_offers ro join public.driver_profiles dp on dp.user_id = ro.driver_id
           where ro.outcome = 'pending' and (not dp.online or not public._location_ok(dp)) loop
    begin perform public._fail_offer(o.id, 'no_response', 'captain_unavailable'); n_unavail := n_unavail + 1;
    exception when others then errs := errs || jsonb_build_object('step', 'unavailable', 'id', o.id, 'error', sqlerrm); end;
  end loop;
  -- preference request held by a captain who is no longer opted in
  for o in select ro.id from public.ride_offers ro join public.trip_groups tg on tg.id = ro.group_id
           where ro.outcome = 'pending' and tg.women_driver_pref and not public._pref_ok(true, ro.driver_id) loop
    begin perform public._fail_offer(o.id, 'cancelled', 'captain_not_eligible_for_preference'); n_inelig := n_inelig + 1;
    exception when others then errs := errs || jsonb_build_object('step', 'ineligible', 'id', o.id, 'error', sqlerrm); end;
  end loop;
  for g in select id from public.trip_groups tg where status = 'arriving'
      and now() - arriving_at > make_interval(mins => 1) * (coalesce((select max(est_pickup_min) from public.rides r
          join public.trip_group_members m on m.ride_id = r.id where m.group_id = tg.id), 5) + s.delay_threshold_min)
      and not (select is_simulated from public.driver_profiles where user_id = tg.driver_id) loop
    begin perform public._release(g.id, 'arrival_delayed'); n_delay := n_delay + 1;
    exception when others then errs := errs || jsonb_build_object('step', 'delay', 'id', g.id, 'error', sqlerrm); end;
  end loop;
  -- assigned (real) captain unreachable before pickup: offline or no fresh location. Never after the rider is on board.
  for g in select tg.id from public.trip_groups tg join public.driver_profiles dp on dp.user_id = tg.driver_id
           where tg.status in ('accepted', 'arriving') and not dp.is_simulated and (not dp.online or not public._location_ok(dp)) loop
    begin perform public._release(g.id, 'captain_unreachable'); n_unreach := n_unreach + 1;
    exception when others then errs := errs || jsonb_build_object('step', 'unreachable', 'id', g.id, 'error', sqlerrm); end;
  end loop;
  -- riders who chose "keep waiting": search again (finalises as no_driver_found once the window passes).
  -- Only waiting groups: rides the judge created without dispatch (pooling demo) are left alone.
  for g in select tg.id from public.trip_groups tg where tg.status = 'requested' and tg.wait_until is not null
      and not exists (select 1 from public.ride_offers ro where ro.group_id = tg.id and ro.outcome = 'pending') loop
    begin perform public._dispatch(g.id); n_retry := n_retry + 1;
    exception when others then errs := errs || jsonb_build_object('step', 'retry', 'id', g.id, 'error', sqlerrm); end;
  end loop;
  if s.fast_demo then
    for o in select ro.id from public.ride_offers ro join public.driver_profiles dp on dp.user_id = ro.driver_id
             where ro.outcome = 'pending' and dp.is_simulated and now() - ro.offered_at > make_interval(secs => s.auto_accept_s) loop
      begin perform public._accept_offer(o.id, true); n_auto := n_auto + 1;  -- SIMULATED captains only (dp.is_simulated)
      exception when others then errs := errs || jsonb_build_object('step', 'auto_accept', 'id', o.id, 'error', sqlerrm); end;
    end loop;
    for g in select tg.id from public.trip_groups tg join public.driver_profiles dp on dp.user_id = tg.driver_id
             where dp.is_simulated and tg.status in ('accepted', 'arriving', 'ongoing')
               and now() - greatest(tg.accepted_at, coalesce(tg.arriving_at, tg.accepted_at), coalesce(tg.started_at, tg.accepted_at)) > interval '6 seconds' loop
      begin
        perform 1 from public.trip_groups where id = g.id for update;
        perform public._advance(g.id, case (select status from public.trip_groups where id = g.id)
          when 'accepted' then 'arriving' when 'arriving' then 'ongoing' when 'ongoing' then 'completed' end);
        n_auto := n_auto + 1;
      exception when others then errs := errs || jsonb_build_object('step', 'auto_advance', 'id', g.id, 'error', sqlerrm); end;
    end loop;
  end if;
  begin repo := public._reposition_tick(false);
  exception when others then errs := errs || jsonb_build_object('step', 'reposition', 'error', sqlerrm); end;
  return jsonb_build_object('timeouts', n_timeout, 'delays', n_delay, 'auto', n_auto, 'unavailable', n_unavail, 'ineligible', n_inelig,
    'unreachable', n_unreach, 'retried', n_retry, 'reposition', repo, 'errors', errs, 'skipped', false);
end $$;

drop function public.retry_ride(uuid, boolean);
create function public.retry_ride(p_ride uuid, p_drop_preference boolean default false, p_radius_m int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.rides; gid uuid; g public.trip_groups; s public.settings; pref boolean;
begin
  select * into r from public.rides where id = p_ride and rider_id = auth.uid();
  if not found then raise exception 'forbidden'; end if;
  select group_id into gid from public.trip_group_members where ride_id = p_ride;
  select * into g from public.trip_groups where id = gid for update;
  if g.is_pool then raise exception 'invalid_transition: pooled rides are retried by the operator'; end if;
  if not (g.status = 'no_driver_found' or (g.status = 'requested' and g.wait_until is not null)) then
    raise exception 'invalid_transition: this ride is not waiting for a captain';
  end if;
  if p_radius_m is not null and p_radius_m not in (2000, 3000, 5000) then raise exception 'validation: radius must be 2000, 3000 or 5000'; end if;
  if p_radius_m < g.search_radius_m then raise exception 'validation: the search area can only grow'; end if;
  select * into s from public.settings;
  pref := g.women_driver_pref and not coalesce(p_drop_preference, false);
  update public.rides set women_driver_pref = pref where id = p_ride;
  update public.trip_groups set status = 'requested', women_driver_pref = pref, searching_since = now(),
    search_radius_m = coalesce(p_radius_m, search_radius_m),
    wait_until = now() + make_interval(mins => s.keep_waiting_min)
  where id = gid;
  perform public._event(gid, 'search_restarted', g.status, 'requested',
    jsonb_build_object('women_driver_pref', pref, 'preference_removed', g.women_driver_pref and not pref, 'wait_min', s.keep_waiting_min,
      'radius_m', coalesce(p_radius_m, g.search_radius_m), 'category', g.category));
  perform public._sync(gid);
  perform public._dispatch(gid);
  return jsonb_build_object('status', (select status from public.trip_groups where id = gid), 'women_driver_pref', pref);
end $$;

revoke execute on function public._accept_offer(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.retry_ride(uuid, boolean, int) from public, anon;
grant execute on function public.retry_ride(uuid, boolean, int) to authenticated;
