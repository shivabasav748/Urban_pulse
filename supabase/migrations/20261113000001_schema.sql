-- Urban Pulse schema. See docs/DATA_MODEL.md.
create extension if not exists postgis with schema extensions;

-- ---------- reference data ----------
create table public.zones (
  id smallint primary key,
  name text not null unique,
  kind text not null,
  lat double precision not null,
  lng double precision not null
);

create table public.settings (
  id boolean primary key default true check (id),
  w_eta numeric not null default 0.45,
  w_workload numeric not null default 0.25,
  w_reliability numeric not null default 0.20,
  w_idle numeric not null default 0.10,
  offer_timeout_s int not null default 15,
  fast_demo boolean not null default true,
  delay_threshold_min numeric not null default 2,
  search_radius_m int not null default 6000,
  max_attempts int not null default 5,
  surge_cap numeric not null default 2.0,
  surge_alpha numeric not null default 0.5,
  pool_max_detour_pct numeric not null default 40,
  sim_clock timestamptz not null default now()
);

-- ---------- identity ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'rider' check (role in ('rider','driver','admin')),
  display_name text not null default 'User',
  created_at timestamptz not null default now()
);

create table public.driver_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  online boolean not null default false,
  lat double precision not null,
  lng double precision not null,
  location extensions.geography(Point,4326)
    generated always as (extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography) stored,
  vehicle_category text not null default 'bike' check (vehicle_category in ('bike','auto','cab')),
  vehicle_label text not null default 'Demo vehicle',
  plate text not null default 'KA-00-DEMO',
  is_simulated boolean not null default false,
  idle_since timestamptz default now(),
  trips_today int not null default 0 check (trips_today >= 0),
  offers_received int not null default 0,
  offers_accepted int not null default 0
);
create index driver_profiles_location_gix on public.driver_profiles using gist (location);

-- ---------- rides ----------
create table public.rides (
  id uuid primary key default gen_random_uuid(),
  rider_id uuid not null references public.profiles(id),
  driver_id uuid references public.profiles(id),          -- mirror of group driver, for display
  pickup_label text not null, drop_label text not null,
  pickup_lat double precision not null, pickup_lng double precision not null,
  drop_lat double precision not null, drop_lng double precision not null,
  category text not null check (category in ('bike','auto','cab')),
  status text not null default 'requested' check (status in
    ('requested','offered','accepted','arriving','ongoing','completed','cancelled','no_driver_found')),
  attempt_no int not null default 0,
  est_distance_km numeric not null, est_trip_min numeric not null, est_pickup_min numeric,
  fare jsonb not null, surge numeric not null default 1,
  requested_at timestamptz not null default now(),
  accepted_at timestamptz, arriving_at timestamptz, started_at timestamptz,
  completed_at timestamptz, cancelled_at timestamptz
);
create index rides_rider_idx on public.rides(rider_id, requested_at desc);
create index rides_driver_idx on public.rides(driver_id, requested_at desc);

create table public.trip_groups (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid references public.driver_profiles(user_id),
  status text not null default 'requested' check (status in
    ('requested','offered','accepted','arriving','ongoing','completed','cancelled','no_driver_found')),
  is_pool boolean not null default false,
  category text not null,
  stops jsonb not null default '[]',
  attempt_no int not null default 0,
  created_at timestamptz not null default now(),
  accepted_at timestamptz, arriving_at timestamptz, started_at timestamptz, completed_at timestamptz
);
-- integrity rule 1: one active trip group per driver
create unique index trip_groups_one_active_per_driver on public.trip_groups(driver_id)
  where status in ('accepted','arriving','ongoing');

create table public.trip_group_members (
  group_id uuid not null references public.trip_groups(id) on delete cascade,
  ride_id uuid not null unique references public.rides(id),   -- rule 4: ride in at most one group
  pickup_seq int not null default 1, drop_seq int not null default 2,
  detour_min numeric not null default 0, fare_share numeric,
  primary key (group_id, ride_id)
);

create table public.ride_offers (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.trip_groups(id),
  driver_id uuid not null references public.driver_profiles(user_id),
  attempt_no int not null,
  score numeric not null,
  components jsonb not null,           -- chosen driver components + ranking snapshot
  summary jsonb not null,              -- what the driver sees on the offer card
  outcome text not null default 'pending' check (outcome in
    ('pending','accepted','rejected','no_response','cancelled')),
  offered_at timestamptz not null default now(),
  expires_at timestamptz not null,
  responded_at timestamptz
);
-- rule 2 + 3
create unique index ride_offers_one_pending_per_group on public.ride_offers(group_id) where outcome = 'pending';
create unique index ride_offers_one_pending_per_driver on public.ride_offers(driver_id) where outcome = 'pending';
create index ride_offers_group_idx on public.ride_offers(group_id, attempt_no);

