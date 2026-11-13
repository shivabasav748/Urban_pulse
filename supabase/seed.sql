-- LOCAL DEV SEED ONLY. Demo city: Belagavi (Belgaum), Karnataka. All people, vehicles and positions are SIMULATED.
-- Demo password for every seeded account: demo1234 (local stack only, never reuse on a hosted project).

insert into public.zones(id, name, kind, lat, lng) values
  -- Belagavi (Belgaum). Centres from OpenStreetMap Nominatim, looked up 13 Nov 2026; kinds match ml/train.py zones.
  (1, 'Khade Bazar / City Centre',      'mixed',       15.86112, 74.51492),
  (2, 'Tilakwadi / RPD',                'nightlife',   15.83686, 74.50193),
  (3, 'Nehru Nagar / KLE',              'office',      15.88790, 74.51992),
  (4, 'Vadgaon / Shahapur',             'residential', 15.83359, 74.52421),
  (5, 'Udyambag Industrial',            'office',      15.81746, 74.49263),
  (6, 'VTU / Machhe',                   'office',      15.77730, 74.46486),
  (7, 'KSCA Stadium / Ramteerth Nagar', 'events',      15.88564, 74.54633),
  (8, 'Belagavi Airport (Sambra)',      'transit',     15.86308, 74.61119);

-- sim clock sits inside the forecast test week (Thu 12 Nov 2026, 18:00 IST) so predicted vs actual is visible
insert into public.settings(id, sim_clock) values (true, '2026-11-12 18:00:00+05:30');

create or replace function pg_temp.mk_user(p_email text, p_name text, p_role text, p_cat text default null) returns uuid
language plpgsql as $$
declare uid uuid := gen_random_uuid();
begin
  insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', p_email,
    extensions.crypt('demo1234', extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}',
    jsonb_build_object('name', p_name, 'role', case when p_role = 'admin' then 'rider' else p_role end, 'category', p_cat),
    now(), now(), '', '', '', '');
  insert into auth.identities(id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', p_email), 'email', now(), now(), now());
  if p_role = 'admin' then update public.profiles set role = 'admin' where id = uid; end if;  -- only the seed can do this
  return uid;
end $$;

select pg_temp.mk_user('admin@demo.up', 'Judge Console', 'admin');
select pg_temp.mk_user('rider@demo.up', 'Asha (rider)', 'rider');
select pg_temp.mk_user('rider2@demo.up', 'Bharat (rider)', 'rider');
select pg_temp.mk_user('rider3@demo.up', 'Chitra (rider)', 'rider');

-- captain1: real login for the live driver demo (not auto-driven)
do $$
declare uid uuid := pg_temp.mk_user('captain1@demo.up', 'Captain Ravi', 'driver', 'cab');
begin
  update public.driver_profiles set lat = 15.8655, lng = 74.5100, online = true, vehicle_label = 'Hatchback (demo)',
    plate = 'KA-01-UP-0001', trips_today = 3, offers_received = 10, offers_accepted = 9, idle_since = now() - interval '6 min'
  where user_id = uid;
  insert into public.demo_driver_seed values (uid, 15.8655, 74.5100, 3, 9, 6);
end $$;

-- 16 SIMULATED captains: (name, category, zone lat/lng offset, trips_today, accepted of 10, idle minutes)
do $$
declare r record; uid uuid; i int := 0;
begin
  for r in select * from (values
    ('Arjun','cab',   15.8630,74.5175, 6, 10,  2), ('Meera','cab',  15.8510,74.5105, 1,  7, 25),
    ('Kiran','cab',   15.8385,74.5040, 4,  9, 10), ('Farah','cab',  15.8860,74.5170, 2,  8, 18),
    ('Vikram','cab',  15.8350,74.5220, 5,  6,  4), ('Lakshmi','cab',15.8190,74.4950, 0,  9, 30),
    ('Imran','cab',   15.7900,74.4820, 3,  9,  8), ('Divya','cab',  15.8620,74.6080, 2, 10, 12),
    ('Rahul','bike',  15.8600,74.5130, 7, 10,  1), ('Sneha','bike', 15.8400,74.5000, 2,  8, 20),
    ('Joseph','bike', 15.8800,74.5220, 4,  5, 14), ('Pooja','bike', 15.8410,74.5170, 1,  9, 22),
    ('Naveen','auto', 15.8645,74.5200, 3,  8,  9), ('Ayesha','auto',15.8770,74.5320, 5,  9,  3),
    ('Suresh','auto', 15.8840,74.5440, 0,  7, 28), ('Tanvi','auto', 15.8250,74.5040, 2, 10, 16)
  ) v(name, cat, lat, lng, trips, acc, idle) loop
    i := i + 1;
    uid := pg_temp.mk_user(lower(r.name) || '@sim.up', 'Captain ' || r.name, 'driver', r.cat);
    update public.driver_profiles set lat = r.lat, lng = r.lng, online = true, is_simulated = true,
      vehicle_label = case r.cat when 'cab' then 'Sedan (sim)' when 'auto' then 'Auto (sim)' else 'Bike (sim)' end,
      plate = 'KA-SIM-' || lpad(i::text, 3, '0'),
      trips_today = r.trips, offers_received = 10, offers_accepted = r.acc, idle_since = now() - make_interval(mins => r.idle)
    where user_id = uid;
    insert into public.demo_driver_seed values (uid, r.lat, r.lng, r.trips, r.acc, r.idle);
  end loop;
end $$;

-- SIMULATED demo opt-ins for the women-driver preference (see migration 0007): a fixed, name-independent subset
-- of simulated captains (every third plate). Real accounts never get a seeded opt-in.
insert into public.captain_preferences(user_id, women_riders_optin, consented_at, simulated, declaration)
select dp.user_id, true, now(), true, 'simulated-demo-flag' from public.driver_profiles dp
where dp.is_simulated and dp.plate in ('KA-SIM-003', 'KA-SIM-006', 'KA-SIM-009', 'KA-SIM-012', 'KA-SIM-015')
on conflict (user_id) do nothing;
insert into public.captain_preference_audit(user_id, actor, action)
select user_id, null, 'seed_simulated' from public.captain_preferences where simulated;
update public.driver_profiles set op_zone = public._zone_of(lat, lng) where true;
