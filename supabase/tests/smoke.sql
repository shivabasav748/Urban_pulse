-- Smoke test of the real RPC path. Run: pnpm db:smoke  (wraps everything in a rolled-back transaction)
\set ON_ERROR_STOP on
begin;
select id as rider from auth.users where email = 'rider@demo.up' \gset
select id as admin from auth.users where email = 'admin@demo.up' \gset

-- 1. rider requests Rani Channamma Circle -> Railway Station, Belagavi (cab); simulated drivers must not auto-accept during the test
update public.settings set fast_demo = false;
select set_config('request.jwt.claims', json_build_object('sub', :'rider', 'role', 'authenticated')::text, true);
set local role authenticated;
select (public.estimate_ride(15.86723, 74.51172, 15.84906, 74.50894)->'categories'->2->'fare'->>'total') as cab_fare_estimate;
select (public.request_ride('Rani Channamma Circle', 15.86723, 74.51172, 'Belagavi Railway Station', 15.84906, 74.50894, 'cab')) as req \gset
reset role;
select (:'req'::jsonb->>'group_id') as gid \gset
select driver_id as d1, attempt_no from public.ride_offers where group_id = :'gid' and outcome = 'pending' \gset
\echo first offer -> :d1 (attempt :attempt_no)

-- 2. integrity: same driver cannot hold a second pending offer
do $$ begin
  with g as (insert into public.trip_groups(category) values ('cab') returning id)
  insert into public.ride_offers(group_id, driver_id, attempt_no, score, components, summary, expires_at)
  select g.id, o.driver_id, 1, 0, '{}', '{}', now() from g, public.ride_offers o where o.outcome = 'pending' limit 1;
  raise exception 'FAIL: duplicate pending offer allowed';
exception when unique_violation then raise notice 'PASS: duplicate pending offer for one driver blocked';
end $$;

-- 3. driver 1 rejects -> automatic reassignment to a different driver, attempt 2
select set_config('request.jwt.claims', json_build_object('sub', :'d1', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.respond_offer((select id from public.ride_offers where group_id = :'gid' and outcome = 'pending'), false);
reset role;
select driver_id as d2, attempt_no from public.ride_offers where group_id = :'gid' and outcome = 'pending' \gset
select case when :'d1' <> :'d2' and :attempt_no = 2 then 'PASS: reassigned to new driver, attempt 2' else 'FAIL: reassignment' end as check_reassign;

-- 4. driver 2 accepts and completes the lifecycle
select set_config('request.jwt.claims', json_build_object('sub', :'d2', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.respond_offer((select id from public.ride_offers where group_id = :'gid' and outcome = 'pending'), true);
select public.advance_trip(:'gid', 'arriving');
select public.advance_trip(:'gid', 'ongoing');
select public.advance_trip(:'gid', 'completed');
reset role;
select case when status = 'completed' and driver_id = :'d2' then 'PASS: ride completed by driver 2' else 'FAIL: lifecycle ' || status end as check_lifecycle
from public.rides where id = (:'req'::jsonb->>'ride_id')::uuid;
select string_agg(type, ' > ' order by id) as event_log from public.ride_events where group_id = :'gid';

-- 5. illegal transition is refused
do $$ begin
  perform public._advance((select id from public.trip_groups order by created_at desc limit 1), 'arriving');
  raise exception 'FAIL: completed -> arriving allowed';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if; raise notice 'PASS: invalid transition refused (%)', sqlerrm;
end $$;

-- 6. rider cannot read someone else's data / call admin RPCs
select set_config('request.jwt.claims', json_build_object('sub', :'rider', 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ begin
  perform public.admin_metrics(); raise exception 'FAIL: rider called admin_metrics';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'PASS: rider blocked from admin RPC';
end $$;
reset role;

-- 7. judge views compute
select set_config('request.jwt.claims', json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);
set local role authenticated;
select z->>'name' as zone, z->>'forecast' as forecast, z->>'supply' as supply, z->>'raw' as surge_raw, z->>'smoothed' as surge_smoothed, z->>'risk' as risk
from jsonb_array_elements(public.zone_intelligence('base')->'zones') z;
select jsonb_array_length(public.zone_intelligence('base')->'moves') as repositioning_moves;
select public.admin_metrics()->>'completed' as completed_rides;
reset role;
rollback;
