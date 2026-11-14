-- 0016 (14 Nov 2026): fast-demo only. A real (non-simulated) captain can ask for a SIMULATED test ride request so the
-- accept / ignore / decline popup can be shown on demand. Without it the demo captain is rarely chosen: the fair-share
-- (workload) part of the score favours simulated captains with fewer trips. Forward-only; no schema changes.
--
-- The request is a normal request_ride from a free demo rider account, picked up ~300 m from the captain in the captain's
-- vehicle category. If the score offered it to someone else first, that offer is withdrawn (event says why) and the
-- request is offered to the calling captain instead. Everything is labelled demo in the offer and the event log.
create function public.demo_request_for_me() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.driver_profiles; rider uuid; claims text; res jsonb; gid uuid; g public.trip_groups; s public.settings; oid uuid; o record;
begin
  select * into s from public.settings;
  if not s.fast_demo then raise exception 'forbidden: fast demo only'; end if;
  select * into me from public.driver_profiles where user_id = auth.uid();
  if me.user_id is null or me.is_simulated then raise exception 'forbidden'; end if;
  if not me.online then raise exception 'validation: go online first'; end if;
  if exists (select 1 from public.trip_groups where driver_id = me.user_id and status in ('accepted', 'arriving', 'ongoing'))
     or exists (select 1 from public.ride_offers where driver_id = me.user_id and outcome = 'pending') then
    raise exception 'validation: finish your current request first';
  end if;
  select u.id into rider from auth.users u join public.profiles p on p.id = u.id
   where p.role = 'rider' and u.email like '%@demo.up'
     and not exists (select 1 from public.rides x where x.rider_id = u.id and x.status in ('requested', 'offered', 'accepted', 'arriving', 'ongoing', 'no_driver_found'))
   order by u.email desc limit 1;
  if rider is null then raise exception 'validation: no free demo rider right now'; end if;

  claims := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claims', json_build_object('sub', rider, 'role', 'authenticated')::text, true);
  res := public.request_ride('Test pickup (SIMULATED rider)', me.lat + 0.0027, me.lng, 'Test drop (SIMULATED rider)', me.lat - 0.012, me.lng + 0.008,
    me.vehicle_category, 2000, false);
  perform set_config('request.jwt.claims', claims, true);
  gid := (res->>'group_id')::uuid;

  select * into g from public.trip_groups where id = gid for update;
  for o in select id, driver_id from public.ride_offers where group_id = gid and outcome = 'pending' loop
    update public.ride_offers set outcome = 'cancelled', responded_at = now() where id = o.id;
    perform public._event(gid, 'offer_cancelled', g.status, 'requested', jsonb_build_object('offer_id', o.id, 'driver_id', o.driver_id, 'reason', 'demo_redirect'));
  end loop;
  insert into public.ride_offers(group_id, driver_id, attempt_no, score, components, summary, expires_at)
  values (gid, me.user_id, g.attempt_no + 1, 1, jsonb_build_object('demo', true, 'policy', 'demo_request_for_me'),
    jsonb_build_object('pickup_km', round(public._km(me.lat, me.lng, (g.stops->0->>'lat')::float8, (g.stops->0->>'lng')::float8)::numeric, 2),
      'pickup_min', public._minutes(public._km(me.lat, me.lng, (g.stops->0->>'lat')::float8, (g.stops->0->>'lng')::float8)::numeric * 1.35, me.vehicle_category),
      'stops', g.stops, 'is_pool', false, 'women_driver_pref', false, 'demo', true,
      'fare', (select sum((r.fare->>'total')::numeric) from public.rides r join public.trip_group_members m on m.ride_id = r.id where m.group_id = gid)),
    now() + make_interval(secs => s.offer_timeout_s))
  returning id into oid;
  update public.driver_profiles set offers_received = offers_received + 1 where user_id = me.user_id;
  update public.trip_groups set status = 'offered', attempt_no = g.attempt_no + 1 where id = gid;
  perform public._event(gid, 'offer_created', g.status, 'offered', jsonb_build_object('offer_id', oid, 'driver_id', me.user_id,
    'attempt', g.attempt_no + 1, 'demo', true, 'policy', 'demo_request_for_me'));
  perform public._sync(gid);
  return jsonb_build_object('offer_id', oid, 'ride_id', res->>'ride_id');
exception when others then
  perform set_config('request.jwt.claims', claims, true);
  raise;
end $$;
revoke execute on function public.demo_request_for_me() from public, anon;
grant execute on function public.demo_request_for_me() to authenticated;
