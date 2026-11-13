-- 0009: reality audit (13 Nov 2026). Forward-only; no data is changed except new settings columns.
--   1. Fare model v2: no per-minute journey charge; cab = Karnataka aggregator city-taxi band 1 (Rs 100 for 4 km + Rs 24/km,
--      +10% 00:00-06:00, 5% GST, as reported for the Feb 2024 state order; primary notification not retrieved); auto and bike
--      are ILLUSTRATIVE (Belagavi auto tariff not verified; bike taxis not permitted without RTA permits). Surge is OFF
--      unless settings.surge_enabled, and then capped at settings.surge_cap (2x, MoRTH Aggregator Guidelines 2025).
--      Mirrored exactly in src/lib/geo.ts (fare). Existing rides keep the fare stored at booking.
--   2. _rank: shortlist the nearest N (default 8) candidates before normalising scores.
--   3. _reposition_tick: donor captains must reach the target within reposition_max_move_min (default 15).

alter table public.settings
  add column surge_enabled boolean not null default false,
  add column rank_shortlist int not null default 8 check (rank_shortlist between 1 and 50),
  add column reposition_max_move_min int not null default 15 check (reposition_max_move_min between 1 and 60);

create or replace function public._fare(cat text, km numeric, mins numeric, surge numeric) returns jsonb
language sql stable set search_path = '' as $$
  with p(base, incl, per_km, night_pct, gst_pct, tariff) as (
    select b, i, k, n, g, t from (values
      ('bike', 20, 1.5, 6, 0, 0, 'illustrative-simulated-service'),
      ('auto', 30, 1.5, 15, 0, 0, 'illustrative-not-notified'),
      ('cab', 100, 4.0, 24, 10, 5, 'karnataka-aggregator-cab-band1-2024')) v(c, b, i, k, n, g, t) where c = cat
  ), st as (
    select extract(hour from s.sim_clock at time zone 'Asia/Kolkata') < 6 night,
           case when s.surge_enabled then least(greatest(coalesce(surge, 1), 1), s.surge_cap) else 1 end mult
    from public.settings s
  ), f as (
    select p.*, st.mult, round(p.per_km * greatest(km - p.incl, 0)) dist from p, st
  ), f2 as (
    select f.*, case when (select night from st) then round((f.base + f.dist) * f.night_pct / 100.0) else 0 end nt from f
  ), f3 as (
    select f2.*, round((f2.base + f2.dist + f2.nt) * f2.mult) pre from f2
  )
  select jsonb_build_object('base', base, 'included_km', incl, 'per_km', per_km, 'per_min', 0, 'distance', dist, 'time', 0,
    'night', nt, 'surge_mult', mult, 'gst', round(pre * gst_pct / 100.0), 'total', pre + round(pre * gst_pct / 100.0), 'tariff', tariff)
  from f3
$$;

create or replace function public._rank(p_group uuid, p_weights jsonb default null, p_overrides jsonb default '{}', p_policy text default null)
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
  ), cs as (
    -- shortlist the nearest candidates before normalising (Arena study: with a wide spread, normalised ETA stops
    -- discriminating and workload/idle pull captains from far away; 250-captain fleet: pickup wait 4.65 -> 2.33 min)
    select c.* from c order by c.km, c.user_id limit coalesce(s.rank_shortlist, 8)
  ), m as (
    select c.*, coalesce(zb.slack, 0) sl, public._minutes(c.km, g.category) pm,
      min(public._minutes(c.km, g.category)) over () pm_min, max(public._minutes(c.km, g.category)) over () pm_max,
      min(c.tt) over () tt_min, max(c.tt) over () tt_max, min(c.im) over () im_min, max(c.im) over () im_max,
      min(coalesce(zb.slack, 0)) over () sl_min, max(coalesce(zb.slack, 0)) over () sl_max
    from cs c left join zb on zb.zb_id = c.zid
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

create or replace function public._reposition_tick(p_force boolean default false) returns jsonb
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
    for m in select mv.driver_id, dp.lat, dp.lng, zn.lat tlat, zn.lng tlng from public.reposition_moves mv
             join public.driver_profiles dp on dp.user_id = mv.driver_id join public.zones zn on zn.id = mv.to_zone
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
        -- the 30-min forecast must still apply on arrival (Arena: unnecessary switches -59%, moves -45%)
        and public._minutes(public._km(dp.lat, dp.lng, z.lat, z.lng), dp.vehicle_category) <= s.reposition_max_move_min
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
    surge_enabled = coalesce((p->>'surge_enabled')::boolean, surge_enabled),
    rank_shortlist = coalesce((p->>'rank_shortlist')::int, rank_shortlist),
    reposition_max_move_min = coalesce((p->>'reposition_max_move_min')::int, reposition_max_move_min),
    sim_clock = coalesce((p->>'sim_clock')::timestamptz, sim_clock)
  where id;
end $$;

-- function signatures are unchanged, so existing grants still apply; re-assert the internal helpers stay private
revoke execute on function public._fare(text, numeric, numeric, numeric), public._rank(uuid, jsonb, jsonb, text),
  public._reposition_tick(boolean) from public, anon, authenticated;
