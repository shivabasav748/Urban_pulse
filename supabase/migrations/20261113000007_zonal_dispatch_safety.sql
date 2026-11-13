-- 0007: judges' feedback (13 Nov 2026). Forward-only and additive: no table or column is dropped, no data is discarded.
--   1. Zone balance from live data + the v2 forecast (demand, pending, captains, shortage, peak). Replaces static labels.
--   2. Zone-aware ranking: a 5th score component (zone balance) on top of the existing ETA/workload/reliability/idle mix.
--   3. Captain zone switching + proactive repositioning with hysteresis, cooldown and observed arrival (no teleporting).
--   4. Wider automatic reassignment: captain offline / stale location / ineligible while holding an offer or a pickup.
--   5. "Prefer a woman driver": captain opt-in (restricted table), hard eligibility filter on every dispatch path.
--   6. Safety feedback (separate from any star rating) and safety reports with an admin review trail.
-- Lock order stays trip_groups -> driver_profiles -> ride_offers -> reposition_moves.

-- ================= settings =================
alter table public.settings
  add column dispatch_policy text not null default 'zone_aware' check (dispatch_policy in ('urban_pulse', 'zone_aware')),
  add column w_zone numeric not null default 0.15 check (w_zone >= 0 and w_zone <= 0.5),
  add column reposition_cooldown_min int not null default 10 check (reposition_cooldown_min >= 0),
  add column reposition_max_km numeric not null default 8 check (reposition_max_km > 0),
  add column reposition_ttl_s int not null default 120 check (reposition_ttl_s > 0),
  add column peak_ratio numeric not null default 1.5 check (peak_ratio >= 1),
  add column safety_min_feedback int not null default 5 check (safety_min_feedback >= 1),
  add column keep_waiting_min int not null default 5 check (keep_waiting_min between 1 and 30),
  add column last_reposition_at timestamptz;

-- ================= captain zone state =================
-- physical zone = nearest zone centre to the current position (derived, never stored);
-- operational zone = op_zone, changes only when an accepted move is observed to arrive.
alter table public.driver_profiles
  add column op_zone smallint references public.zones(id),
  add column zone_changed_at timestamptz;
update public.driver_profiles set op_zone = public._zone_of(lat, lng) where true;

create table public.reposition_moves (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.driver_profiles(user_id) on delete cascade,
  from_zone smallint not null references public.zones(id),
  to_zone smallint not null references public.zones(id),
  source text not null check (source in ('system', 'captain')),
  status text not null default 'recommended' check (status in ('recommended', 'accepted', 'arrived', 'declined', 'expired', 'cancelled')),
  reason jsonb not null default '{}',
  km numeric, eta_min numeric,
  simulated boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  responded_at timestamptz, arrived_at timestamptz, closed_reason text,
  check (from_zone <> to_zone)
);
-- at most one open (recommended or en-route) move per captain
create unique index reposition_moves_one_open on public.reposition_moves(driver_id) where status in ('recommended', 'accepted');
create index reposition_moves_created on public.reposition_moves(created_at desc);

-- ================= women-driver preference: captain opt-in (restricted personal information) =================
-- Separate table on purpose: driver_profiles rows are readable by the rider assigned to that captain, this is not.
create table public.captain_preferences (
  user_id uuid primary key references public.driver_profiles(user_id) on delete cascade,
  women_riders_optin boolean not null default false,
  declaration text not null default 'self-declared-v1',   -- self-declared, NOT independently verified
  consented_at timestamptz, withdrawn_at timestamptz,
  simulated boolean not null default false,
  updated_at timestamptz not null default now()
);
create table public.captain_preference_audit (
  id bigint generated always as identity primary key,
  user_id uuid not null, actor uuid, action text not null check (action in ('opt_in', 'withdraw', 'seed_simulated')),
  at timestamptz not null default clock_timestamp()
);

alter table public.rides add column women_driver_pref boolean not null default false;
alter table public.trip_groups
  add column women_driver_pref boolean not null default false,
  add column searching_since timestamptz not null default now(),   -- start of the current search window (retry resets it)
  add column wait_until timestamptz;                               -- rider chose "keep waiting" until then
update public.trip_groups set searching_since = created_at where true;

-- ================= dispatch audit (judge only: rankings and ineligibility reasons never reach riders/captains) =================
create table public.dispatch_audit (
  id bigint generated always as identity primary key,
  group_id uuid not null references public.trip_groups(id) on delete cascade,
  offer_id uuid references public.ride_offers(id) on delete set null,
  attempt_no int not null,
  outcome text not null,
  policy text not null,
  ranking jsonb not null default '[]',
  eligibility jsonb not null default '{}',
  zone_snapshot jsonb not null default '[]',
  at timestamptz not null default clock_timestamp()
);
create index dispatch_audit_group on public.dispatch_audit(group_id, id);

-- ================= safety feedback + reports =================
create table public.safety_feedback (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null unique references public.rides(id),          -- one per ride (one rider per ride)
  rider_id uuid not null references public.profiles(id),
  driver_id uuid not null references public.profiles(id),
  overall smallint not null check (overall between 1 and 5),
  driving smallint check (driving between 1 and 5),
  vehicle smallint check (vehicle between 1 and 5),
  conduct smallint check (conduct between 1 and 5),
  comment text check (char_length(comment) <= 500),
  created_at timestamptz not null default now()
);
create index safety_feedback_driver on public.safety_feedback(driver_id);

