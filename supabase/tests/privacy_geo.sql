-- Privacy (RLS) + geospatial eligibility tests. Everything runs in one transaction and is rolled back.
-- Run: pnpm db:privacy   (local stack only)
\set ON_ERROR_STOP on
begin;
select id as r1 from auth.users where email = 'rider@demo.up' \gset
select id as r2 from auth.users where email = 'rider2@demo.up' \gset
select id as adm from auth.users where email = 'admin@demo.up' \gset
select id as cap from auth.users where email = 'captain1@demo.up' \gset
select id as sim from auth.users where email = 'meera@sim.up' \gset

-- fixture: pickup P = Rani Channamma Circle, Belagavi; only the captain under test is online
update public.settings set fast_demo = false where id;
delete from public.ride_events where true; delete from public.ride_offers where true; delete from public.trip_group_members where true;
delete from public.trip_groups where true; delete from public.rides where true;
update public.driver_profiles set online = false where true;
create function pg_temp.at(d_m float8) returns table(lat float8, lng float8) language sql as $$
  select extensions.st_y(g::extensions.geometry), extensions.st_x(g::extensions.geometry)
  from (select extensions.st_project(extensions.st_setsrid(extensions.st_makepoint(74.51172, 15.86723), 4326)::extensions.geography, d_m, 0) g) x $$;
create function pg_temp.place(who uuid, d_m float8, src text, acc numeric, age_s int, on_ boolean default true) returns void language sql as $$
  update public.driver_profiles d set lat = p.lat, lng = p.lng, location_source = src, location_accuracy_m = acc,
    location_updated_at = now() - make_interval(secs => age_s), online = on_
  from pg_temp.at(d_m) p where d.user_id = who $$;
create function pg_temp.group_for(radius int, cat text default 'cab') returns uuid language sql as $$
  insert into public.trip_groups(category, search_radius_m, stops) values (cat, radius,
    '[{"type":"pickup","label":"P","lat":15.86723,"lng":74.51172},{"type":"drop","label":"D","lat":15.84906,"lng":74.50894}]') returning id $$;
-- two statements on purpose: _rank is STABLE and only sees rows committed to the snapshot its statement started with
create function pg_temp.ranked(who uuid, radius int, cat text default 'cab') returns boolean language plpgsql volatile as $$
declare gid uuid;
begin
  gid := pg_temp.group_for(radius, cat);
  return exists (select 1 from public._rank(gid) r where r.driver_id = who);
end $$;
create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS: %', what; else raise exception 'FAIL: %', what; end if; end $$;

-- ===== geospatial radius boundary (dispatch uses exact geodesic distance) =====
select pg_temp.place(:'cap', 1990, 'gps', 15, 5);
select pg_temp.check(pg_temp.ranked(:'cap', 2000), 'captain 1,990 m away is eligible at 2 km');
select pg_temp.place(:'cap', 2010, 'gps', 15, 5);
select pg_temp.check(not pg_temp.ranked(:'cap', 2000), 'captain 2,010 m away is NOT eligible at 2 km');
select pg_temp.check(pg_temp.ranked(:'cap', 3000), 'same captain IS eligible after expanding to 3 km');
select pg_temp.place(:'cap', 4900, 'gps', 15, 5);
select pg_temp.check(not pg_temp.ranked(:'cap', 3000) and pg_temp.ranked(:'cap', 5000), '4,900 m: excluded at 3 km, included at 5 km');

-- ===== freshness, accuracy, status, category =====
select pg_temp.place(:'cap', 500, 'gps', 15, 200);
select pg_temp.check(not pg_temp.ranked(:'cap', 2000), 'stale GPS fix (200 s old) is not eligible');
select pg_temp.place(:'cap', 500, 'gps', 150, 5);
select pg_temp.check(not pg_temp.ranked(:'cap', 2000), 'inaccurate GPS fix (±150 m) is not eligible');
select pg_temp.place(:'cap', 500, 'manual', null, 5);
select pg_temp.check(pg_temp.ranked(:'cap', 2000), 'fresh manual pin is eligible');
select pg_temp.place(:'cap', 500, 'gps', 15, 5, false);
select pg_temp.check(not pg_temp.ranked(:'cap', 2000), 'offline captain is not eligible');
select pg_temp.place(:'cap', 500, 'gps', 15, 5);
select pg_temp.check(not pg_temp.ranked(:'cap', 2000, 'bike'), 'cab captain is not offered a bike ride');
select pg_temp.check(pg_temp.ranked(:'cap', 2000), 'fresh accurate online captain is eligible');

