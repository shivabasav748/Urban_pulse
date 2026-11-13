-- Zonal dispatch, women-driver preference, reassignment and safety tests (migration 0007).
-- One transaction, rolled back at the end. Run: pnpm db:safety   (local stack only)
\set ON_ERROR_STOP on
begin;
select id as r1 from auth.users where email = 'rider@demo.up' \gset
select id as r2 from auth.users where email = 'rider2@demo.up' \gset
select id as r3 from auth.users where email = 'rider3@demo.up' \gset
select id as adm from auth.users where email = 'admin@demo.up' \gset
select id as cap from auth.users where email = 'captain1@demo.up' \gset
select user_id as s1 from public.driver_profiles where plate = 'KA-SIM-001' \gset
select user_id as s2 from public.driver_profiles where plate = 'KA-SIM-002' \gset
select user_id as s3 from public.driver_profiles where plate = 'KA-SIM-003' \gset

-- fixture: Rani Channamma Circle pickup; everyone offline; no rides; no auto-accept
update public.settings set fast_demo = false, dispatch_policy = 'zone_aware' where id;
delete from public.dispatch_audit where true; delete from public.reposition_moves where true;
delete from public.safety_report_audit where true; delete from public.safety_reports where true; delete from public.safety_feedback where true;
delete from public.ride_events where true; delete from public.ride_offers where true; delete from public.trip_group_members where true;
delete from public.trip_groups where true; delete from public.rides where true;
update public.driver_profiles set online = false, zone_changed_at = null where true;
-- s3 is this test's opted-in simulated captain (fixture; the seeded demo opt-ins can change)
insert into public.captain_preferences(user_id, women_riders_optin, consented_at, simulated, declaration) values (:'s3', true, now(), true, 'test-fixture')
  on conflict (user_id) do update set women_riders_optin = true;
create function pg_temp.at(d_m float8) returns table(lat float8, lng float8) language sql as $$
  select extensions.st_y(g::extensions.geometry), extensions.st_x(g::extensions.geometry)
  from (select extensions.st_project(extensions.st_setsrid(extensions.st_makepoint(74.51172, 15.86723), 4326)::extensions.geography, d_m, 0) g) x $$;
create function pg_temp.put(who uuid, d_m float8) returns void language sql as $$
  update public.driver_profiles d set lat = p.lat, lng = p.lng, online = true, idle_since = now(),
    location_source = case when d.is_simulated then 'simulated' else 'gps' end, location_accuracy_m = 10, location_updated_at = now()
  from pg_temp.at(d_m) p where d.user_id = who $$;
create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS: %', what; else raise exception 'FAIL: %', what; end if; end $$;
create function pg_temp.err(q text) returns text language plpgsql as $$
begin execute q; return null; exception when others then return sqlerrm; end $$;
create function pg_temp.status_of(ride uuid) returns text language sql as $$ select status from public.rides where id = ride $$;
create function pg_temp.offered_to(ride uuid) returns uuid language sql as $$
  select o.driver_id from public.ride_offers o join public.trip_group_members m on m.group_id = o.group_id
  where m.ride_id = ride and o.outcome = 'pending' $$;

-- ================= A. captain opt-in: self-managed, restricted =================
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check(pg_temp.err('select public.set_women_riders_optin(true)') = 'forbidden', 'a rider cannot set a captain opt-in');
select pg_temp.check((select count(*) from public.captain_preferences) = 0, 'a rider cannot read any captain eligibility flag');
select pg_temp.check(pg_temp.err(format('insert into public.captain_preferences(user_id, women_riders_optin) values (%L, true)', :'cap')) is not null,
  'direct writes to captain_preferences are refused');
select set_config('request.jwt.claims', json_build_object('sub', :'cap', 'role', 'authenticated')::text, true);
select public.set_women_riders_optin(true);
select pg_temp.check((select count(*) from public.captain_preferences) = 1
  and (select women_riders_optin from public.captain_preferences where user_id = :'cap'), 'a captain opts in and sees only their own row');
select pg_temp.check(pg_temp.err(format('update public.captain_preferences set women_riders_optin = false where user_id = %L', :'s3')) is not null,
  'a captain cannot change another captain''s opt-in');
select public.set_women_riders_optin(false);
reset role;
select pg_temp.check((select array_agg(action order by id) from public.captain_preference_audit where user_id = :'cap' and at >= now()) = array['opt_in', 'withdraw'],
  'opt-in and withdrawal are both audited');

-- ================= B. preference is an eligibility constraint, never a ranking bonus =================
-- s1 (not opted in) is closest; s3 (simulated demo opt-in) is further away; cap (withdrawn) in between
select pg_temp.put(:'s1', 300); select pg_temp.put(:'cap', 500); select pg_temp.put(:'s3', 900);
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select (public.request_ride('Rani Channamma Circle', 15.86723, 74.51172, 'Railway Station', 15.84906, 74.50894, 'cab', 2000, true))->>'ride_id' as ride1 \gset
reset role;
select pg_temp.check(pg_temp.offered_to(:'ride1') = :'s3', 'preference request goes to the opted-in captain, not the nearest one');
select pg_temp.check((select bool_and(public._pref_ok(true, a.driver_id)) from public._rank((select group_id from public.trip_group_members where ride_id = :'ride1')) a)
  is not false, 'every candidate ranked for a preference request is opted in');

