-- 0008: fix for 0007. In _reposition_tick the table alias "z" in the simulated-driving query collided with the
-- PL/pgSQL record variable "z" ("record z is not assigned yet"), so every fast-demo sweep skipped repositioning
-- (the error was caught and reported in the sweep result). Found by e2e. Only the alias changes (z -> zn).

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
