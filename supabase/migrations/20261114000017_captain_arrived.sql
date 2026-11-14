-- 0017 (14 Nov 2026): "I've arrived at the pickup". The captain tells the rider they are waiting at the pickup; the
-- rider sees "Your captain has arrived". Recorded as trip_groups.arrived_at plus a captain_arrived event (no new status:
-- arriving still means "at or on the way to the pickup"). Simulated captains do the same in fast demo. Forward-only.
alter table public.trip_groups add column arrived_at timestamptz;

create function public.captain_arrived(p_group uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.trip_groups;
begin
  select * into g from public.trip_groups where id = p_group for update;
  if g.id is null or g.driver_id is distinct from auth.uid() then raise exception 'forbidden'; end if;
  if g.status = 'accepted' then perform public._advance(p_group, 'arriving'); end if;
  if (select status from public.trip_groups where id = p_group) <> 'arriving' then raise exception 'invalid_transition: not on the way to the pickup'; end if;
  if g.arrived_at is null then
    update public.trip_groups set arrived_at = now() where id = p_group;
    perform public._event(p_group, 'captain_arrived', 'arriving', 'arriving', '{}'::jsonb);
  end if;
end $$;
revoke execute on function public.captain_arrived(uuid) from public, anon;
grant execute on function public.captain_arrived(uuid) to authenticated;

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
               and now() - greatest(tg.accepted_at, coalesce(tg.arriving_at, tg.accepted_at), coalesce(tg.arrived_at, tg.accepted_at), coalesce(tg.started_at, tg.accepted_at)) > make_interval(secs => s.sim_step_s) loop
      begin
        perform 1 from public.trip_groups where id = g.id for update;
        -- a simulated captain also stops at the pickup and says so before the rider gets in
        if (select status = 'arriving' and arrived_at is null from public.trip_groups where id = g.id) then
          update public.trip_groups set arrived_at = now() where id = g.id;
          perform public._event(g.id, 'captain_arrived', 'arriving', 'arriving', jsonb_build_object('simulated', true));
        else
          perform public._advance(g.id, case (select status from public.trip_groups where id = g.id)
            when 'accepted' then 'arriving' when 'arriving' then 'ongoing' when 'ongoing' then 'completed' end);
        end if;
        n_auto := n_auto + 1;
      exception when others then errs := errs || jsonb_build_object('step', 'auto_advance', 'id', g.id, 'error', sqlerrm); end;
    end loop;
  end if;
  begin repo := public._reposition_tick(false);
  exception when others then errs := errs || jsonb_build_object('step', 'reposition', 'error', sqlerrm); end;
  return jsonb_build_object('timeouts', n_timeout, 'delays', n_delay, 'auto', n_auto, 'unavailable', n_unavail, 'ineligible', n_inelig,
    'unreachable', n_unreach, 'retried', n_retry, 'reposition', repo, 'errors', errs, 'skipped', false);
end $$;