-- the only opted-in cab is now busy: a second preference request finds nobody and is NOT given to anyone else
select set_config('request.jwt.claims', json_build_object('sub', :'r2', 'role', 'authenticated')::text, true);
set local role authenticated;
select (public.request_ride('Rani Channamma Circle', 15.86723, 74.51172, 'Railway Station', 15.84906, 74.50894, 'cab', 2000, true))->>'ride_id' as ride2 \gset
select pg_temp.check(pg_temp.status_of(:'ride2') = 'no_driver_found', 'no eligible woman captain: the ride is not silently given to an ineligible captain');
select pg_temp.check((select (payload->>'women_driver_pref')::boolean from public.ride_events where ride_id = :'ride2' and type = 'no_driver_found'),
  'the rider''s no-captain event says the preference was kept');
select pg_temp.check((select count(*) from public.dispatch_audit) = 0, 'riders cannot read the dispatch audit (rankings, eligibility reasons)');
select public.retry_ride(:'ride2', false);
select pg_temp.check(pg_temp.status_of(:'ride2') = 'requested' and (select women_driver_pref from public.rides where id = :'ride2'),
  'rider chooses "keep waiting": still searching, preference kept');
select public.retry_ride(:'ride2', true);
select pg_temp.check(pg_temp.status_of(:'ride2') = 'offered' and not (select women_driver_pref from public.rides where id = :'ride2'),
  'rider explicitly removes the preference: offered to any eligible captain');
reset role;