create table public.safety_reports (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides(id),
  reporter_id uuid not null references public.profiles(id),
  driver_id uuid references public.profiles(id),
  category text not null check (category in ('unsafe_driving', 'harassment', 'vehicle_condition', 'route_deviation', 'other')),
  description text not null check (char_length(description) between 10 and 2000),
  status text not null default 'open' check (status in ('open', 'under_review', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id), reviewed_at timestamptz, resolution_note text,
  unique (ride_id, reporter_id)
);
create table public.safety_report_audit (
  id bigint generated always as identity primary key,
  report_id uuid not null references public.safety_reports(id) on delete cascade,
  actor uuid, from_status text, to_status text not null, note text,
  at timestamptz not null default clock_timestamp()
);

-- ================= RLS for the new tables (reads by policy, writes only through RPCs) =================
alter table public.reposition_moves enable row level security;
alter table public.captain_preferences enable row level security;
alter table public.captain_preference_audit enable row level security;
alter table public.dispatch_audit enable row level security;
alter table public.safety_feedback enable row level security;
alter table public.safety_reports enable row level security;
alter table public.safety_report_audit enable row level security;
revoke all on public.reposition_moves, public.captain_preferences, public.captain_preference_audit, public.dispatch_audit,
  public.safety_feedback, public.safety_reports, public.safety_report_audit from anon, authenticated;
grant select on public.reposition_moves, public.captain_preferences, public.captain_preference_audit, public.dispatch_audit,
  public.safety_feedback, public.safety_reports, public.safety_report_audit to authenticated;

create policy own_or_admin on public.reposition_moves for select to authenticated using (driver_id = auth.uid() or public.is_admin());
create policy own_or_admin on public.captain_preferences for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy admin_only on public.captain_preference_audit for select to authenticated using (public.is_admin());
create policy admin_only on public.dispatch_audit for select to authenticated using (public.is_admin());
-- the reporter sees their own; the captain sees neither rows nor reporter identity (only aggregates via RPC)
create policy own_or_admin on public.safety_feedback for select to authenticated using (rider_id = auth.uid() or public.is_admin());
create policy own_or_admin on public.safety_reports for select to authenticated using (reporter_id = auth.uid() or public.is_admin());
create policy admin_only on public.safety_report_audit for select to authenticated using (public.is_admin());

alter publication supabase_realtime add table public.reposition_moves;

-- ================= helpers =================
create function public._pref_ok(p_pref boolean, p_driver uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not coalesce(p_pref, false)
      or exists (select 1 from public.captain_preferences c where c.user_id = p_driver and c.women_riders_optin)
$$;

/** Live zone balance over the next 30 min. SIMULATED inputs: forecast (model v2, synthetic history) + live rows.
    demand_30 = predicted requests in the next 30-min bucket + requests waiting now
    expected  = free captains physically in the zone (not en route elsewhere) + captains en route to it
                + captains finishing a trip that drops in the zone
    state: undersupplied (shortage >= 1) | oversupplied (spare >= 2) | balanced. peak: demand/supply >= peak_ratio. */
create function public.zone_balance() returns table(zone_id smallint, name text, lat float8, lng float8,
  predicted_now numeric, predicted_next numeric, pending int, active_trips int, available int, incoming int, finishing int,
  expected_supply int, demand_30 numeric, shortage numeric, ratio numeric, state text, rising boolean, peak boolean,
  pickup_eta_min numeric, by_category jsonb)
language sql stable security definer set search_path = '' as $$
  with st as (select s.sim_clock, s.peak_ratio from public.settings s),
  t as (select to_timestamp(floor(extract(epoch from st.sim_clock) / 1800) * 1800) b, st.peak_ratio from st),
  free as (
    select dp.user_id, dp.lat, dp.lng, dp.vehicle_category cat, public._zone_of(dp.lat, dp.lng) zid
    from public.driver_profiles dp
    where dp.online and public._location_ok(dp)
      and not exists (select 1 from public.trip_groups g where g.driver_id = dp.user_id and g.status in ('accepted', 'arriving', 'ongoing'))
      and not exists (select 1 from public.ride_offers o where o.driver_id = dp.user_id and o.outcome = 'pending')
  ),
  enroute as (select m.driver_id, m.to_zone from public.reposition_moves m where m.status = 'accepted'),
  grp as (
    select g.status, public._zone_of((g.stops->0->>'lat')::float8, (g.stops->0->>'lng')::float8) pz,
           public._zone_of((g.stops->-1->>'lat')::float8, (g.stops->-1->>'lng')::float8) dz
    from public.trip_groups g where g.status in ('requested', 'offered', 'accepted', 'arriving', 'ongoing')
  ),
  base as (
    select z.id, z.name, z.lat, z.lng, t.peak_ratio,
      coalesce((select f.predicted from public.demand_forecasts f where f.zone_id = z.id and f.scenario = 'base' and f.target_ts = t.b), 0) p_now,
      coalesce((select f.predicted from public.demand_forecasts f where f.zone_id = z.id and f.scenario = 'base' and f.target_ts = t.b + interval '30 minutes'),
               (select f.predicted from public.demand_forecasts f where f.zone_id = z.id and f.scenario = 'base' and f.target_ts = t.b), 0) p_next,
      (select count(*) from grp where grp.pz = z.id and grp.status in ('requested', 'offered'))::int pend,
      (select count(*) from grp where grp.pz = z.id and grp.status in ('accepted', 'arriving', 'ongoing'))::int act,
      (select count(*) from free where free.zid = z.id and not exists (select 1 from enroute e where e.driver_id = free.user_id))::int avail,
      (select count(*) from enroute e where e.to_zone = z.id)::int inc,
      (select count(*) from grp where grp.dz = z.id and grp.status = 'ongoing')::int fin,
      (select min(public._minutes(public._km(f.lat, f.lng, z.lat, z.lng), f.cat)) from free f) eta,
      (select jsonb_build_object('bike', count(*) filter (where f.cat = 'bike'), 'auto', count(*) filter (where f.cat = 'auto'),
                                 'cab', count(*) filter (where f.cat = 'cab')) from free f where f.zid = z.id) bc
    from public.zones z, t
  ), calc as (
    select base.*, (base.avail + base.inc + base.fin) es, round(base.p_next + base.pend, 2) d30 from base
  )
  select c.id, c.name, c.lat, c.lng, round(c.p_now, 2), round(c.p_next, 2), c.pend, c.act, c.avail, c.inc, c.fin, c.es, c.d30,
    round(c.d30 - c.es, 2),
    round(c.d30 / greatest(c.es, 1), 2),
    case when c.d30 - c.es >= 1 then 'undersupplied' when c.es - c.d30 >= 2 then 'oversupplied' else 'balanced' end,
    c.p_next >= c.p_now * 1.15 and c.p_next - c.p_now >= 0.5,
    c.d30 / greatest(c.es, 1) >= c.peak_ratio and c.d30 >= 2,
    c.eta, c.bc
  from calc c order by c.id
$$;

/** Why each nearby captain is or is not eligible for this request (first failing rule). Judge-only via dispatch_audit. */
create function public._eligibility(p_group uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with p as (
    select (g.stops->0->>'lat')::float8 lat, (g.stops->0->>'lng')::float8 lng, g.category, g.search_radius_m r,
           g.women_driver_pref pref, g.searching_since ss
    from public.trip_groups g where g.id = p_group
  ), c as (
    select dp.user_id, pr.display_name nm, round(public._km(dp.lat, dp.lng, p.lat, p.lng), 2) km,
      case
        when not dp.online then 'offline'
        when not public._location_ok(dp) then 'location_stale_or_inaccurate'
        when dp.vehicle_category <> p.category then 'vehicle_category_mismatch'
        when not extensions.st_dwithin(dp.location, extensions.st_setsrid(extensions.st_makepoint(p.lng, p.lat), 4326)::extensions.geography, p.r)
          then 'outside_search_radius'
        when exists (select 1 from public.trip_groups a where a.driver_id = dp.user_id and a.status in ('accepted', 'arriving', 'ongoing')) then 'on_active_trip'
        when exists (select 1 from public.ride_offers o where o.group_id = p_group and o.driver_id = dp.user_id
                     and (o.outcome = 'rejected' or o.offered_at >= p.ss)) then 'already_offered_this_ride'
        when exists (select 1 from public.ride_offers o where o.driver_id = dp.user_id and o.outcome = 'pending') then 'holding_another_offer'
        when not public._pref_ok(p.pref, dp.user_id) then 'not_opted_in_for_women_driver_preference'
        else 'eligible' end reason
    from public.driver_profiles dp join public.profiles pr on pr.id = dp.user_id, p
  )
  select jsonb_build_object(
    'counts', (select coalesce(jsonb_object_agg(x.reason, x.n), '{}'::jsonb) from (select c.reason, count(*) n from c group by c.reason) x),
    'nearest', (select coalesce(jsonb_agg(jsonb_build_object('driver_id', y.user_id, 'name', y.nm, 'km', y.km, 'reason', y.reason) order by y.km), '[]'::jsonb)
                from (select * from c order by c.km limit 12) y))
$$;

-- ================= ranking: + zone balance component, + preference filter, + retry window =================
drop function public._rank(uuid, jsonb, jsonb, text);
create function public._rank(p_group uuid, p_weights jsonb default null, p_overrides jsonb default '{}', p_policy text default null)
returns table(driver_id uuid, name text, zone_id smallint, pickup_km numeric, pickup_min numeric, trips_today int, idle_min numeric,
              c_eta numeric, c_workload numeric, c_reliability numeric, c_idle numeric, c_zone numeric, score numeric)
language plpgsql stable security definer set search_path = '' as $$
declare s public.settings; g public.trip_groups; plat float8; plng float8; pol text;
  w_eta numeric; w_wl numeric; w_rel numeric; w_idle numeric; w_z numeric;
begin
  select * into s from public.settings;
  select * into g from public.trip_groups where id = p_group;
  select (g.stops->0->>'lat')::float8, (g.stops->0->>'lng')::float8 into plat, plng;
  pol := coalesce(p_policy, s.dispatch_policy);
  w_eta := coalesce((p_weights->>'eta')::numeric, s.w_eta);
  w_wl := coalesce((p_weights->>'workload')::numeric, s.w_workload);
  w_rel := coalesce((p_weights->>'reliability')::numeric, s.w_reliability);
  w_idle := coalesce((p_weights->>'idle')::numeric, s.w_idle);
  -- zone-aware = the existing four-part score scaled by (1 - w_zone), plus w_zone x zone balance. Relative weights unchanged.
  w_z := case when pol = 'zone_aware' then coalesce((p_weights->>'zone')::numeric, s.w_zone) else 0 end;
  return query
  with zb as (select b.zone_id zb_id, -b.shortage slack from public.zone_balance() b),
  c as (
    select dp.user_id, pr.display_name, public._zone_of(dp.lat, dp.lng) zid,
      public._km(dp.lat, dp.lng, plat, plng) km,
      coalesce((p_overrides->dp.user_id::text->>'trips_today')::int, dp.trips_today) tt,
      coalesce((p_overrides->dp.user_id::text->>'idle_min')::numeric,
               round(extract(epoch from (now() - coalesce(dp.idle_since, now()))) / 60, 1), 0) im,
      round((dp.offers_accepted + 4)::numeric / (dp.offers_received + 5), 3) rel
    from public.driver_profiles dp join public.profiles pr on pr.id = dp.user_id
    where dp.online
      and public._location_ok(dp)
      and dp.vehicle_category = g.category
      and extensions.st_dwithin(dp.location,
            extensions.st_setsrid(extensions.st_makepoint(plng, plat), 4326)::extensions.geography, coalesce(g.search_radius_m, s.search_radius_m))
      and not exists (select 1 from public.trip_groups a where a.driver_id = dp.user_id and a.status in ('accepted', 'arriving', 'ongoing'))
      and not exists (select 1 from public.ride_offers o where o.driver_id = dp.user_id and o.outcome = 'pending')
      -- excluded for this ride: anyone who declined, plus anyone already tried in the current search window
      and not exists (select 1 from public.ride_offers o where o.group_id = p_group and o.driver_id = dp.user_id
                      and (o.outcome = 'rejected' or o.offered_at >= g.searching_since))
      -- "prefer a woman driver" is a hard eligibility constraint, never a ranking bonus
      and public._pref_ok(g.women_driver_pref, dp.user_id)
  ), m as (
    select c.*, coalesce(zb.slack, 0) sl, public._minutes(c.km, g.category) pm,
      min(public._minutes(c.km, g.category)) over () pm_min, max(public._minutes(c.km, g.category)) over () pm_max,
      min(c.tt) over () tt_min, max(c.tt) over () tt_max, min(c.im) over () im_min, max(c.im) over () im_max,
      min(coalesce(zb.slack, 0)) over () sl_min, max(coalesce(zb.slack, 0)) over () sl_max
    from c left join zb on zb.zb_id = c.zid
  ), n as (
    select m.*,
      round(case when m.pm_max = m.pm_min then 1 else 1 - (m.pm - m.pm_min) / (m.pm_max - m.pm_min) end, 3) ce,
      round(case when m.tt_max = m.tt_min then 1 else 1 - (m.tt - m.tt_min)::numeric / (m.tt_max - m.tt_min) end, 3) cw,
      m.rel cr,
      round(case when m.im_max = m.im_min then 1 else (m.im - m.im_min) / (m.im_max - m.im_min) end, 3) ci,
      -- prefer taking a captain from a zone with spare supply over draining a short zone
      round(case when m.sl_max = m.sl_min then 1 else (m.sl - m.sl_min) / (m.sl_max - m.sl_min) end, 3) cz
    from m
  )
  select n.user_id, n.display_name, n.zid, n.km, n.pm, n.tt, n.im, n.ce, n.cw, n.cr, n.ci, n.cz,
    case when pol = 'nearest' then round(-n.pm, 3)
         else round((1 - w_z) * (w_eta * n.ce + w_wl * n.cw + w_rel * n.cr + w_idle * n.ci) + w_z * n.cz, 4) end
  from n order by 13 desc, n.pm asc, n.user_id asc;
end $$;

-- ================= dispatch =================
create or replace function public._dispatch(p_group uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.settings; g public.trip_groups; c record; ranking jsonb; offer_id uuid; prev text; tried int; elig jsonb;
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
        now() + make_interval(secs => s.offer_timeout_s))
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
                         'score', c.score, 'policy', s.dispatch_policy));
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
end $$;

-- close a pending offer with a failure outcome (+ reason), exclude the captain, re-dispatch
drop function public._fail_offer(uuid, text);
create function public._fail_offer(p_offer uuid, p_outcome text, p_reason text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.ride_offers;
begin
  select * into o from public.ride_offers where id = p_offer;
  perform 1 from public.trip_groups where id = o.group_id for update;
  select * into o from public.ride_offers where id = p_offer for update;
  if o.outcome <> 'pending' then return null; end if;
  update public.ride_offers set outcome = p_outcome, responded_at = now() where id = p_offer;
  update public.trip_groups set status = 'requested' where id = o.group_id and status = 'offered';
  perform public._event(o.group_id, 'offer_' || p_outcome, 'offered', 'requested',
    jsonb_build_object('offer_id', p_offer, 'driver_id', o.driver_id, 'excluded', true, 'attempt', o.attempt_no, 'reason', p_reason));
  return public._dispatch(o.group_id);
end $$;

create or replace function public._accept_offer(p_offer uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.ride_offers; g public.trip_groups;
begin
  select * into o from public.ride_offers where id = p_offer;
  select * into g from public.trip_groups where id = o.group_id for update;
  perform 1 from public.driver_profiles where user_id = o.driver_id for update;
  select * into o from public.ride_offers where id = p_offer for update;
  if o.outcome <> 'pending' then raise exception 'conflict: offer already %', o.outcome; end if;
  if o.expires_at < now() then  -- too late: treat as no response and reassign (no raise, or the reassignment rolls back)
    perform public._fail_offer(p_offer, 'no_response', 'expired'); return;
  end if;
  if not public._pref_ok(g.women_driver_pref, o.driver_id) then  -- withdrew the opt-in after the offer was made
    perform public._fail_offer(p_offer, 'cancelled', 'captain_not_eligible_for_preference'); return;
  end if;
  update public.ride_offers set outcome = 'accepted', responded_at = now() where id = p_offer;
  update public.trip_groups set status = 'accepted', driver_id = o.driver_id, accepted_at = now() where id = o.group_id;
  update public.driver_profiles set offers_accepted = offers_accepted + 1, idle_since = null where user_id = o.driver_id;
  -- a captain who takes a ride stops repositioning
  update public.reposition_moves set status = 'cancelled', closed_reason = 'took_a_ride', responded_at = coalesce(responded_at, now())
  where driver_id = o.driver_id and status in ('recommended', 'accepted');
  perform public._event(o.group_id, 'offer_accepted', 'offered', 'accepted',
    jsonb_build_object('offer_id', p_offer, 'driver_id', o.driver_id, 'attempt', o.attempt_no));
  perform public._sync(o.group_id);
end $$;

-- ================= ride request (+ preference) and retry =================
drop function public.request_ride(text, float8, float8, text, float8, float8, text, int);
create function public.request_ride(p_pickup_label text, p_lat float8, p_lng float8,
  p_drop_label text, d_lat float8, d_lng float8, p_category text, p_radius_m int default 2000,
  p_prefer_woman boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); km numeric; mins numeric; surge numeric; ride_id uuid; gid uuid; offer uuid; pref boolean := coalesce(p_prefer_woman, false);
begin
  if uid is null or (select role from public.profiles where id = uid) <> 'rider' then raise exception 'forbidden'; end if;
  if p_category not in ('bike', 'auto', 'cab') then raise exception 'validation: category'; end if;
  if p_radius_m not in (2000, 3000, 5000) then raise exception 'validation: radius must be 2000, 3000 or 5000'; end if;
  if exists (select 1 from public.rides where rider_id = uid and status in ('requested', 'offered', 'accepted', 'arriving', 'ongoing')) then
    raise exception 'conflict: you already have an active ride';
  end if;
  km := public._km(p_lat, p_lng, d_lat, d_lng);
  if km < 0.3 then raise exception 'validation: pickup and drop are too close'; end if;
  mins := public._minutes(km, p_category);
  surge := coalesce(public._zone_surge(public._zone_of(p_lat, p_lng)), 1);
  insert into public.rides(rider_id, pickup_label, drop_label, pickup_lat, pickup_lng, drop_lat, drop_lng, category,
    est_distance_km, est_trip_min, fare, surge, women_driver_pref)
  values (uid, p_pickup_label, p_drop_label, p_lat, p_lng, d_lat, d_lng, p_category, km, mins,
    public._fare(p_category, km, mins, surge), surge, pref)
  returning id into ride_id;
  insert into public.trip_groups(category, stops, search_radius_m, women_driver_pref) values (p_category, jsonb_build_array(
    jsonb_build_object('ride_id', ride_id, 'type', 'pickup', 'label', p_pickup_label, 'lat', p_lat, 'lng', p_lng),
    jsonb_build_object('ride_id', ride_id, 'type', 'drop', 'label', p_drop_label, 'lat', d_lat, 'lng', d_lng)), p_radius_m, pref)
  returning id into gid;
  insert into public.trip_group_members(group_id, ride_id) values (gid, ride_id);
  perform public._event(gid, 'ride_requested', null, 'requested',
    jsonb_build_object('category', p_category, 'surge', surge, 'radius_m', p_radius_m, 'women_driver_pref', pref));
  offer := public._dispatch(gid);
  return jsonb_build_object('ride_id', ride_id, 'group_id', gid, 'offer_id', offer);
end $$;

/** No captain found: the rider decides. Keep searching (preference kept) for keep_waiting_min, or drop the preference. */
create function public.retry_ride(p_ride uuid, p_drop_preference boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.rides; gid uuid; g public.trip_groups; s public.settings; pref boolean;
begin
  select * into r from public.rides where id = p_ride and rider_id = auth.uid();
  if not found then raise exception 'forbidden'; end if;
  select group_id into gid from public.trip_group_members where ride_id = p_ride;
  select * into g from public.trip_groups where id = gid for update;
  if g.is_pool then raise exception 'invalid_transition: pooled rides are retried by the operator'; end if;
  if not (g.status = 'no_driver_found' or (g.status = 'requested' and g.wait_until is not null)) then
    raise exception 'invalid_transition: this ride is not waiting for a captain';
  end if;
  select * into s from public.settings;
  pref := g.women_driver_pref and not coalesce(p_drop_preference, false);
  update public.rides set women_driver_pref = pref where id = p_ride;
  update public.trip_groups set status = 'requested', women_driver_pref = pref, searching_since = now(),
    wait_until = now() + make_interval(mins => s.keep_waiting_min)
  where id = gid;
  perform public._event(gid, 'search_restarted', g.status, 'requested',
    jsonb_build_object('women_driver_pref', pref, 'preference_removed', g.women_driver_pref and not pref, 'wait_min', s.keep_waiting_min));
  perform public._sync(gid);
  perform public._dispatch(gid);
  return jsonb_build_object('status', (select status from public.trip_groups where id = gid), 'women_driver_pref', pref);
end $$;

-- ================= captain availability: going offline hands any pending offer to the next captain =================
create or replace function public.set_online(p_online boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare o record;
begin
  if not exists (select 1 from public.driver_profiles where user_id = auth.uid()) then raise exception 'forbidden'; end if;
  if not p_online then
    if exists (select 1 from public.trip_groups where driver_id = auth.uid() and status in ('accepted', 'arriving', 'ongoing')) then
      raise exception 'conflict: finish or cancel your current trip before going offline';
    end if;
    -- release pending offers BEFORE locking our own row (lock order: trip_groups -> driver_profiles)
    for o in select id from public.ride_offers where driver_id = auth.uid() and outcome = 'pending' loop
      perform public._fail_offer(o.id, 'no_response', 'captain_went_offline');
    end loop;
  end if;
  -- The captain's row lock is the same lock dispatch takes before offering, so "go offline" and
  -- "offer this captain a ride" cannot interleave: whichever commits first is seen by the other.
  perform 1 from public.driver_profiles where user_id = auth.uid() for update;
  if not p_online and exists (select 1 from public.ride_offers where driver_id = auth.uid() and outcome = 'pending') then
    raise exception 'conflict: a ride request just arrived, try again';
  end if;
  update public.driver_profiles set online = p_online, idle_since = case when p_online then now() else null end,
    location_updated_at = case when p_online then location_updated_at else null end
  where user_id = auth.uid();
  if not p_online then
    update public.reposition_moves set status = 'cancelled', closed_reason = 'captain_went_offline', responded_at = coalesce(responded_at, now())
    where driver_id = auth.uid() and status in ('recommended', 'accepted');
  end if;
end $$;

-- ================= women-driver preference: captain self-service =================
create function public.set_women_riders_optin(p_optin boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); o record; n int := 0;
begin
  if p_optin is null then raise exception 'validation: choose yes or no'; end if;
  if not exists (select 1 from public.driver_profiles where user_id = uid and not is_simulated) then raise exception 'forbidden'; end if;
  insert into public.captain_preferences as cp(user_id, women_riders_optin, consented_at, withdrawn_at, updated_at)
  values (uid, p_optin, case when p_optin then now() end, case when not p_optin then now() end, now())
  on conflict (user_id) do update set women_riders_optin = excluded.women_riders_optin,
    consented_at = case when excluded.women_riders_optin then now() else cp.consented_at end,
    withdrawn_at = case when excluded.women_riders_optin then null else now() end,
    simulated = false, declaration = 'self-declared-v1', updated_at = now();
  insert into public.captain_preference_audit(user_id, actor, action) values (uid, uid, case when p_optin then 'opt_in' else 'withdraw' end);
  -- withdrawing hands pending preference requests to the next eligible captain; an active trip is never touched
  if not p_optin then
    for o in select ro.id from public.ride_offers ro join public.trip_groups g on g.id = ro.group_id
             where ro.driver_id = uid and ro.outcome = 'pending' and g.women_driver_pref loop
      perform public._fail_offer(o.id, 'cancelled', 'captain_withdrew_preference'); n := n + 1;
    end loop;
  end if;
  return jsonb_build_object('women_riders_optin', p_optin, 'released_offers', n);
end $$;

-- ================= repositioning =================
/** One planning pass. Called from the sweep (rate-limited to every 10 s) and by the judge ("Run now").
    Hysteresis: targets must be short by >= 1; donors keep >= 1 spare captain above their own 30-min demand.
    Cooldown: a captain is not re-recommended within reposition_cooldown_min of a zone change or an answered move.
    Arrival must be observed (fresh location in the target zone, not faster than half the estimated drive). */
create function public._reposition_tick(p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.settings; m record; z record; d record; k int; need int;
  n_new int := 0; n_arr int := 0; n_exp int := 0; n_cancel int := 0; n_step int := 0; step_km numeric; f float8;
begin
  select * into s from public.settings;
  if not p_force and s.last_reposition_at > now() - interval '10 seconds' then return jsonb_build_object('skipped', true); end if;
  update public.settings set last_reposition_at = now() where id;

  -- 1. expire unanswered suggestions and stalled moves
  with x as (update public.reposition_moves set status = 'expired', closed_reason = case status when 'recommended' then 'not_answered' else 'not_arrived_in_time' end,
               responded_at = coalesce(responded_at, now())
             where status in ('recommended', 'accepted') and expires_at < now() returning 1)
  select count(*) into n_exp from x;
  -- 2. captain no longer available (offline, stale location, took a trip)
  with x as (update public.reposition_moves mv set status = 'cancelled', closed_reason = 'captain_unavailable', responded_at = coalesce(mv.responded_at, now())
             from public.driver_profiles dp where dp.user_id = mv.driver_id and mv.status in ('recommended', 'accepted')
               and (not dp.online or not public._location_ok(dp)
                    or exists (select 1 from public.trip_groups g where g.driver_id = dp.user_id and g.status in ('accepted', 'arriving', 'ongoing')))
             returning 1)
  select count(*) into n_cancel from x;
  -- 3. suggestions whose target is no longer short (never keep pushing captains into a zone that filled up)
  update public.reposition_moves set status = 'cancelled', closed_reason = 'target_no_longer_short'
  where status = 'recommended' and to_zone in (select b.zone_id from public.zone_balance() b where b.state <> 'undersupplied');

  -- 4. SIMULATED captains (fast demo): accept suggestions after a few seconds and drive towards the zone, step by step
  if s.fast_demo then
    update public.reposition_moves mv set status = 'accepted', responded_at = now(), expires_at = now() + interval '30 minutes'
    from public.driver_profiles dp where dp.user_id = mv.driver_id and dp.is_simulated and mv.status = 'recommended'
      and mv.created_at < now() - interval '4 seconds';
    for m in select mv.driver_id, dp.lat, dp.lng, z.lat tlat, z.lng tlng from public.reposition_moves mv
             join public.driver_profiles dp on dp.user_id = mv.driver_id join public.zones z on z.id = mv.to_zone
             where mv.status = 'accepted' and dp.is_simulated loop
      step_km := public._km(m.lat, m.lng, m.tlat, m.tlng) / 1.35;
      if step_km < 0.3 then continue; end if;
      f := least(1, 0.6 / step_km);  -- ponytail: 0.6 km per 10 s tick, straight line; a demo pace, labelled simulated
      update public.driver_profiles set lat = m.lat + (m.tlat - m.lat) * f, lng = m.lng + (m.tlng - m.lng) * f where user_id = m.driver_id;
      n_step := n_step + 1;
    end loop;
  end if;

  -- 5. arrivals: fresh position inside the target zone, and not implausibly fast (anti-teleport for manual pins)
  for m in select mv.id, mv.driver_id, mv.to_zone, mv.responded_at, coalesce(mv.eta_min, 0) eta, dp.is_simulated
           from public.reposition_moves mv join public.driver_profiles dp on dp.user_id = mv.driver_id
           where mv.status = 'accepted' and public._zone_of(dp.lat, dp.lng) = mv.to_zone and public._location_ok(dp) loop
    if not m.is_simulated and now() - m.responded_at < make_interval(secs => m.eta * 30) then continue; end if;
    perform 1 from public.driver_profiles where user_id = m.driver_id for update;
    update public.reposition_moves set status = 'arrived', arrived_at = now() where id = m.id and status = 'accepted';
    if found then
      update public.driver_profiles set op_zone = m.to_zone, zone_changed_at = now() where user_id = m.driver_id;
      n_arr := n_arr + 1;
    end if;
  end loop;

  -- 6. plan: biggest shortage first; nearest eligible idle captain from a zone with spare supply; capped by the shortage
  for z in select * from public.zone_balance() b where b.state = 'undersupplied' order by b.shortage desc, b.zone_id loop
    need := floor(z.shortage)::int - (select count(*) from public.reposition_moves r where r.to_zone = z.zone_id and r.status = 'recommended')::int;
    for k in 1..greatest(need, 0) loop
      select dp.user_id, dp.vehicle_category, dp.is_simulated, b.zone_id from_zone,
             public._km(dp.lat, dp.lng, z.lat, z.lng) km into d
      from public.driver_profiles dp
      join public.zone_balance() b on b.zone_id = public._zone_of(dp.lat, dp.lng)
      where dp.online and public._location_ok(dp) and b.zone_id <> z.zone_id
        and not exists (select 1 from public.trip_groups g where g.driver_id = dp.user_id and g.status in ('accepted', 'arriving', 'ongoing'))
        and not exists (select 1 from public.ride_offers o where o.driver_id = dp.user_id and o.outcome = 'pending')
        and not exists (select 1 from public.reposition_moves r where r.driver_id = dp.user_id and r.status in ('recommended', 'accepted'))
        and (dp.zone_changed_at is null or dp.zone_changed_at < now() - make_interval(mins => s.reposition_cooldown_min))
        and not exists (select 1 from public.reposition_moves r where r.driver_id = dp.user_id
                        and r.status in ('declined', 'expired', 'cancelled', 'arrived')
                        and coalesce(r.responded_at, r.created_at) > now() - make_interval(mins => s.reposition_cooldown_min))
        and public._km(dp.lat, dp.lng, z.lat, z.lng) <= s.reposition_max_km * 1.35
        -- donor hysteresis: the source zone keeps at least one spare captain after this move
        and b.expected_supply - ceil(b.demand_30)
            - (select count(*) from public.reposition_moves r where r.from_zone = b.zone_id and r.status = 'recommended') >= 1
      order by ((z.by_category->>dp.vehicle_category)::int = 0) desc,  -- a category the target has none of first
               public._km(dp.lat, dp.lng, z.lat, z.lng), dp.user_id
      limit 1;
      exit when not found;
      begin
        insert into public.reposition_moves(driver_id, from_zone, to_zone, source, status, reason, km, eta_min, simulated, expires_at)
        values (d.user_id, d.from_zone, z.zone_id, 'system', 'recommended',
          jsonb_build_object('target', z.name, 'target_state', z.state, 'target_demand_30', z.demand_30,
            'target_expected_supply', z.expected_supply, 'target_shortage', z.shortage, 'target_peak', z.peak, 'target_rising', z.rising,
            'text', format('%s: about %s requests expected in 30 min for %s captains', z.name, round(z.demand_30), z.expected_supply)),
          round(d.km, 2), public._minutes(d.km, d.vehicle_category), d.is_simulated, now() + make_interval(secs => s.reposition_ttl_s));
        n_new := n_new + 1;
      exception when unique_violation then exit;  -- the captain just got another move (e.g. requested one themselves)
      end;
    end loop;
  end loop;
  return jsonb_build_object('skipped', false, 'recommended', n_new, 'arrived', n_arr, 'expired', n_exp, 'cancelled', n_cancel, 'sim_steps', n_step);
end $$;

/** What a captain sees: physical zone, operational zone, open move, and every zone's balance with distance + ETA. */
create function public.captain_zone_view() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid(); d public.driver_profiles; s public.settings; cur smallint; mv jsonb; cool int; blocked text;
begin
  select * into d from public.driver_profiles where user_id = uid;
  if not found then raise exception 'forbidden'; end if;
  select * into s from public.settings;
  cur := public._zone_of(d.lat, d.lng);
  select to_jsonb(x) into mv from (
    select m.id, m.from_zone, m.to_zone, z.name to_name, m.status, m.source, m.reason, m.km, m.eta_min, m.simulated,
           m.created_at, m.expires_at, m.responded_at
    from public.reposition_moves m join public.zones z on z.id = m.to_zone
    where m.driver_id = uid and m.status in ('recommended', 'accepted')) x;
  cool := case when d.zone_changed_at is null then 0
    else greatest(0, ceil(extract(epoch from (d.zone_changed_at + make_interval(mins => s.reposition_cooldown_min) - now())) / 60))::int end;
  blocked := case
    when not d.online then 'go_online_first'
    when not public._location_ok(d) then 'location_not_fresh'
    when exists (select 1 from public.trip_groups g where g.driver_id = uid and g.status in ('accepted', 'arriving', 'ongoing')) then 'on_trip'
    when exists (select 1 from public.ride_offers o where o.driver_id = uid and o.outcome = 'pending') then 'respond_to_offer'
    when cool > 0 then 'cooldown' end;
  return jsonb_build_object(
    'physical_zone', cur, 'op_zone', coalesce(d.op_zone, cur),
    'op_zone_name', (select z.name from public.zones z where z.id = coalesce(d.op_zone, cur)),
    'physical_zone_name', (select z.name from public.zones z where z.id = cur),
    'location_source', d.location_source, 'location_ok', public._location_ok(d), 'online', d.online,
    'open_move', mv, 'cooldown_min_left', cool, 'blocked_reason', blocked, 'simulated', true,
    'zones', (select jsonb_agg(jsonb_build_object('zone_id', b.zone_id, 'name', b.name, 'state', b.state,
        'demand_30', b.demand_30, 'expected_supply', b.expected_supply, 'shortage', b.shortage, 'peak', b.peak, 'rising', b.rising,
        'km', round(public._km(d.lat, d.lng, b.lat, b.lng), 1),
        'eta_min', public._minutes(public._km(d.lat, d.lng, b.lat, b.lng), d.vehicle_category),
        'current', b.zone_id = cur) order by b.shortage desc, b.zone_id)
      from public.zone_balance() b));
end $$;

create function public.captain_respond_move(p_move uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); m public.reposition_moves; d public.driver_profiles;
begin
  select * into d from public.driver_profiles where user_id = uid for update;   -- driver -> moves
  if not found then raise exception 'forbidden'; end if;
  select * into m from public.reposition_moves where id = p_move and driver_id = uid for update;
  if not found then raise exception 'forbidden'; end if;
  if m.status <> 'recommended' then raise exception 'conflict: this suggestion is no longer available'; end if;
  if not p_accept then
    update public.reposition_moves set status = 'declined', responded_at = now() where id = p_move;
    return;
  end if;
  if not d.online or not public._location_ok(d) then raise exception 'conflict: your location must be live to reposition'; end if;
  if exists (select 1 from public.trip_groups g where g.driver_id = uid and g.status in ('accepted', 'arriving', 'ongoing')) then
    raise exception 'conflict: finish your current trip first';
  end if;
  if exists (select 1 from public.ride_offers o where o.driver_id = uid and o.outcome = 'pending') then
    raise exception 'conflict: respond to your ride request first';
  end if;
  update public.reposition_moves set status = 'accepted', responded_at = now(), expires_at = now() + interval '30 minutes' where id = p_move;
end $$;

create function public.captain_request_zone(p_zone smallint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); d public.driver_profiles; s public.settings; b record; cur smallint; mid uuid; dist numeric;
begin
  select * into d from public.driver_profiles where user_id = uid for update;   -- driver -> moves
  if not found or d.is_simulated then raise exception 'forbidden'; end if;
  select * into s from public.settings;
  if not d.online or not public._location_ok(d) then raise exception 'conflict: go online with a live location first'; end if;
  if exists (select 1 from public.trip_groups g where g.driver_id = uid and g.status in ('accepted', 'arriving', 'ongoing')) then
    raise exception 'conflict: finish your current trip first';
  end if;
  if exists (select 1 from public.ride_offers o where o.driver_id = uid and o.outcome = 'pending') then
    raise exception 'conflict: respond to your ride request first';
  end if;
  if d.zone_changed_at > now() - make_interval(mins => s.reposition_cooldown_min) then
    raise exception 'conflict: you changed zone recently; try again in a few minutes';
  end if;
  if exists (select 1 from public.reposition_moves where driver_id = uid and status = 'accepted') then
    raise exception 'conflict: cancel your current move first';
  end if;
  cur := public._zone_of(d.lat, d.lng);
  select * into b from public.zone_balance() z where z.zone_id = p_zone;
  if not found then raise exception 'validation: unknown zone'; end if;
  if p_zone = cur then raise exception 'validation: you are already in %', b.name; end if;
  if b.state = 'oversupplied' then raise exception 'validation: % already has more captains than expected requests', b.name; end if;
  update public.reposition_moves set status = 'cancelled', closed_reason = 'captain_chose_other_zone', responded_at = now()
  where driver_id = uid and status = 'recommended';
  dist := public._km(d.lat, d.lng, b.lat, b.lng);
  insert into public.reposition_moves(driver_id, from_zone, to_zone, source, status, reason, km, eta_min, expires_at, responded_at)
  values (uid, cur, p_zone, 'captain', 'accepted',
    jsonb_build_object('target', b.name, 'target_state', b.state, 'target_demand_30', b.demand_30, 'target_expected_supply', b.expected_supply,
      'target_shortage', b.shortage, 'text', format('Requested by you. %s: about %s requests expected in 30 min for %s captains', b.name, round(b.demand_30), b.expected_supply)),
    round(dist, 2), public._minutes(dist, d.vehicle_category), now() + interval '30 minutes', now())
  returning id into mid;
  return mid;
end $$;

create function public.captain_cancel_move() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.driver_profiles where user_id = auth.uid() for update;
  if not found then raise exception 'forbidden'; end if;
  update public.reposition_moves set status = 'cancelled', closed_reason = 'cancelled_by_captain', responded_at = now()
  where driver_id = auth.uid() and status in ('recommended', 'accepted');
end $$;

-- ================= judge: zone status + run repositioning now =================
create function public.zone_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_admin();
  return jsonb_build_object(
    'sim_clock', (select sim_clock from public.settings), 'simulated', true,
    'settings', (select jsonb_build_object('dispatch_policy', s.dispatch_policy, 'w_zone', s.w_zone, 'cooldown_min', s.reposition_cooldown_min,
        'max_km', s.reposition_max_km, 'peak_ratio', s.peak_ratio) from public.settings s),
    'zones', (select coalesce(jsonb_agg(to_jsonb(b) order by b.zone_id), '[]'::jsonb) from public.zone_balance() b),
    'moves', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) from (
        select m.id, m.driver_id, p.display_name driver, dp.vehicle_category, m.from_zone, m.to_zone, m.source, m.status, m.reason,
               m.km, m.eta_min, m.simulated, m.created_at, m.responded_at, m.arrived_at, m.closed_reason
        from public.reposition_moves m join public.profiles p on p.id = m.driver_id join public.driver_profiles dp on dp.user_id = m.driver_id
        order by m.created_at desc limit 40) x),
    'captains', (select coalesce(jsonb_agg(jsonb_build_object('driver_id', dp.user_id, 'name', p.display_name, 'category', dp.vehicle_category,
        'online', dp.online, 'physical_zone', public._zone_of(dp.lat, dp.lng), 'op_zone', dp.op_zone, 'zone_changed_at', dp.zone_changed_at,
        'simulated', dp.is_simulated)), '[]'::jsonb)
      from public.driver_profiles dp join public.profiles p on p.id = dp.user_id));
end $$;

create function public.admin_reposition_now() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_admin();
  -- same lock as the sweep: never two planners at once
  perform pg_catalog.pg_advisory_xact_lock(727201, 1);
  return public._reposition_tick(true);
end $$;

-- ================= sweep: + unavailable/ineligible captains, unreachable pickups, waiting searches, repositioning =================
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
      begin perform public._accept_offer(o.id); n_auto := n_auto + 1;
      exception when others then errs := errs || jsonb_build_object('step', 'auto_accept', 'id', o.id, 'error', sqlerrm); end;
    end loop;
    for g in select tg.id from public.trip_groups tg join public.driver_profiles dp on dp.user_id = tg.driver_id
             where dp.is_simulated and tg.status in ('accepted', 'arriving', 'ongoing')
               and now() - greatest(tg.accepted_at, coalesce(tg.arriving_at, tg.accepted_at), coalesce(tg.started_at, tg.accepted_at)) > interval '6 seconds' loop
      begin
        perform 1 from public.trip_groups where id = g.id for update;
        perform public._advance(g.id, case (select status from public.trip_groups where id = g.id)
          when 'accepted' then 'arriving' when 'arriving' then 'ongoing' when 'ongoing' then 'completed' end);
        n_auto := n_auto + 1;
      exception when others then errs := errs || jsonb_build_object('step', 'auto_advance', 'id', g.id, 'error', sqlerrm); end;
    end loop;
  end if;
  begin repo := public._reposition_tick(false);
  exception when others then errs := errs || jsonb_build_object('step', 'reposition', 'error', sqlerrm); end;
  return jsonb_build_object('timeouts', n_timeout, 'delays', n_delay, 'auto', n_auto, 'unavailable', n_unavail, 'ineligible', n_inelig,
    'unreachable', n_unreach, 'retried', n_retry, 'reposition', repo, 'errors', errs, 'skipped', false);
end $$;

-- ================= safety feedback + reports =================
create function public.submit_safety_feedback(p_ride uuid, p_overall int, p_driving int default null, p_vehicle int default null,
  p_conduct int default null, p_comment text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.rides; fid uuid;
begin
  select * into r from public.rides where id = p_ride and rider_id = auth.uid();
  if not found then raise exception 'forbidden'; end if;
  if r.status <> 'completed' or r.driver_id is null then raise exception 'invalid_transition: feedback opens once the trip is completed'; end if;
  if p_overall is null or p_overall not between 1 and 5 then raise exception 'validation: overall safety must be 1 to 5'; end if;
  if char_length(coalesce(p_comment, '')) > 500 then raise exception 'validation: comment is limited to 500 characters'; end if;
  begin
    insert into public.safety_feedback(ride_id, rider_id, driver_id, overall, driving, vehicle, conduct, comment)
    values (p_ride, r.rider_id, r.driver_id, p_overall, p_driving, p_vehicle, p_conduct, nullif(trim(p_comment), ''))
    returning id into fid;
  exception
    when unique_violation then raise exception 'conflict: safety feedback was already submitted for this trip';
    when check_violation then raise exception 'validation: ratings must be 1 to 5';
  end;
  return fid;
end $$;

create function public.submit_safety_report(p_ride uuid, p_category text, p_description text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.rides; rid uuid;
begin
  select * into r from public.rides where id = p_ride and rider_id = auth.uid();
  if not found then raise exception 'forbidden'; end if;
  if r.driver_id is null or r.status not in ('accepted', 'arriving', 'ongoing', 'completed') then
    raise exception 'invalid_transition: a report needs a trip with an assigned captain';
  end if;
  if p_category not in ('unsafe_driving', 'harassment', 'vehicle_condition', 'route_deviation', 'other') then raise exception 'validation: category'; end if;
  if char_length(trim(coalesce(p_description, ''))) < 10 then raise exception 'validation: describe what happened (at least 10 characters)'; end if;
  begin
    insert into public.safety_reports(ride_id, reporter_id, driver_id, category, description)
    values (p_ride, r.rider_id, r.driver_id, p_category, trim(p_description)) returning id into rid;
  exception when unique_violation then raise exception 'conflict: you already reported this trip; our team is reviewing it';
  end;
  insert into public.safety_report_audit(report_id, actor, from_status, to_status) values (rid, auth.uid(), null, 'open');
  return rid;
end $$;

create function public.review_safety_report(p_report uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare cur text;
begin
  perform public._require_admin();
  if p_status not in ('under_review', 'resolved', 'dismissed') then raise exception 'validation: status'; end if;
  select status into cur from public.safety_reports where id = p_report for update;
  if not found then raise exception 'validation: unknown report'; end if;
  update public.safety_reports set status = p_status, reviewed_by = auth.uid(), reviewed_at = now(),
    resolution_note = coalesce(nullif(trim(p_note), ''), resolution_note) where id = p_report;
  insert into public.safety_report_audit(report_id, actor, from_status, to_status, note) values (p_report, auth.uid(), cur, p_status, p_note);
end $$;

/** Passenger-reported safety feedback, aggregated. Published only at >= safety_min_feedback entries.
    Callers: the captain, an admin, or the rider currently assigned to that captain. Never individual rows or reporters. */
create function public.captain_safety_summary(p_driver uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare n int; th int; res jsonb;
begin
  if auth.uid() is null or not (p_driver = auth.uid() or public.is_admin() or public._is_my_captain(p_driver)) then
    raise exception 'forbidden';
  end if;
  select safety_min_feedback into th from public.settings;
  select count(*) into n from public.safety_feedback where driver_id = p_driver;
  select jsonb_build_object('count', n, 'threshold', th, 'published', n >= th, 'source', 'passenger-reported',
    'overall', case when n >= th then round(avg(f.overall), 1) end,
    'driving', case when n >= th then round(avg(f.driving), 1) end,
    'vehicle', case when n >= th then round(avg(f.vehicle), 1) end,
    'conduct', case when n >= th then round(avg(f.conduct), 1) end)
  into res from public.safety_feedback f where f.driver_id = p_driver;
  return res;
end $$;

-- ================= pooling keeps the strictest preference =================
create or replace function public.create_pool(p_rides uuid[], p_stops jsonb, p_detours jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.settings; a public.rides; b public.rides; gid uuid; r uuid; old uuid;
begin
  perform public._require_admin();
  select * into s from public.settings;
  if array_length(p_rides, 1) <> 2 then raise exception 'validation: pool exactly 2 rides'; end if;
  select * into a from public.rides where id = p_rides[1] for update;
  select * into b from public.rides where id = p_rides[2] for update;
  if a.status not in ('requested', 'offered', 'no_driver_found') or b.status not in ('requested', 'offered', 'no_driver_found') then
    raise exception 'invalid_transition: rides already assigned';
  end if;
  if public._km(a.pickup_lat, a.pickup_lng, b.pickup_lat, b.pickup_lng) > 1.5 * 1.35
     or public._km(a.drop_lat, a.drop_lng, b.drop_lat, b.drop_lng) > 2.5 * 1.35 then
    raise exception 'validation: rides not compatible';
  end if;
  if exists (select 1 from jsonb_each_text(p_detours) d where d.value::numeric > s.pool_max_detour_pct) then
    raise exception 'validation: detour above limit';
  end if;
  insert into public.trip_groups(category, stops, is_pool, women_driver_pref)
  values ('cab', p_stops, true, a.women_driver_pref or b.women_driver_pref) returning id into gid;
  foreach r in array p_rides loop
    select group_id into old from public.trip_group_members where ride_id = r;
    update public.ride_offers set outcome = 'cancelled', responded_at = now() where group_id = old and outcome = 'pending';
    update public.trip_groups set status = 'cancelled' where id = old;
    perform public._event(old, 'merged_into_pool', null, 'cancelled', jsonb_build_object('pool_group', gid));
    update public.trip_group_members set group_id = gid,
      pickup_seq = (select (i - 1)::int from jsonb_array_elements(p_stops) with ordinality e(v, i) where v->>'ride_id' = r::text and v->>'type' = 'pickup'),
      drop_seq = (select (i - 1)::int from jsonb_array_elements(p_stops) with ordinality e(v, i) where v->>'ride_id' = r::text and v->>'type' = 'drop'),
      detour_min = coalesce((p_detours->>r::text)::numeric, 0)
    where ride_id = r;
    update public.rides set status = 'requested', category = 'cab',
      fare = public._fare('cab', est_distance_km, est_trip_min, surge) || jsonb_build_object('pool_discount', 0.25,
        'total', round((public._fare('cab', est_distance_km, est_trip_min, surge)->>'total')::numeric * 0.75))
    where id = r;
  end loop;
  perform public._event(gid, 'pool_created', null, 'requested', jsonb_build_object('rides', p_rides, 'stops', p_stops));
  perform public._dispatch(gid);
  return gid;
end $$;

-- ================= metrics: + reassignment, repositioning, safety =================
create or replace function public.admin_metrics() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  perform public._require_admin();
  with r as (select * from public.rides where requested_at > now() - interval '24 hours'),
  fails as (
    select e.ride_id, min(e.at) first_fail from public.ride_events e join r on r.id = e.ride_id
    where e.type in ('offer_rejected', 'offer_no_response', 'offer_cancelled', 'driver_cancelled', 'arrival_delayed', 'captain_unreachable')
    group by e.ride_id
  ), recov as (
    select f.ride_id, f.first_fail,
      (select min(e.at) from public.ride_events e where e.ride_id = f.ride_id and e.type = 'offer_accepted' and e.at > f.first_fail) recovered
    from fails f
  )
  select jsonb_build_object(
    'window', '24h, live rides (not Arena)',
    'requested', (select count(*) from r),
    'completed', (select count(*) from r where status = 'completed'),
    'cancelled', (select count(*) from r where status = 'cancelled'),
    'no_driver_found', (select count(*) from r where status = 'no_driver_found'),
    'completion_rate', (select round(count(*) filter (where status = 'completed')::numeric
        / nullif(count(*) filter (where status in ('completed', 'no_driver_found') or (status = 'cancelled' and accepted_at is not null)), 0), 3) from r),
    'avg_match_wait_s', (select round(avg(extract(epoch from accepted_at - requested_at))) from r where accepted_at is not null),
    'avg_pickup_wait_s', (select round(avg(extract(epoch from started_at - requested_at))) from r where started_at is not null),
    'avg_pickup_eta_err_s', (select round(avg(abs(extract(epoch from started_at - accepted_at) - est_pickup_min * 60)))
        from r where started_at is not null and est_pickup_min is not null),
    'reassignments', (select count(*) from public.ride_events e join r on r.id = e.ride_id
        where e.type in ('offer_rejected', 'offer_no_response', 'offer_cancelled', 'driver_cancelled', 'arrival_delayed', 'captain_unreachable')),
    'reassigned_rides', (select count(*) from recov),
    'reassignment_success_rate', (select round(count(*) filter (where recovered is not null)::numeric / nullif(count(*), 0), 3) from recov),
    'avg_reassignment_delay_s', (select round(avg(extract(epoch from recovered - first_fail))) from recov where recovered is not null),
    'moves', (select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb) from (select status, count(*) n from public.reposition_moves
        where created_at > now() - interval '24 hours' group by status) x),
    'safety_feedback', (select count(*) from public.safety_feedback),
    'safety_reports_open', (select count(*) from public.safety_reports where status in ('open', 'under_review')),
    'drivers', (select jsonb_agg(jsonb_build_object('driver_id', dp.user_id, 'name', p.display_name,
        'trips_today', dp.trips_today, 'online', dp.online,
        'busy_min_24h', coalesce((select round(sum(extract(epoch from coalesce(g.completed_at, now()) - g.accepted_at)) / 60, 1)
           from public.trip_groups g where g.driver_id = dp.user_id and g.accepted_at > now() - interval '24 hours'), 0),
        'acceptance', round((dp.offers_accepted + 4)::numeric / (dp.offers_received + 5), 3)) order by dp.trips_today desc)
      from public.driver_profiles dp join public.profiles p on p.id = dp.user_id)
  ) into res;
  return res;
end $$;

-- ================= demo reset also clears the new demo-run rows (never accounts, profiles, prefs or forecasts) =================
create or replace function public.demo_reset() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_admin();
  delete from public.safety_report_audit where true; delete from public.safety_reports where true; delete from public.safety_feedback where true;
  delete from public.dispatch_audit where true; delete from public.reposition_moves where true;
  delete from public.ride_events where true; delete from public.ride_offers where true; delete from public.trip_group_members where true;
  delete from public.trip_groups where true; delete from public.rides where true;
  update public.driver_profiles set lat = home_lat, lng = home_lng, online = true, trips_today = seed_trips,
    offers_received = 10, offers_accepted = seed_accepted, idle_since = now() - make_interval(mins => seed_idle_min),
    op_zone = public._zone_of(home_lat, home_lng), zone_changed_at = null
  from public.demo_driver_seed s where s.user_id = driver_profiles.user_id;
end $$;

create or replace function public.update_settings(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_admin();
  update public.settings set
    w_eta = coalesce((p->>'w_eta')::numeric, w_eta), w_workload = coalesce((p->>'w_workload')::numeric, w_workload),
    w_reliability = coalesce((p->>'w_reliability')::numeric, w_reliability), w_idle = coalesce((p->>'w_idle')::numeric, w_idle),
    w_zone = coalesce((p->>'w_zone')::numeric, w_zone),
    dispatch_policy = coalesce(p->>'dispatch_policy', dispatch_policy),
    offer_timeout_s = coalesce((p->>'offer_timeout_s')::int, offer_timeout_s),
    fast_demo = coalesce((p->>'fast_demo')::boolean, fast_demo),
    auto_accept_s = coalesce((p->>'auto_accept_s')::int, auto_accept_s),
    surge_cap = coalesce((p->>'surge_cap')::numeric, surge_cap),
    reposition_cooldown_min = coalesce((p->>'reposition_cooldown_min')::int, reposition_cooldown_min),
    sim_clock = coalesce((p->>'sim_clock')::timestamptz, sim_clock)
  where id;
end $$;

-- ================= SIMULATED demo opt-ins =================
-- A fixed, name-independent subset of the 16 simulated captains (every third plate) gets a demo opt-in flag so the
-- preference can be exercised. These are not real people; nothing is inferred from names. Real accounts are untouched.
insert into public.captain_preferences(user_id, women_riders_optin, consented_at, simulated, declaration)
select dp.user_id, true, now(), true, 'simulated-demo-flag' from public.driver_profiles dp
where dp.is_simulated and dp.plate in ('KA-SIM-003', 'KA-SIM-006', 'KA-SIM-009', 'KA-SIM-012', 'KA-SIM-015')
on conflict (user_id) do nothing;
insert into public.captain_preference_audit(user_id, actor, action)
select user_id, null, 'seed_simulated' from public.captain_preferences where simulated;

-- ================= grants =================
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_admin(), public.zone_intelligence(text),
  public.nearby_availability(float8, float8, int),
  public.estimate_ride(float8, float8, float8, float8, int),
  public.request_ride(text, float8, float8, text, float8, float8, text, int, boolean),
  public.retry_ride(uuid, boolean),
  public.respond_offer(uuid, boolean), public.advance_trip(uuid, text), public.driver_cancel(uuid), public.cancel_ride(uuid),
  public.set_online(boolean), public.update_location(float8, float8, numeric, text), public.sweep_exceptions(),
  public.chaos_inject(uuid, text), public.rerank_preview(uuid, jsonb, jsonb, text), public.update_settings(jsonb),
  public.apply_repositioning(text), public.create_pool(uuid[], jsonb, jsonb),
  public.demo_request(uuid, text, float8, float8, text, float8, float8, text, boolean),
  public.admin_metrics(), public.demo_reset(), public._is_my_captain(uuid),
  public.captain_zone_view(), public.captain_respond_move(uuid, boolean), public.captain_request_zone(smallint), public.captain_cancel_move(),
  public.zone_status(), public.admin_reposition_now(),
  public.set_women_riders_optin(boolean),
  public.submit_safety_feedback(uuid, int, int, int, int, text), public.submit_safety_report(uuid, text, text),
  public.review_safety_report(uuid, text, text), public.captain_safety_summary(uuid)
to authenticated;