create table public.ride_events (
  id bigint generated always as identity primary key,
  group_id uuid references public.trip_groups(id),
  ride_id uuid references public.rides(id),
  actor uuid,
  type text not null,
  from_status text, to_status text,
  payload jsonb not null default '{}',
  at timestamptz not null default clock_timestamp()
);
create index ride_events_group_idx on public.ride_events(group_id, at);

create table public.ride_transitions (
  from_status text not null, to_status text not null, actor_role text not null,
  primary key (from_status, to_status, actor_role)
);
insert into public.ride_transitions values
  ('accepted','arriving','driver'), ('arriving','ongoing','driver'), ('ongoing','completed','driver');

-- ---------- forecasting (SIMULATED data from ml/train.py) ----------
create table public.demand_observations (
  zone_id smallint not null references public.zones(id),
  ts timestamptz not null, demand int not null, rain boolean not null, incident boolean not null,
  primary key (zone_id, ts)
);
create table public.demand_forecasts (
  zone_id smallint not null references public.zones(id),
  target_ts timestamptz not null,
  scenario text not null default 'base',
  predicted numeric not null, actual numeric,
  model_version text not null,
  primary key (zone_id, target_ts, scenario)
);
create table public.model_runs (
  version text primary key, model text not null,
  mae numeric not null, baseline_mae numeric not null,
  features jsonb not null, train_rows int not null, test_rows int not null,
  horizon_min int not null, trained_at timestamptz not null
);

-- ---------- helpers ----------
create function public.is_admin() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

-- new auth user -> profile (+ driver profile). Signup may only pick rider|driver.
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
declare r text := coalesce(new.raw_user_meta_data->>'role', 'rider');
begin
  if r not in ('rider','driver') then r := 'rider'; end if;
  insert into public.profiles(id, role, display_name)
  values (new.id, r, coalesce(nullif(new.raw_user_meta_data->>'name',''), split_part(new.email,'@',1)));
  if r = 'driver' then
    insert into public.driver_profiles(user_id, lat, lng, vehicle_category)
    values (new.id, 12.9352 + (random()-0.5)*0.02, 77.6245 + (random()-0.5)*0.02,
            coalesce(nullif(new.raw_user_meta_data->>'category',''), 'bike'));
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- RLS: reads via policies, all writes via RPC ----------
alter table public.zones enable row level security;
alter table public.settings enable row level security;
alter table public.profiles enable row level security;
alter table public.driver_profiles enable row level security;
alter table public.rides enable row level security;
alter table public.trip_groups enable row level security;
alter table public.trip_group_members enable row level security;
alter table public.ride_offers enable row level security;
alter table public.ride_events enable row level security;
alter table public.ride_transitions enable row level security;
alter table public.demand_observations enable row level security;
alter table public.demand_forecasts enable row level security;
alter table public.model_runs enable row level security;

revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;

create policy read_all on public.zones for select to authenticated using (true);
create policy read_all on public.settings for select to authenticated using (true);
create policy read_all on public.profiles for select to authenticated using (true);
create policy read_all on public.driver_profiles for select to authenticated using (true);
create policy read_all on public.ride_transitions for select to authenticated using (true);
create policy read_all on public.demand_observations for select to authenticated using (true);
create policy read_all on public.demand_forecasts for select to authenticated using (true);
create policy read_all on public.model_runs for select to authenticated using (true);

create policy own_rides on public.rides for select to authenticated
  using (rider_id = auth.uid() or driver_id = auth.uid() or public.is_admin());
create policy own_groups on public.trip_groups for select to authenticated
  using (driver_id = auth.uid() or public.is_admin()
    or exists (select 1 from public.trip_group_members m join public.rides r on r.id = m.ride_id
               where m.group_id = trip_groups.id and r.rider_id = auth.uid()));
create policy own_members on public.trip_group_members for select to authenticated
  using (public.is_admin() or exists (select 1 from public.rides r where r.id = ride_id
         and (r.rider_id = auth.uid() or r.driver_id = auth.uid())));
create policy own_offers on public.ride_offers for select to authenticated
  using (driver_id = auth.uid() or public.is_admin());
create policy own_events on public.ride_events for select to authenticated
  using (public.is_admin() or exists (select 1 from public.rides r where r.id = ride_id
         and (r.rider_id = auth.uid() or r.driver_id = auth.uid())));

alter publication supabase_realtime add table public.rides, public.trip_groups, public.ride_offers,
  public.ride_events, public.driver_profiles;
