-- 0014 (14 Nov 2026): passenger shared rides with a split fare, captain "ignore", quick tries in busy areas,
-- "why this captain" for the rider, traffic/density levels for the maps, and demo data for the women-driver preference
-- and the JCER Machhe area. Forward-only.

-- ============ settings ============
alter table public.settings add column quick_offer_s int not null default 10 check (quick_offer_s between 5 and 60);
alter table public.trip_groups add column shared_requested boolean not null default false;

-- ============ SIMULATED demo data ============
-- Women-driver preference: the simulated captains presented as women in the demo opt in (all fictional, SIMULATED).
-- Earlier this was every third plate, which put men's names on women-driver matches and confused riders.
delete from public.captain_preferences where simulated;
insert into public.captain_preferences(user_id, women_riders_optin, consented_at, simulated, declaration)
select dp.user_id, true, now(), true, 'simulated-demo-flag' from public.driver_profiles dp
where dp.is_simulated and dp.plate in ('KA-SIM-004', 'KA-SIM-006', 'KA-SIM-008', 'KA-SIM-010', 'KA-SIM-012', 'KA-SIM-014', 'KA-SIM-016')
on conflict (user_id) do update set women_riders_optin = true, simulated = true, declaration = 'simulated-demo-flag';
insert into public.captain_preference_audit(user_id, actor, action)
select user_id, null, 'seed_simulated' from public.captain_preferences where simulated;

-- Home positions: a woman cab and bike near Rani Channamma Circle; a cab, auto and bike (incl. women) near JCER, Machhe.
with h(plate, lat, lng) as (values
  ('KA-SIM-004', 15.8760, 74.5160), ('KA-SIM-010', 15.8700, 74.5150),
  ('KA-SIM-006', 15.8030, 74.4870), ('KA-SIM-011', 15.7990, 74.4830), ('KA-SIM-015', 15.8000, 74.4790),
  ('KA-SIM-016', 15.8010, 74.4850), ('KA-SIM-012', 15.7960, 74.4790))
, upd as (update public.demo_driver_seed s set home_lat = h.lat, home_lng = h.lng
          from h join public.driver_profiles dp on dp.plate = h.plate where s.user_id = dp.user_id returning s.user_id)
update public.driver_profiles dp set lat = h.lat, lng = h.lng, op_zone = public._zone_of(h.lat, h.lng), location_source = 'simulated'
from h where dp.plate = h.plate and dp.is_simulated
  and not exists (select 1 from public.trip_groups g where g.driver_id = dp.user_id and g.status in ('accepted', 'arriving', 'ongoing'));

