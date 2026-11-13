-- LOCAL DEV SEED ONLY. All people, vehicles and positions are SIMULATED.
-- Demo password for every seeded account: demo1234 (local stack only, never reuse on a hosted project).

insert into public.zones(id, name, kind, lat, lng) values
  (1, 'Koramangala',     'mixed',       12.9352, 77.6245),
  (2, 'Indiranagar',     'nightlife',   12.9719, 77.6412),
  (3, 'MG Road',         'office',      12.9733, 77.6170),
  (4, 'HSR Layout',      'residential', 12.9116, 77.6474),
  (5, 'Whitefield',      'office',      12.9698, 77.7500),
  (6, 'Electronic City', 'office',      12.8452, 77.6602),
  (7, 'Stadium',         'events',      12.9788, 77.5996),
  (8, 'Hebbal (Airport Rd)', 'transit', 13.0358, 77.5970);

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
  update public.driver_profiles set lat = 12.9330, lng = 77.6210, online = true, vehicle_label = 'Hatchback (demo)',
    plate = 'KA-01-UP-0001', trips_today = 3, offers_received = 10, offers_accepted = 9, idle_since = now() - interval '6 min'
  where user_id = uid;
  insert into public.demo_driver_seed values (uid, 12.9330, 77.6210, 3, 9, 6);
end $$;

-- 16 SIMULATED captains: (name, category, zone lat/lng offset, trips_today, accepted of 10, idle minutes)
do $$
declare r record; uid uuid; i int := 0;
begin
  for r in select * from (values
    ('Arjun','cab',   12.9372,77.6268, 6, 10,  2), ('Meera','cab',  12.9301,77.6180, 1,  7, 25),
    ('Kiran','cab',   12.9700,77.6390, 4,  9, 10), ('Farah','cab',  12.9745,77.6150, 2,  8, 18),
    ('Vikram','cab',  12.9120,77.6450, 5,  6,  4), ('Lakshmi','cab',12.9680,77.7480, 0,  9, 30),
    ('Imran','cab',   12.8470,77.6580, 3,  9,  8), ('Divya','cab',  13.0340,77.5990, 2, 10, 12),
    ('Rahul','bike',  12.9360,77.6230, 7, 10,  1), ('Sneha','bike', 12.9725,77.6425, 2,  8, 20),
    ('Joseph','bike', 12.9740,77.6190, 4,  5, 14), ('Pooja','bike', 12.9100,77.6490, 1,  9, 22),
    ('Naveen','auto', 12.9340,77.6260, 3,  8,  9), ('Ayesha','auto',12.9705,77.6400, 5,  9,  3),
    ('Suresh','auto', 12.9790,77.6010, 0,  7, 28), ('Tanvi','auto', 12.8460,77.6620, 2, 10, 16)
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