-- ================= C. withdrawing the opt-in while holding a preference offer =================
select set_config('request.jwt.claims', json_build_object('sub', :'cap', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.set_women_riders_optin(true);
reset role;
update public.driver_profiles set online = false where user_id in (:'s1', :'s2');
select set_config('request.jwt.claims', json_build_object('sub', :'r3', 'role', 'authenticated')::text, true);
set local role authenticated;
select (public.request_ride('Rani Channamma Circle', 15.86723, 74.51172, 'Railway Station', 15.84906, 74.50894, 'cab', 2000, true))->>'ride_id' as ride3 \gset
reset role;
select pg_temp.check(pg_temp.offered_to(:'ride3') = :'cap', 'opted-in real captain receives the preference request');
select set_config('request.jwt.claims', json_build_object('sub', :'cap', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check((select (public.set_women_riders_optin(false))->>'released_offers')::int = 1, 'withdrawing releases the pending preference offer');
reset role;
select pg_temp.check(pg_temp.offered_to(:'ride3') is distinct from :'cap'
  and exists (select 1 from public.ride_events where ride_id = :'ride3' and type = 'offer_cancelled' and payload->>'reason' = 'captain_withdrew_preference'),
  'the withdrawn captain no longer holds the ride and the reason is logged');

-- ================= D. captain goes offline while an offer is pending -> next captain =================
select set_config('request.jwt.claims', json_build_object('sub', :'r3', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check(pg_temp.status_of(:'ride3') = 'no_driver_found', 'with no other opted-in cab, the preference ride waits for the rider''s choice');
select (public.request_ride('Rani Channamma Circle', 15.86723, 74.51172, 'Railway Station', 15.84906, 74.50894, 'cab', 2000, false))->>'ride_id' as ride4 \gset
reset role;
select pg_temp.check(pg_temp.offered_to(:'ride4') = :'cap', 'normal request offered to the only free cab (captain1)');
select pg_temp.put(:'s2', 1000);
select set_config('request.jwt.claims', json_build_object('sub', :'cap', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.set_online(false);
reset role;
select pg_temp.check(pg_temp.offered_to(:'ride4') = :'s2'
  and exists (select 1 from public.ride_events where ride_id = :'ride4' and type = 'offer_no_response' and payload->>'reason' = 'captain_went_offline'),
  'going offline hands the pending offer to the next captain, exactly one pending offer');
select pg_temp.check((select count(*) from public.ride_offers o join public.trip_group_members m on m.group_id = o.group_id
  where m.ride_id = :'ride4' and o.outcome = 'pending') = 1, 'still exactly one pending offer for the ride');

-- ================= E. safety feedback =================
select public._accept_offer((select id from public.ride_offers o join public.trip_group_members m on m.group_id = o.group_id
  where m.ride_id = :'ride1' and o.outcome = 'pending'));
select public._advance((select group_id from public.trip_group_members where ride_id = :'ride1'), 'arriving');
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check(pg_temp.err(format('select public.submit_safety_feedback(%L, 5)', :'ride1')) like 'invalid_transition%', 'feedback refused before the trip is completed');
reset role;
select public._advance((select group_id from public.trip_group_members where ride_id = :'ride1'), 'ongoing');
select public._advance((select group_id from public.trip_group_members where ride_id = :'ride1'), 'completed');
select set_config('request.jwt.claims', json_build_object('sub', :'r2', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check(pg_temp.err(format('select public.submit_safety_feedback(%L, 5)', :'ride1')) = 'forbidden', 'a rider cannot give feedback on someone else''s ride');
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
select pg_temp.check(pg_temp.err(format('select public.submit_safety_feedback(%L, 9)', :'ride1')) like 'validation%', 'ratings outside 1 to 5 are refused');
select public.submit_safety_feedback(:'ride1', 5, 4, 5, 5, 'Calm driving');
select pg_temp.check(pg_temp.err(format('select public.submit_safety_feedback(%L, 1)', :'ride1')) like 'conflict%', 'duplicate safety feedback is refused');
select pg_temp.check(pg_temp.err(format('insert into public.safety_feedback(ride_id, rider_id, driver_id, overall) values (%L, %L, %L, 1)', :'ride1', :'r1', :'s3')) is not null,
  'feedback cannot be written directly, only through the checked RPC');
select pg_temp.check(pg_temp.err(format('select public.captain_safety_summary(%L)', :'s3')) = 'forbidden', 'after the trip, the rider cannot query that captain''s safety summary');
select set_config('request.jwt.claims', json_build_object('sub', :'cap', 'role', 'authenticated')::text, true);
select pg_temp.check((select count(*) from public.safety_feedback) = 0, 'captains cannot read individual feedback rows (or who left them)');
select pg_temp.check(pg_temp.err('update public.safety_feedback set overall = 1 where true') is not null, 'captains cannot modify feedback');
select set_config('request.jwt.claims', json_build_object('sub', :'adm', 'role', 'authenticated')::text, true);
select pg_temp.check(((public.captain_safety_summary(:'s3'))->>'published')::boolean = false
  and (public.captain_safety_summary(:'s3'))->>'overall' is null, '1 feedback entry: no aggregate score is published');
reset role;
with rr as (
  insert into public.rides(rider_id, driver_id, pickup_label, drop_label, pickup_lat, pickup_lng, drop_lat, drop_lng, category, status,
    est_distance_km, est_trip_min, fare)
  select :'r2', :'s3', 'fixture', 'fixture', 15.86, 74.51, 15.85, 74.50, 'cab', 'completed', 2, 6, '{"total": 50}' from generate_series(1, 4)
  returning id)
insert into public.safety_feedback(ride_id, rider_id, driver_id, overall, driving, vehicle, conduct) select id, :'r2', :'s3', 4, 4, 4, 4 from rr;
select set_config('request.jwt.claims', json_build_object('sub', :'adm', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check(((public.captain_safety_summary(:'s3'))->>'published')::boolean and ((public.captain_safety_summary(:'s3'))->>'overall')::numeric = 4.2,
  '5 entries (threshold): aggregate published, mean 4.2');
reset role;

-- ================= F. safety reports =================
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.submit_safety_report(:'ride1', 'unsafe_driving', 'Speeding near the railway station') as rep1 \gset
select pg_temp.check(pg_temp.err(format('select public.submit_safety_report(%L, %L, %L)', :'ride1', 'other', 'Second report on same trip')) like 'conflict%',
  'one report per trip per rider');
select pg_temp.check((select count(*) from public.safety_reports) = 1, 'the reporter can see their own report');
select pg_temp.check(pg_temp.err(format('select public.review_safety_report(%L, %L)', :'rep1', 'resolved')) = 'forbidden', 'riders cannot review reports');
select set_config('request.jwt.claims', json_build_object('sub', :'r2', 'role', 'authenticated')::text, true);
select pg_temp.check((select count(*) from public.safety_reports) = 0, 'another rider cannot see the report');
select set_config('request.jwt.claims', json_build_object('sub', :'cap', 'role', 'authenticated')::text, true);
select pg_temp.check((select count(*) from public.safety_reports) = 0 and (select count(*) from public.safety_report_audit) = 0,
  'captains cannot see reports or reporter identity');
select set_config('request.jwt.claims', json_build_object('sub', :'adm', 'role', 'authenticated')::text, true);
select public.review_safety_report(:'rep1', 'under_review', 'Checking trip log');
select pg_temp.check((select count(*) from public.safety_report_audit where report_id = :'rep1') = 2
  and (select status from public.safety_reports where id = :'rep1') = 'under_review', 'admin review is recorded in the audit trail');
select pg_temp.check((select online from public.driver_profiles where user_id = :'s3'), 'an unreviewed report does not suspend or take the captain offline');
select pg_temp.check((select count(*) from public.dispatch_audit) > 0, 'the judge can read the dispatch audit');
reset role;

-- ================= G. zone switching: operational only after observed arrival =================
update public.driver_profiles set online = false where user_id <> :'cap';
select pg_temp.put(:'cap', 500);
select public._zone_of(lat, lng) as cap_zone from public.driver_profiles where user_id = :'cap' \gset
select zone_id as tgt from public.zone_balance() where zone_id <> :'cap_zone' and state <> 'oversupplied' order by public._km(lat, lng, 15.86723, 74.51172) limit 1 \gset
select set_config('request.jwt.claims', json_build_object('sub', :'cap', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check((select jsonb_array_length(public.captain_zone_view()->'zones')) = 8, 'captain sees all eight zones with balance and distance');
select pg_temp.check(pg_temp.err(format('select public.captain_request_zone(%s::smallint)', :'cap_zone')) like 'validation%', 'cannot request the zone you are already in');
select public.captain_request_zone(:'tgt'::smallint) as mv \gset
select pg_temp.check((select status from public.reposition_moves where id = :'mv') = 'accepted'
  and (select op_zone from public.driver_profiles where user_id = :'cap') is distinct from :'tgt'::smallint, 'requested move is en route; operational zone not changed yet');
-- teleport: manual pin dropped straight into the target zone
select public.update_location((select lat from public.zones where id = :'tgt'), (select lng from public.zones where id = :'tgt'), null, 'manual');
reset role;
select public._reposition_tick(true);
select pg_temp.check((select status from public.reposition_moves where id = :'mv') = 'accepted', 'an instant jump into the zone does not count as arrival (anti-teleport)');
update public.reposition_moves set responded_at = now() - interval '1 hour' where id = :'mv';
select public._reposition_tick(true);
select pg_temp.check((select status from public.reposition_moves where id = :'mv') = 'arrived'
  and (select op_zone from public.driver_profiles where user_id = :'cap') = :'tgt'::smallint, 'plausible arrival makes the zone operational');
select set_config('request.jwt.claims', json_build_object('sub', :'cap', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check(pg_temp.err(format('select public.captain_request_zone(%s::smallint)', :'cap_zone')) like 'conflict%recently%', 'cooldown blocks an immediate switch back');
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
select pg_temp.check(pg_temp.err('select public.captain_request_zone(1::smallint)') = 'forbidden', 'riders cannot request zone moves');
select pg_temp.check((select count(*) from public.reposition_moves) = 0, 'riders cannot see repositioning moves');
reset role;

-- ================= H. proactive repositioning: hysteresis, caps, eligibility =================
delete from public.reposition_moves where true;
update public.driver_profiles set zone_changed_at = null where true;
-- oversupply KSCA Stadium (zone 7) with idle simulated captains; everyone else offline
update public.driver_profiles set online = false where true;
update public.driver_profiles d set online = true, lat = 15.88564 + (n.k - 3) * 0.002, lng = 74.54633, location_source = 'simulated'
from (select user_id, row_number() over (order by plate) k from public.driver_profiles where is_simulated order by plate limit 6) n where n.user_id = d.user_id;
update public.driver_profiles set zone_changed_at = now() where user_id = (select user_id from public.driver_profiles where is_simulated order by plate limit 1);
select public._reposition_tick(true);
select pg_temp.check((select count(*) from public.reposition_moves) > 0, 'a short zone with a nearby surplus zone gets recommended moves');
select pg_temp.check(not exists (select 1 from public.reposition_moves m join public.zone_balance() b on b.zone_id = m.to_zone
  where m.status = 'recommended' and b.state <> 'undersupplied'), 'no recommendation targets a zone that is not short');
select pg_temp.check(not exists (select 1 from public.reposition_moves m join public.zone_balance() b on b.zone_id = m.to_zone
  group by m.to_zone, b.shortage having count(*) > floor(b.shortage) + 0), 'moves into a zone never exceed its shortage (no herding)');
select pg_temp.check(not exists (select 1 from public.reposition_moves m where m.driver_id = (select user_id from public.driver_profiles where is_simulated order by plate limit 1)),
  'a captain in cooldown is not recommended');
select pg_temp.check((select count(*) from public.driver_profiles where online and public._zone_of(lat, lng) = 7)
  - (select count(*) from public.reposition_moves where from_zone = 7) >= 1, 'the donor zone keeps at least one spare captain (hysteresis)');
select count(*) as n1 from public.reposition_moves \gset
select public._reposition_tick(true);
select pg_temp.check((select count(*) from public.reposition_moves where status in ('recommended', 'accepted')) = :n1, 'a second pass does not duplicate open recommendations');

-- ================= H2. fast demo: SIMULATED captains accept and drive step by step (no teleport) =================
update public.settings set fast_demo = true where id;
update public.reposition_moves set created_at = now() - interval '10 seconds' where status = 'recommended';
select m.driver_id as simd, public._km(dp.lat, dp.lng, z.lat, z.lng) as d0 from public.reposition_moves m
  join public.driver_profiles dp on dp.user_id = m.driver_id join public.zones z on z.id = m.to_zone where m.simulated limit 1 \gset
select pg_temp.check((public._reposition_tick(true)->>'sim_steps')::int > 0, 'fast demo: simulated captains accept their suggestion and take a driving step');
select pg_temp.check((select public._km(dp.lat, dp.lng, z.lat, z.lng) from public.reposition_moves m join public.driver_profiles dp on dp.user_id = m.driver_id
  join public.zones z on z.id = m.to_zone where m.driver_id = :'simd' and m.status in ('accepted', 'arrived')) between 0 and :d0 - 0.1,
  'the simulated captain moved closer, by a bounded step rather than a jump');
update public.settings set fast_demo = false where id;

-- ================= H3. move cap: no recommendation needs more than reposition_max_move_min to reach =================
select pg_temp.check(not exists (select 1 from public.reposition_moves m join public.driver_profiles dp on dp.user_id = m.driver_id
  where m.source = 'system' and m.created_at >= now() and m.eta_min > (select reposition_max_move_min from public.settings)),
  'no system move takes longer than the move cap (forecast still valid on arrival)');

-- ================= J0. fare integrity: the stored fare can only come from the server =================
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check(pg_temp.err(format($q$update public.rides set fare = jsonb_set(fare, '{total}', '1') where id = %L$q$, :'ride1')) is not null,
  'a rider cannot edit the stored fare of their ride');
select pg_temp.check(pg_temp.err(format($q$insert into public.rides(rider_id, pickup_label, drop_label, pickup_lat, pickup_lng, drop_lat, drop_lng, category,
  est_distance_km, est_trip_min, fare) values (%L, 'x', 'y', 15.86, 74.51, 15.85, 74.5, 'cab', 2, 5, '{"total": 1}')$q$, :'r1')) is not null,
  'a rider cannot create a ride with a self-chosen fare (only request_ride, which computes it)');
reset role;

-- ================= J. fare model v2 (0009) =================
update public.settings set surge_enabled = false, sim_clock = '2026-11-12 18:00+05:30' where id;
select pg_temp.check((public._fare('cab', 2.8, 30, 1.6)->>'total')::int = 105, 'cab 2.8 km = Rs 100 minimum + 5% GST; surge ignored while off');
select pg_temp.check(public._fare('cab', 10, 5, 1) = public._fare('cab', 10, 90, 1), 'trip minutes never change the fare (no per-minute charge)');
select pg_temp.check((public._fare('cab', 10, 0, 1)->>'total')::int = 256, 'cab 10 km = 100 + 24 x 6 = 244, + 5% GST = 256');
update public.settings set sim_clock = '2026-11-12 02:00+05:30' where id;
select pg_temp.check((public._fare('cab', 4, 0, 1)->>'night')::int = 10 and (public._fare('auto', 4, 0, 1)->>'night')::int = 0, 'night charge 10% on cabs only, 00:00-06:00');
update public.settings set surge_enabled = true, sim_clock = '2026-11-12 18:00+05:30' where id;
select pg_temp.check((public._fare('cab', 10, 0, 3.5)->>'surge_mult')::numeric = 2, 'when surge is on it is capped at 2x');
update public.settings set surge_enabled = false where id;
select pg_temp.check(public._fare('bike', 3, 0, 1)->>'tariff' = 'illustrative-simulated-service'
  and public._fare('auto', 3, 0, 1)->>'tariff' = 'illustrative-not-notified', 'bike and auto fares are labelled illustrative');
-- shortlist: at most 8 candidates are ever scored
update public.driver_profiles set online = true, location_source = 'simulated' where vehicle_category = 'cab' and is_simulated;
update public.driver_profiles d set lat = 15.86723 + n.k * 0.0005, lng = 74.51172 from (select user_id, row_number() over (order by plate) k from public.driver_profiles where vehicle_category = 'cab') n where n.user_id = d.user_id;
select pg_temp.put(:'cap', 50);
create function pg_temp.ranked_count() returns int language plpgsql volatile as $$
declare gid uuid;
begin
  insert into public.trip_groups(category, search_radius_m, stops) values ('cab', 5000,
    '[{"type":"pickup","label":"P","lat":15.86723,"lng":74.51172},{"type":"drop","label":"D","lat":15.84906,"lng":74.50894}]') returning id into gid;
  raise notice 'shortlist fixture: eligible %, scored %', coalesce((public._eligibility(gid)->'counts'->>'eligible')::int, 0), (select count(*) from public._rank(gid));
  return (select count(*) from public._rank(gid)) - least(8, coalesce((public._eligibility(gid)->'counts'->>'eligible')::int, 0));
end $$;
update public.ride_offers set outcome = 'cancelled' where outcome = 'pending';   -- free every cab for this check
update public.trip_groups set status = 'cancelled' where status in ('accepted', 'arriving', 'ongoing', 'offered', 'requested');
select pg_temp.check(pg_temp.ranked_count() = 0, 'scored candidates = min(8, eligible): the 8 nearest when more are eligible (shortlist)');

-- ================= I. accept after a committed withdrawal is refused (race backstop) =================
update public.driver_profiles set online = false where true;
select pg_temp.put(:'cap', 300);
insert into public.captain_preferences(user_id, women_riders_optin) values (:'cap', true)
  on conflict (user_id) do update set women_riders_optin = true;
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select (public.request_ride('Rani Channamma Circle', 15.86723, 74.51172, 'Railway Station', 15.84906, 74.50894, 'cab', 2000, true))->>'ride_id' as ride5 \gset
reset role;
select o.id as off5 from public.ride_offers o join public.trip_group_members m on m.group_id = o.group_id where m.ride_id = :'ride5' and o.outcome = 'pending' \gset
update public.captain_preferences set women_riders_optin = false where user_id = :'cap';
select public._accept_offer(:'off5');
select pg_temp.check((select outcome from public.ride_offers where id = :'off5') = 'cancelled'
  and pg_temp.status_of(:'ride5') <> 'accepted', 'accepting a preference offer after the opt-in was withdrawn is refused and reassigned');


-- ================= K. booking reliability (migration 0011) =================
create function pg_temp.clear() returns void language sql as $$
  update public.ride_offers set outcome = 'cancelled' where outcome = 'pending';
  update public.trip_groups set status = 'cancelled' where status not in ('completed', 'cancelled');
  update public.rides set status = 'cancelled' where status not in ('completed', 'cancelled');
  update public.driver_profiles set online = false where true; $$;
create function pg_temp.cat_of(who uuid) returns text language sql as $$ select vehicle_category from public.driver_profiles where user_id = who $$;
create function pg_temp.group_of(ride uuid) returns uuid language sql as $$ select group_id from public.trip_group_members where ride_id = ride $$;
select user_id as a1 from public.driver_profiles where plate = 'KA-SIM-013' \gset
select user_id as b1 from public.driver_profiles where plate = 'KA-SIM-009' \gset
update public.settings set fast_demo = false, dispatch_policy = 'urban_pulse' where id;

-- K1. the selected category is authoritative: a cab request with only an auto nearby is never given to the auto
select pg_temp.clear(); select pg_temp.put(:'a1', 300);
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select (public.request_ride('Rani Channamma Circle', 15.86723, 74.51172, 'Railway Station', 15.84906, 74.50894, 'cab', 2000, false))->>'ride_id' as k1 \gset
reset role;
select pg_temp.check(pg_temp.status_of(:'k1') = 'no_driver_found' and (select category from public.rides where id = :'k1') = 'cab'
  and not exists (select 1 from public.ride_offers where group_id = pg_temp.group_of(:'k1')),
  'cab requested, only an auto nearby: no_driver_found, no offer to the auto, category stays cab');
select pg_temp.clear();
select pg_temp.check(pg_temp.err($q$select public.request_ride('X', 15.86723, 74.51172, 'Y', 15.84906, 74.50894, 'truck', 2000, false)$q$) is not null,
  'an unknown vehicle category is refused by the backend');

-- K2. long trips (RCC -> VTU, RCC -> Sambra Airport): eligibility uses pickup distance only, category kept
select pg_temp.clear(); select pg_temp.put(:'s1', 400); select pg_temp.put(:'a1', 400); select pg_temp.put(:'b1', 400);
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select (public.request_ride('RCC', 15.86723, 74.51172, 'VTU', 15.7773, 74.46486, 'cab', 2000, false))->>'ride_id' as kc \gset
select set_config('request.jwt.claims', json_build_object('sub', :'r2', 'role', 'authenticated')::text, true);
select (public.request_ride('RCC', 15.86723, 74.51172, 'Sambra Airport', 15.86308, 74.61119, 'auto', 2000, false))->>'ride_id' as ka \gset
select set_config('request.jwt.claims', json_build_object('sub', :'r3', 'role', 'authenticated')::text, true);
select (public.request_ride('RCC', 15.86723, 74.51172, 'VTU', 15.7773, 74.46486, 'bike', 2000, false))->>'ride_id' as kb \gset
reset role;
select pg_temp.check(pg_temp.cat_of(pg_temp.offered_to(:'kc')) = 'cab' and pg_temp.cat_of(pg_temp.offered_to(:'ka')) = 'auto'
  and pg_temp.cat_of(pg_temp.offered_to(:'kb')) = 'bike', 'long trips (VTU, airport) are offered to a captain of the requested category: cab, auto, bike');
select pg_temp.check((select est_distance_km from public.rides where id = :'kc') > 10
  and (select est_pickup_min from public.rides where id = :'kc') < 5, 'trip distance (>10 km) is separate from pickup ETA (captain 400 m away)');

-- K3. wider search after no_driver_found: 2 -> 3 km, only grows, category preserved, rejected captain never re-offered
select pg_temp.clear(); select pg_temp.put(:'s2', 500); select pg_temp.put(:'s3', 2500);
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select (public.request_ride('Rani Channamma Circle', 15.86723, 74.51172, 'Railway Station', 15.84906, 74.50894, 'cab', 2000, false))->>'ride_id' as k3 \gset
reset role;
select pg_temp.check(pg_temp.offered_to(:'k3') = :'s2', 'first offer goes to the cab inside 2 km');
select set_config('request.jwt.claims', json_build_object('sub', :'s2', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.respond_offer((select id from public.ride_offers where outcome = 'pending' and driver_id = :'s2'), false);
reset role;
select pg_temp.check(pg_temp.status_of(:'k3') = 'no_driver_found', 'after the only 2 km cab rejects: no_driver_found (the 2.5 km cab is outside the area)');
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check(pg_temp.err(format('select public.retry_ride(%L, false, 4000)', :'k3')) like '%radius must be%', 'retry radius must be 2, 3 or 5 km');
select public.retry_ride(:'k3', false, 3000);
reset role;
select pg_temp.check((select search_radius_m from public.trip_groups where id = pg_temp.group_of(:'k3')) = 3000
  and pg_temp.offered_to(:'k3') = :'s3' and (select category from public.rides where id = :'k3') = 'cab',
  'wider retry (3 km) offers the 2.5 km cab and keeps the category');
select pg_temp.check((select count(*) from public.ride_offers where group_id = pg_temp.group_of(:'k3') and driver_id = :'s2') = 1,
  'the captain who rejected is never re-offered the same ride');
update public.trip_groups set status = 'no_driver_found' where id = pg_temp.group_of(:'k3');
update public.rides set status = 'no_driver_found' where id = :'k3';
set local role authenticated;
select pg_temp.check(pg_temp.err(format('select public.retry_ride(%L, false, 2000)', :'k3')) like '%only grow%', 'the search area never shrinks');
reset role;

-- K4. demo auto-accept uses the same path, only for simulated captains, and is labelled in the audit trail
select pg_temp.clear(); select pg_temp.put(:'s1', 300);
update public.settings set fast_demo = true, auto_accept_s = 2 where id;
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select (public.request_ride('Rani Channamma Circle', 15.86723, 74.51172, 'Railway Station', 15.84906, 74.50894, 'cab', 2000, false))->>'ride_id' as k4 \gset
reset role;
update public.ride_offers set offered_at = now() - interval '1 minute' where outcome = 'pending';
select set_config('t.k4', :'k4', true);
do $$ begin for i in 1..50 loop perform public.sweep_exceptions(); exit when pg_temp.status_of(current_setting('t.k4')::uuid) = 'accepted'; perform pg_sleep(0.1); end loop; end $$;  -- a live app's sweep may hold the lock
select pg_temp.check(pg_temp.status_of(:'k4') = 'accepted' and (select payload->>'acceptance' from public.ride_events where ride_id = :'k4' and type = 'offer_accepted') = 'simulated_auto_accept',
  'a simulated captain is auto-accepted via _accept_offer and the event says simulated_auto_accept');
select pg_temp.clear(); select pg_temp.put(:'cap', 300);
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select (public.request_ride('Rani Channamma Circle', 15.86723, 74.51172, 'Railway Station', 15.84906, 74.50894, 'cab', 2000, false))->>'ride_id' as k5 \gset
reset role;
update public.ride_offers set offered_at = now() - interval '1 minute' where outcome = 'pending';
do $$ begin for i in 1..50 loop exit when not coalesce((public.sweep_exceptions()->>'skipped')::boolean, false); perform pg_sleep(0.1); end loop; end $$;  -- a live app's sweep may hold the lock
select pg_temp.check(pg_temp.status_of(:'k5') = 'offered', 'a real captain is never auto-accepted');
select set_config('request.jwt.claims', json_build_object('sub', :'cap', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.respond_offer((select id from public.ride_offers where outcome = 'pending' and driver_id = :'cap'), true);
reset role;
select pg_temp.check(pg_temp.status_of(:'k5') = 'accepted' and (select payload->>'acceptance' from public.ride_events where ride_id = :'k5' and type = 'offer_accepted') = 'captain'
  and (select count(*) from public.ride_offers where group_id = pg_temp.group_of(:'k5') and outcome = 'accepted') = 1,
  'a real captain''s acceptance is recorded as captain, with exactly one accepted offer');


-- ================= L. shared rides, ignore, captain cancel, why-this-captain, traffic (migration 0014) =================
update public.settings set fast_demo = false where id;
select user_id as w_cab from public.driver_profiles where plate = 'KA-SIM-004' \gset
select user_id as w_bike from public.driver_profiles where plate = 'KA-SIM-010' \gset

-- L1. women-driver preference: a seeded woman captain is matched, a nearer captain who is not opted in is skipped
select pg_temp.clear(); select pg_temp.put(:'s1', 200); select pg_temp.put(:'w_cab', 900);
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select (public.request_ride('RCC', 15.86723, 74.51172, 'Station', 15.84906, 74.50894, 'cab', 2000, true))->>'ride_id' as l1 \gset
reset role;
select pg_temp.check(pg_temp.offered_to(:'l1') = :'w_cab', 'woman driver requested: the opted-in woman captain gets it, not the nearer captain');

-- L2. captain ignores: the next captain is offered immediately; captain cancels after accepting: search restarts at once
select pg_temp.clear(); select pg_temp.put(:'s1', 300); select pg_temp.put(:'s2', 600); select pg_temp.put(:'s3', 900);
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select (public.request_ride('RCC', 15.86723, 74.51172, 'Station', 15.84906, 74.50894, 'cab', 2000, false))->>'ride_id' as l2 \gset
reset role;
select pg_temp.offered_to(:'l2') as first_cap \gset
select set_config('request.jwt.claims', json_build_object('sub', :'first_cap', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.ignore_offer((select id from public.ride_offers where outcome = 'pending' and driver_id = :'first_cap'));
reset role;
select pg_temp.offered_to(:'l2') as second_cap \gset
select pg_temp.check(:'second_cap'::uuid <> :'first_cap'::uuid and (select outcome from public.ride_offers where group_id = pg_temp.group_of(:'l2') and driver_id = :'first_cap') = 'no_response',
  'ignore: recorded as no response and the next captain is offered straight away');
select set_config('request.jwt.claims', json_build_object('sub', :'second_cap', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.respond_offer((select id from public.ride_offers where outcome = 'pending' and driver_id = :'second_cap'), true);
select public.driver_cancel(pg_temp.group_of(:'l2'));
reset role;
select pg_temp.check(pg_temp.status_of(:'l2') = 'offered' and pg_temp.offered_to(:'l2') not in (:'first_cap', :'second_cap'),
  'captain cancels after accepting: the ride is offered to a new captain immediately');

-- L3. why this captain: the rider sees the accepted captain's own score parts; nobody else can
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.offered_to(:'l2'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.respond_offer((select id from public.ride_offers where outcome = 'pending' and driver_id = auth.uid()), true);
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
select pg_temp.check((public.why_my_captain(:'l2')->'chosen'->>'pickup_km')::numeric > 0
  and public.why_my_captain(:'l2')->'chosen'->>'driver_id' is null, 'the rider gets the score breakdown (no captain ids)');
select set_config('request.jwt.claims', json_build_object('sub', :'r2', 'role', 'authenticated')::text, true);
select pg_temp.check(pg_temp.err(format('select public.why_my_captain(%L)', :'l2')) = 'forbidden', 'another rider cannot see why that captain was chosen');
reset role;

-- L4. shared rides: two compatible shared requests pair into one trip and each fare is 75% of solo
select pg_temp.clear(); select pg_temp.put(:'s1', 300);
select set_config('request.jwt.claims', json_build_object('sub', :'r2', 'role', 'authenticated')::text, true);
set local role authenticated;
select (public.request_shared_ride('RCC', 15.86723, 74.51172, 'Station', 15.84906, 74.50894, 2000, false))->>'ride_id' as sa \gset
select set_config('request.jwt.claims', json_build_object('sub', :'r3', 'role', 'authenticated')::text, true);
select public.request_shared_ride('Near RCC', 15.8690, 74.5125, 'Near Station', 15.8510, 74.5080, 2000, false) as sres \gset
reset role;
select pg_temp.check((:'sres'::jsonb->>'paired')::boolean and pg_temp.group_of(:'sa') = pg_temp.group_of((:'sres'::jsonb->>'ride_id')::uuid)
  and (select is_pool from public.trip_groups where id = pg_temp.group_of(:'sa')), 'two shared requests going the same way are paired into one trip');
select pg_temp.check((select bool_and((fare->>'total')::numeric = round((fare->>'solo_total')::numeric * 0.75)) from public.rides where id in (:'sa', (:'sres'::jsonb->>'ride_id')::uuid)),
  'each co-rider pays 75% of their solo fare (the split)');
select pg_temp.check(pg_temp.status_of(:'sa') = 'offered' and (select summary->>'is_pool' from public.ride_offers where group_id = pg_temp.group_of(:'sa') and outcome = 'pending') = 'true',
  'the captain is offered the shared trip and can accept or decline it');

-- L5. traffic levels for the maps, and quick tries in busy areas
select pg_temp.check((select count(*) from public.zone_traffic()) = 8 and (select bool_and(level in ('heavy', 'moderate', 'low')) from public.zone_traffic()),
  'every zone has a traffic level: heavy, moderate or low');
select pg_temp.check((select (payload ? 'quick') and (payload->>'max_attempts')::int = 5 from public.ride_events where type = 'offer_created' order by id desc limit 1),
  'offers record whether the quick (busy-area) timeout applied, and the 5-try limit');

rollback;