-- ============ quick tries in busy areas ============
create or replace function public._dispatch(p_group uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s public.settings; g public.trip_groups; c record; ranking jsonb; offer_id uuid; prev text; tried int; elig jsonb; quick boolean;
begin
  select * into s from public.settings;
  select * into g from public.trip_groups where id = p_group for update;
  if g.status not in ('requested') then return null; end if;
  prev := g.status;
  select count(*) into tried from public.ride_offers where group_id = p_group and offered_at >= g.searching_since;
  if tried >= s.max_attempts and not coalesce(g.wait_until > now(), false) then
    update public.trip_groups set status = 'no_driver_found', wait_until = null where id = p_group;
    perform public._event(p_group, 'no_driver_found', prev, 'no_driver_found',
      jsonb_build_object('reason', 'max_attempts', 'women_driver_pref', g.women_driver_pref));
    perform public._sync(p_group); return null;
  end if;
  -- busy pickup area (undersupplied or peak): shorter offers, so the up-to-5 tries move on quickly
  select coalesce(bool_or(b.peak or b.state = 'undersupplied'), false) into quick from public.zone_balance() b
   where b.zone_id = public._zone_of((g.stops->0->>'lat')::float8, (g.stops->0->>'lng')::float8);
  select coalesce(jsonb_agg(to_jsonb(r)), '[]') into ranking from (select * from public._rank(p_group) limit 5) r;
  for c in select * from public._rank(p_group) loop
    -- lock the candidate; skip if another transaction holds them (being dispatched to, accepting, going offline)
    perform 1 from public.driver_profiles where user_id = c.driver_id for update skip locked;
    if not found then continue; end if;
    -- revalidate under the lock: the ranking above is a snapshot and may already be stale
    if not exists (select 1 from public.driver_profiles dp where dp.user_id = c.driver_id and dp.online and public._location_ok(dp))
       or exists (select 1 from public.trip_groups a where a.driver_id = c.driver_id and a.status in ('accepted', 'arriving', 'ongoing'))
       or exists (select 1 from public.ride_offers o where o.driver_id = c.driver_id and o.outcome = 'pending')
       or not public._pref_ok(g.women_driver_pref, c.driver_id) then
      continue;
    end if;
    begin
      insert into public.ride_offers(group_id, driver_id, attempt_no, score, components, summary, expires_at)
      values (p_group, c.driver_id, g.attempt_no + 1, c.score,
        jsonb_build_object('chosen', to_jsonb(c), 'policy', s.dispatch_policy,
          'weights', jsonb_build_object('eta', s.w_eta, 'workload', s.w_workload, 'reliability', s.w_reliability, 'idle', s.w_idle,
                                        'zone', case when s.dispatch_policy = 'zone_aware' then s.w_zone else 0 end)),
        jsonb_build_object('pickup_km', c.pickup_km, 'pickup_min', c.pickup_min, 'stops', g.stops, 'is_pool', g.is_pool,
          'women_driver_pref', g.women_driver_pref,
          'fare', (select sum((r.fare->>'total')::numeric) from public.rides r join public.trip_group_members m on m.ride_id = r.id where m.group_id = p_group)),
        now() + make_interval(secs => case when quick then least(s.offer_timeout_s, s.quick_offer_s) else s.offer_timeout_s end))
      returning id into offer_id;
    exception when unique_violation then continue;
    end;
    update public.driver_profiles set offers_received = offers_received + 1 where user_id = c.driver_id;
    update public.trip_groups set status = 'offered', attempt_no = g.attempt_no + 1 where id = p_group;
    insert into public.dispatch_audit(group_id, offer_id, attempt_no, outcome, policy, ranking, eligibility, zone_snapshot)
    values (p_group, offer_id, g.attempt_no + 1, 'offered', s.dispatch_policy, ranking, public._eligibility(p_group),
      (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from public.zone_balance() b));
    -- riders can read their ride's events: no alternatives or eligibility in here (those live in dispatch_audit)
    perform public._event(p_group, 'offer_created', prev, 'offered',
      jsonb_build_object('offer_id', offer_id, 'driver_id', c.driver_id, 'driver', c.name, 'attempt', g.attempt_no + 1,
                         'score', c.score, 'policy', s.dispatch_policy, 'quick', quick, 'max_attempts', s.max_attempts,
                         'timeout_s', case when quick then least(s.offer_timeout_s, s.quick_offer_s) else s.offer_timeout_s end));
    perform public._sync(p_group);
    return offer_id;
  end loop;
  -- nobody eligible right now
  if coalesce(g.wait_until > now(), false) then
    -- the rider chose to keep waiting: stay "requested"; the sweep retries. Tell them at most every 30 s.
    if not exists (select 1 from public.ride_events e where e.group_id = p_group and e.type = 'still_searching' and e.at > now() - interval '30 seconds') then
      insert into public.dispatch_audit(group_id, attempt_no, outcome, policy, eligibility)
      values (p_group, g.attempt_no, 'waiting', s.dispatch_policy, public._eligibility(p_group));
      perform public._event(p_group, 'still_searching', prev, 'requested',
        jsonb_build_object('women_driver_pref', g.women_driver_pref, 'until', g.wait_until));
    end if;
    return null;
  end if;
  insert into public.dispatch_audit(group_id, attempt_no, outcome, policy, eligibility)
  values (p_group, g.attempt_no, 'no_eligible_captain', s.dispatch_policy, public._eligibility(p_group));
  update public.trip_groups set status = 'no_driver_found', wait_until = null where id = p_group;
  perform public._event(p_group, 'no_driver_found', prev, 'no_driver_found',
    jsonb_build_object('reason', 'no_eligible_driver', 'radius_m', g.search_radius_m, 'women_driver_pref', g.women_driver_pref));
  perform public._sync(p_group);
  return null;
end $function$;

-- ============ captain: ignore an offer (it goes to the next captain immediately) ============
create function public.ignore_offer(p_offer uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.ride_offers where id = p_offer and driver_id = auth.uid() and outcome = 'pending') then raise exception 'forbidden'; end if;
  perform public._fail_offer(p_offer, 'no_response', 'ignored');
end $$;

-- ============ rider: why was this captain chosen? ============
-- Only the ride's own rider; only the accepted offer's own score parts (no other captains, no eligibility list).
create function public.why_my_captain(p_ride uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.ride_offers; d public.driver_profiles; n int;
begin
  if not exists (select 1 from public.rides where id = p_ride and rider_id = auth.uid()) then raise exception 'forbidden'; end if;
  select ro.* into o from public.ride_offers ro join public.trip_group_members m on m.group_id = ro.group_id
   where m.ride_id = p_ride and ro.outcome = 'accepted' order by ro.offered_at desc limit 1;
  if o.id is null then return null; end if;
  select * into d from public.driver_profiles where user_id = o.driver_id;
  select coalesce(jsonb_array_length(a.ranking), 0) into n from public.dispatch_audit a where a.offer_id = o.id;
  return jsonb_build_object('score', o.score, 'chosen', o.components->'chosen' - 'driver_id', 'weights', o.components->'weights',
    'policy', o.components->>'policy', 'attempt', o.attempt_no, 'compared', n,
    'trips_today', d.trips_today, 'acceptance', round((d.offers_accepted + 4)::numeric / (d.offers_received + 5), 2),
    'vehicle_label', d.vehicle_label, 'simulated', d.is_simulated, 'safety', public.captain_safety_summary(o.driver_id));
end $$;

-- ============ maps: traffic / density level per zone ============
-- heavy = more expected riders than captains by 30% or a data-driven peak; moderate = roughly balanced; low = spare captains.
create function public.zone_traffic() returns table(zone_id smallint, name text, lat float8, lng float8, level text, ratio numeric)
language sql security definer set search_path = '' as $$
  select b.zone_id, b.name, b.lat, b.lng,
    case when b.peak or b.ratio >= 1.3 then 'heavy' when b.ratio >= 0.8 then 'moderate' else 'low' end, round(b.ratio, 2)
  from public.zone_balance() b
$$;

-- ============ shared rides ============
-- Pair two shared cab requests: best of the 4 valid stop orders (each rider is picked up before being dropped),
-- each rider's detour within settings.pool_max_detour_pct. Each pays 75% of their solo cab fare (the split).
create function public._pool_pair(p_a uuid, p_b uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.settings; a public.rides; b public.rides; pts jsonb; ord text; st jsonb; km numeric; best jsonb; best_km numeric := 1e9;
  k int; ia int; ja int; ib int; jb int; da numeric; db numeric; det jsonb; best_det jsonb; gid uuid; r uuid; old uuid;
begin
  select * into s from public.settings;
  select * into a from public.rides where id = p_a for update;
  select * into b from public.rides where id = p_b for update;
  if a.status not in ('requested', 'offered') or b.status not in ('requested', 'offered') then return null; end if;
  if public._km(a.pickup_lat, a.pickup_lng, b.pickup_lat, b.pickup_lng) > 1.5 * 1.35
     or public._km(a.drop_lat, a.drop_lng, b.drop_lat, b.drop_lng) > 2.5 * 1.35 then return null; end if;
  pts := jsonb_build_array(
    jsonb_build_object('type', 'pickup', 'ride_id', a.id, 'label', a.pickup_label, 'lat', a.pickup_lat, 'lng', a.pickup_lng),
    jsonb_build_object('type', 'pickup', 'ride_id', b.id, 'label', b.pickup_label, 'lat', b.pickup_lat, 'lng', b.pickup_lng),
    jsonb_build_object('type', 'drop', 'ride_id', a.id, 'label', a.drop_label, 'lat', a.drop_lat, 'lng', a.drop_lng),
    jsonb_build_object('type', 'drop', 'ride_id', b.id, 'label', b.drop_label, 'lat', b.drop_lat, 'lng', b.drop_lng));
  foreach ord in array array['0123', '0132', '1023', '1032'] loop
    select jsonb_agg(pts->(substr(ord, i, 1)::int) order by i) into st from generate_series(1, 4) i;
    km := 0;
    for k in 1..3 loop km := km + public._km((st->(k-1)->>'lat')::float8, (st->(k-1)->>'lng')::float8, (st->k->>'lat')::float8, (st->k->>'lng')::float8); end loop;
    ia := strpos(ord, '0') - 1; ja := strpos(ord, '2') - 1; ib := strpos(ord, '1') - 1; jb := strpos(ord, '3') - 1;
    da := 0; for k in ia + 1..ja loop da := da + public._km((st->(k-1)->>'lat')::float8, (st->(k-1)->>'lng')::float8, (st->k->>'lat')::float8, (st->k->>'lng')::float8); end loop;
    db := 0; for k in ib + 1..jb loop db := db + public._km((st->(k-1)->>'lat')::float8, (st->(k-1)->>'lng')::float8, (st->k->>'lat')::float8, (st->k->>'lng')::float8); end loop;
    det := jsonb_build_object(a.id::text, round(100 * (da / greatest(public._km(a.pickup_lat, a.pickup_lng, a.drop_lat, a.drop_lng), 0.1) - 1)),
                              b.id::text, round(100 * (db / greatest(public._km(b.pickup_lat, b.pickup_lng, b.drop_lat, b.drop_lng), 0.1) - 1)));
    if (det->>a.id::text)::numeric <= s.pool_max_detour_pct and (det->>b.id::text)::numeric <= s.pool_max_detour_pct and km < best_km then
      best := st; best_km := km; best_det := det;
    end if;
  end loop;
  if best is null then return null; end if;

  insert into public.trip_groups(category, stops, is_pool, women_driver_pref, shared_requested)
  values ('cab', best, true, a.women_driver_pref or b.women_driver_pref, true) returning id into gid;
  foreach r in array array[a.id, b.id] loop
    select group_id into old from public.trip_group_members where ride_id = r;
    update public.ride_offers set outcome = 'cancelled', responded_at = now() where group_id = old and outcome = 'pending';
    update public.trip_groups set status = 'cancelled' where id = old;
    perform public._event(old, 'merged_into_pool', null, 'cancelled', jsonb_build_object('pool_group', gid));
    update public.trip_group_members set group_id = gid,
      pickup_seq = (select (i - 1)::int from jsonb_array_elements(best) with ordinality e(v, i) where v->>'ride_id' = r::text and v->>'type' = 'pickup'),
      drop_seq = (select (i - 1)::int from jsonb_array_elements(best) with ordinality e(v, i) where v->>'ride_id' = r::text and v->>'type' = 'drop'),
      detour_min = coalesce((best_det->>r::text)::numeric, 0)
    where ride_id = r;
    update public.rides set status = 'requested', category = 'cab',
      fare = public._fare('cab', est_distance_km, est_trip_min, surge) || jsonb_build_object('pool_discount', 0.25, 'shared', true,
        'solo_total', (public._fare('cab', est_distance_km, est_trip_min, surge)->>'total')::numeric,
        'total', round((public._fare('cab', est_distance_km, est_trip_min, surge)->>'total')::numeric * 0.75))
    where id = r;
  end loop;
  perform public._event(gid, 'pool_created', null, 'requested', jsonb_build_object('rides', array[a.id, b.id], 'stops', best, 'shared', true));
  perform public._dispatch(gid);
  return gid;
end $$;

-- A passenger asks for a shared cab. If another rider's compatible shared request is still searching, both are merged
-- into one trip right away (fares split); otherwise it searches as a normal cab and a later shared request can join it
-- until a captain accepts.
create function public.request_shared_ride(p_pickup_label text, p_lat float8, p_lng float8, p_drop_label text, d_lat float8, d_lng float8,
  p_radius_m int default 2000, p_prefer_woman boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare res jsonb; mate uuid; gid uuid;
begin
  res := public.request_ride(p_pickup_label, p_lat, p_lng, p_drop_label, d_lat, d_lng, 'cab', p_radius_m, p_prefer_woman);
  update public.trip_groups set shared_requested = true where id = (res->>'group_id')::uuid;
  select m.ride_id into mate from public.trip_groups g join public.trip_group_members m on m.group_id = g.id join public.rides r on r.id = m.ride_id
   where g.shared_requested and not g.is_pool and g.status in ('requested', 'offered') and g.id <> (res->>'group_id')::uuid
     and r.rider_id <> auth.uid() and r.requested_at > now() - interval '15 minutes'
     and not exists (select 1 from public.trip_group_members x where x.group_id = g.id and x.ride_id <> m.ride_id)
   order by public._km(r.pickup_lat, r.pickup_lng, p_lat, p_lng) limit 1;
  if mate is not null then gid := public._pool_pair(mate, (res->>'ride_id')::uuid); end if;
  return res || jsonb_build_object('shared', true, 'paired', gid is not null, 'pool_group_id', gid);
end $$;

-- Fast-demo only: add a SIMULATED co-rider (another demo rider account) near this rider's pickup and drop, so one person
-- can see a shared ride pair up. The co-rider's request goes through the same request_shared_ride path.
create function public.demo_add_corider(p_ride uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.rides; co uuid; claims text; res jsonb;
begin
  if not (select fast_demo from public.settings) then raise exception 'forbidden: fast demo only'; end if;
  select * into r from public.rides where id = p_ride and rider_id = auth.uid();
  if r.id is null then raise exception 'forbidden'; end if;
  if r.status not in ('requested', 'offered') then raise exception 'validation: this ride is no longer searching'; end if;
  select u.id into co from auth.users u join public.profiles p on p.id = u.id
   where p.role = 'rider' and u.id <> auth.uid() and u.email like '%@demo.up'
     and not exists (select 1 from public.rides x where x.rider_id = u.id and x.status in ('requested', 'offered', 'accepted', 'arriving', 'ongoing', 'no_driver_found'))
   order by u.email limit 1;
  if co is null then raise exception 'validation: no free demo rider for a co-rider'; end if;
  claims := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claims', json_build_object('sub', co, 'role', 'authenticated')::text, true);
  res := public.request_shared_ride('Co-rider pickup (SIMULATED)', r.pickup_lat + 0.0025, r.pickup_lng + 0.0015,
    'Co-rider drop (SIMULATED)', r.drop_lat + 0.003, r.drop_lng - 0.002, 2000, false);
  perform set_config('request.jwt.claims', claims, true);
  return res;
exception when others then
  perform set_config('request.jwt.claims', claims, true);
  raise;
end $$;

-- ============ grants ============
revoke execute on function public._pool_pair(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.ignore_offer(uuid) from public, anon;
revoke execute on function public.why_my_captain(uuid) from public, anon;
revoke execute on function public.zone_traffic() from public, anon;
revoke execute on function public.request_shared_ride(text, float8, float8, text, float8, float8, int, boolean) from public, anon;
revoke execute on function public.demo_add_corider(uuid) from public, anon;
grant execute on function public.ignore_offer(uuid) to authenticated;
grant execute on function public.why_my_captain(uuid) to authenticated;
grant execute on function public.zone_traffic() to authenticated;
grant execute on function public.request_shared_ride(text, float8, float8, text, float8, float8, int, boolean) to authenticated;
grant execute on function public.demo_add_corider(uuid) to authenticated;