-- ===== rider privacy =====
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check((select count(*) from public.driver_profiles) = 0, 'unmatched rider can read no captain rows');
do $$ begin
  perform public.nearby_drivers(15.86723, 74.51172, 2000, null);
  raise exception 'FAIL: rider can call nearby_drivers (exact coordinates)';
exception when insufficient_privilege then raise notice 'PASS: nearby_drivers (exact coordinates) not callable by riders';
end $$;
select public.nearby_availability(15.86723, 74.51172, 2000) as avail \gset
select pg_temp.check(position('user_id' in :'avail') = 0 and position('driver_id' in :'avail') = 0, 'availability response carries no captain ids');
select pg_temp.check((select bool_and(abs((m->>'lat')::float8 / 0.003 - 0.5 - round((m->>'lat')::float8 / 0.003 - 0.5)) < 1e-6)
  from jsonb_array_elements((:'avail')::jsonb->'markers') m), 'availability markers are grid-snapped, not exact positions');
select pg_temp.check((select (c->>'count')::int from jsonb_array_elements((:'avail')::jsonb->'categories') c where c->>'category' = 'cab') = 1,
  'availability counts the one eligible cab within 2 km');
do $$ begin
  perform public.nearby_availability(15.86723, 74.51172, 50000);
  raise exception 'FAIL: arbitrary radius accepted';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'PASS: only 2/3/5 km radii accepted';
end $$;
select public.request_ride('P', 15.86723, 74.51172, 'D', 15.84906, 74.50894, 'cab', 2000) as req \gset
reset role;
select pg_temp.check((select driver_id from public.ride_offers where outcome = 'pending' and group_id = (:'req'::jsonb->>'group_id')::uuid) = :'cap',
  'ride offered to the eligible captain');

-- captain accepts; now (and only now) the assigned rider may see that captain
select set_config('request.jwt.claims', json_build_object('sub', :'cap', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check((select count(*) from public.driver_profiles) = 1, 'captain reads only their own row');
select public.respond_offer((select id from public.ride_offers where outcome = 'pending' and driver_id = :'cap'), true);
reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check((select count(*) from public.driver_profiles where user_id = :'cap') = 1, 'assigned rider can read their captain during the trip');
select pg_temp.check((select count(*) from public.driver_profiles) = 1, 'assigned rider still cannot read any other captain');
reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'r2', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check((select count(*) from public.driver_profiles) = 0, 'a different rider cannot read the assigned captain');
reset role;
update public.trip_groups set status = 'completed' where id = (:'req'::jsonb->>'group_id')::uuid;
select public._sync((:'req'::jsonb->>'group_id')::uuid);
select set_config('request.jwt.claims', json_build_object('sub', :'r1', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check((select count(*) from public.driver_profiles) = 0, 'precise sharing ends when the trip ends');
reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'adm', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check((select count(*) from public.driver_profiles) = 17, 'admin/judge can read the whole fleet');
reset role;

-- ===== location updates =====
-- last GPS fix 60 s ago: a 0.5 km move is ~22 km/h (valid); the 11 km jump below is ~500 km/h (rejected)
select pg_temp.place(:'cap', 0, 'gps', 10, 60);
select set_config('request.jwt.claims', json_build_object('sub', :'cap', 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ begin
  perform public.update_location(15.93267, 74.52555, 10, 'gps'); -- Kakati, ~7.4 km in 60 s
  raise exception 'FAIL: GPS teleport accepted';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'PASS: implausible GPS jump rejected (%)', sqlerrm;
end $$;
do $$ begin
  perform public.update_location(19.076, 72.8777, 10, 'gps');
  raise exception 'FAIL: location outside demo area accepted';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'PASS: outside demo area rejected';
end $$;
select public.update_location(15.8700, 74.5140, 25, 'gps');
select pg_temp.check((select location_source = 'gps' and location_accuracy_m = 25 and location_updated_at > now() - interval '5 seconds'
  from public.driver_profiles where user_id = auth.uid()), 'valid GPS update stores accuracy, source and timestamp');
reset role;
update public.trip_groups set status = 'cancelled' where driver_id = :'cap' and status in ('accepted','arriving','ongoing');
select set_config('request.jwt.claims', json_build_object('sub', :'cap', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.set_online(false);
select pg_temp.check((select location_updated_at is null from public.driver_profiles where user_id = auth.uid()), 'going offline stops location sharing (freshness cleared)');
reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'sim', 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ begin
  perform public.update_location(15.86, 74.51, 10, 'gps');
  raise exception 'FAIL: simulated captain location writable by a client';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'PASS: simulated captains cannot be moved by clients';
end $$;
reset role;
rollback;
