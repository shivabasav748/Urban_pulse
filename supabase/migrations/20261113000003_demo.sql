-- Home positions/stats for seeded SIMULATED drivers, used by demo_reset(). No client access.
create table public.demo_driver_seed (
  user_id uuid primary key references public.driver_profiles(user_id) on delete cascade,
  home_lat double precision not null, home_lng double precision not null,
  seed_trips int not null, seed_accepted int not null, seed_idle_min int not null
);
alter table public.demo_driver_seed enable row level security;
revoke all on public.demo_driver_seed from anon, authenticated;
