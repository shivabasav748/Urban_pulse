-- Privacy-safe captain availability, GPS freshness/accuracy, per-trip search radius, single-sweep lock.
-- Approved 13 Nov 2026 (Salman). Does not change existing tables' meaning; adds columns, functions and tighter RLS.

-- ================= location freshness =================
alter table public.driver_profiles
  add column location_updated_at timestamptz,
  add column location_accuracy_m numeric check (location_accuracy_m >= 0),
  add column location_source text not null default 'manual' check (location_source in ('gps', 'manual', 'simulated'));
update public.driver_profiles set location_source = 'simulated' where is_simulated;

alter table public.settings
  add column location_max_age_s int not null default 90,
  add column location_max_accuracy_m numeric not null default 100;
update public.settings set search_radius_m = 2000 where true;
alter table public.settings alter column search_radius_m set default 2000;

-- each trip keeps the radius the rider chose (2/3/5 km); dispatch honours it
alter table public.trip_groups add column search_radius_m int not null default 2000
  check (search_radius_m in (2000, 3000, 5000));

/** Eligible to be matched or counted: simulated captains are server-driven; real captains need a fresh fix,
    and a GPS fix must be accurate enough. Manual pins are allowed but must be re-asserted (heartbeat). */
create function public._location_ok(dp public.driver_profiles) returns boolean
language sql stable set search_path = '' as $$
  select dp.location_source = 'simulated'
      or (dp.location_updated_at > now() - make_interval(secs => (select s.location_max_age_s from public.settings s))
          and (dp.location_source <> 'gps' or coalesce(dp.location_accuracy_m, 1e9) <= (select s.location_max_accuracy_m from public.settings s)))
$$;

-- ================= ranking / dispatch: radius per trip + freshness =================
create or replace function public._rank(p_group uuid, p_weights jsonb default null, p_overrides jsonb default '{}',
                             p_policy text default 'urban_pulse')
returns table(driver_id uuid, name text, pickup_km numeric, pickup_min numeric, trips_today int, idle_min numeric,
              c_eta numeric, c_workload numeric, c_reliability numeric, c_idle numeric, score numeric)
language plpgsql stable security definer set search_path = '' as $$
declare s public.settings; g public.trip_groups; plat float8; plng float8;
  w_eta numeric; w_wl numeric; w_rel numeric; w_idle numeric;
begin
  select * into s from public.settings;
  select * into g from public.trip_groups where id = p_group;
  select (g.stops->0->>'lat')::float8, (g.stops->0->>'lng')::float8 into plat, plng;
  w_eta := coalesce((p_weights->>'eta')::numeric, s.w_eta);
  w_wl := coalesce((p_weights->>'workload')::numeric, s.w_workload);
  w_rel := coalesce((p_weights->>'reliability')::numeric, s.w_reliability);
  w_idle := coalesce((p_weights->>'idle')::numeric, s.w_idle);
  return query
  with c as (
    select dp.user_id, pr.display_name,
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
      and not exists (select 1 from public.trip_groups a where a.driver_id = dp.user_id
                      and a.status in ('accepted','arriving','ongoing'))
      and not exists (select 1 from public.ride_offers o where o.driver_id = dp.user_id and o.outcome = 'pending')
      and not exists (select 1 from public.ride_offers o where o.group_id = p_group and o.driver_id = dp.user_id)
  ), m as (
    select c.*, public._minutes(km, g.category) pm,
      min(public._minutes(km, g.category)) over () pm_min, max(public._minutes(km, g.category)) over () pm_max,
      min(tt) over () tt_min, max(tt) over () tt_max, min(im) over () im_min, max(im) over () im_max
    from c
  ), n as (
    select m.*,
      round(case when pm_max = pm_min then 1 else 1 - (pm - pm_min) / (pm_max - pm_min) end, 3) ce,
      round(case when tt_max = tt_min then 1 else 1 - (tt - tt_min)::numeric / (tt_max - tt_min) end, 3) cw,
      rel cr,
      round(case when im_max = im_min then 1 else (im - im_min) / (im_max - im_min) end, 3) ci
    from m
  )
  select n.user_id, n.display_name, n.km, n.pm, n.tt, n.im, n.ce, n.cw, n.cr, n.ci,
    case when p_policy = 'nearest' then round(-n.pm, 3)
         else round(w_eta*n.ce + w_wl*n.cw + w_rel*n.cr + w_idle*n.ci, 4) end
  from n order by 11 desc, n.pm asc, n.user_id asc;
end $$;

create or replace function public._dispatch(p_group uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.settings; g public.trip_groups; c record; ranking jsonb; offer_id uuid; prev text;
begin
  select * into s from public.settings;
  select * into g from public.trip_groups where id = p_group for update;
  if g.status not in ('requested') then return null; end if;
  prev := g.status;
  if g.attempt_no >= s.max_attempts then
    update public.trip_groups set status = 'no_driver_found' where id = p_group;
    perform public._event(p_group, 'no_driver_found', prev, 'no_driver_found', jsonb_build_object('reason','max_attempts'));
    perform public._sync(p_group); return null;
  end if;
  select coalesce(jsonb_agg(to_jsonb(r)), '[]') into ranking from (select * from public._rank(p_group) limit 5) r;
  for c in select * from public._rank(p_group) loop
    -- lock the candidate; skip if another transaction holds them (being dispatched to, accepting, going offline)
    perform 1 from public.driver_profiles where user_id = c.driver_id for update skip locked;
    if not found then continue; end if;
    -- revalidate under the lock: the ranking above is a snapshot and may already be stale
    if not exists (select 1 from public.driver_profiles dp where dp.user_id = c.driver_id and dp.online and public._location_ok(dp))
       or exists (select 1 from public.trip_groups a where a.driver_id = c.driver_id and a.status in ('accepted','arriving','ongoing'))
       or exists (select 1 from public.ride_offers o where o.driver_id = c.driver_id and o.outcome = 'pending') then
      continue;
    end if;
    begin
      insert into public.ride_offers(group_id, driver_id, attempt_no, score, components, summary, expires_at)
      values (p_group, c.driver_id, g.attempt_no + 1, c.score,
        jsonb_build_object('chosen', to_jsonb(c), 'ranking', ranking,
          'weights', jsonb_build_object('eta', s.w_eta, 'workload', s.w_workload, 'reliability', s.w_reliability, 'idle', s.w_idle)),
        jsonb_build_object('pickup_km', c.pickup_km, 'pickup_min', c.pickup_min, 'stops', g.stops, 'is_pool', g.is_pool,
          'fare', (select sum((r.fare->>'total')::numeric) from public.rides r join public.trip_group_members m on m.ride_id = r.id where m.group_id = p_group)),
        now() + make_interval(secs => s.offer_timeout_s))
      returning id into offer_id;
    exception when unique_violation then continue;
    end;
    update public.driver_profiles set offers_received = offers_received + 1 where user_id = c.driver_id;
    update public.trip_groups set status = 'offered', attempt_no = g.attempt_no + 1 where id = p_group;
    perform public._event(p_group, 'offer_created', prev, 'offered',
      jsonb_build_object('offer_id', offer_id, 'driver_id', c.driver_id, 'driver', c.name, 'attempt', g.attempt_no + 1,
                         'score', c.score, 'alternatives', ranking));
    perform public._sync(p_group);
    return offer_id;
  end loop;
  update public.trip_groups set status = 'no_driver_found' where id = p_group;
  perform public._event(p_group, 'no_driver_found', prev, 'no_driver_found',
    jsonb_build_object('reason', 'no_eligible_driver', 'radius_m', g.search_radius_m));
  perform public._sync(p_group);
  return null;
end $$;

-- ================= privacy-safe availability (what riders may see before a match) =================
-- Positions are snapped to a ~330 m grid BEFORE counting, so neither markers nor counts reveal an exact
-- location (moving the query circle can only ever locate a captain to a grid cell).
-- ponytail: fixed grid, not k-anonymity; a cell with one captain still shows "1 here".
create function public.nearby_availability(p_lat float8, p_lng float8, p_radius_m int default 2000) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare cell constant float8 := 0.003; res jsonb;
begin
  if auth.uid() is null then raise exception 'forbidden'; end if;
  if p_radius_m not in (2000, 3000, 5000) then raise exception 'validation: radius must be 2000, 3000 or 5000'; end if;
  with snapped as (
    select dp.vehicle_category cat,
      (floor(dp.lat / cell) + 0.5) * cell slat, (floor(dp.lng / cell) + 0.5) * cell slng
    from public.driver_profiles dp
    where dp.online and public._location_ok(dp)
      and not exists (select 1 from public.trip_groups a where a.driver_id = dp.user_id and a.status in ('accepted','arriving','ongoing'))
      and not exists (select 1 from public.ride_offers o where o.driver_id = dp.user_id and o.outcome = 'pending')
  ), near as (
    select cat, slat, slng, public._km(slat, slng, p_lat, p_lng) km from snapped
    where extensions.st_dwithin(extensions.st_setsrid(extensions.st_makepoint(slng, slat), 4326)::extensions.geography,
            extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography, p_radius_m)
  )
  select jsonb_build_object(
    'radius_m', p_radius_m, 'approximate', true, 'simulated', true,
    'categories', (select jsonb_agg(jsonb_build_object('category', c,
        'count', (select count(*) from near where cat = c),
        'pickup_eta_min', (select min(public._minutes(km, c)) from near where cat = c))
        order by array_position(array['bike','auto','cab'], c)) from unnest(array['bike','auto','cab']) c),
    'markers', coalesce((select jsonb_agg(jsonb_build_object('category', cat, 'lat', slat, 'lng', slng, 'n', n))
        from (select cat, slat, slng, count(*) n from near group by 1, 2, 3) x), '[]'::jsonb))
  into res;
  return res;
end $$;

drop function public.estimate_ride(float8, float8, float8, float8);
create function public.estimate_ride(p_lat float8, p_lng float8, d_lat float8, d_lng float8, p_radius_m int default 2000) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare km numeric := public._km(p_lat, p_lng, d_lat, d_lng); zid smallint := public._zone_of(p_lat, p_lng);
  zi jsonb; surge numeric; cats jsonb; avail jsonb := public.nearby_availability(p_lat, p_lng, p_radius_m);
begin
  select z.v into zi from jsonb_array_elements(public.zone_intelligence('base')->'zones') as z(v) where (z.v->>'zone_id')::smallint = zid;
  surge := coalesce((zi->>'smoothed')::numeric, 1);
  select jsonb_agg(jsonb_build_object('category', a->>'category',
      'trip_min', public._minutes(km, a->>'category'),
      'fare', public._fare(a->>'category', km, public._minutes(km, a->>'category'), surge),
      'drivers', (a->>'count')::int,
      'pickup_eta_min', (a->>'pickup_eta_min')::numeric))
  into cats from jsonb_array_elements(avail->'categories') a;
  return jsonb_build_object('distance_km', km, 'zone', zi, 'surge', surge, 'categories', cats,
    'radius_m', p_radius_m, 'markers', avail->'markers', 'simulated', true);
end $$;

drop function public.request_ride(text, float8, float8, text, float8, float8, text);
create function public.request_ride(p_pickup_label text, p_lat float8, p_lng float8,
  p_drop_label text, d_lat float8, d_lng float8, p_category text, p_radius_m int default 2000) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); km numeric; mins numeric; surge numeric; ride_id uuid; gid uuid; offer uuid;
begin
  if uid is null or (select role from public.profiles where id = uid) <> 'rider' then raise exception 'forbidden'; end if;
  if p_category not in ('bike','auto','cab') then raise exception 'validation: category'; end if;
  if p_radius_m not in (2000, 3000, 5000) then raise exception 'validation: radius must be 2000, 3000 or 5000'; end if;
  if exists (select 1 from public.rides where rider_id = uid and status in ('requested','offered','accepted','arriving','ongoing')) then
    raise exception 'conflict: you already have an active ride';
  end if;
  km := public._km(p_lat, p_lng, d_lat, d_lng);
  if km < 0.3 then raise exception 'validation: pickup and drop are too close'; end if;
  mins := public._minutes(km, p_category);
  surge := coalesce(public._zone_surge(public._zone_of(p_lat, p_lng)), 1);
  insert into public.rides(rider_id, pickup_label, drop_label, pickup_lat, pickup_lng, drop_lat, drop_lng, category,
    est_distance_km, est_trip_min, fare, surge)
  values (uid, p_pickup_label, p_drop_label, p_lat, p_lng, d_lat, d_lng, p_category, km, mins,
    public._fare(p_category, km, mins, surge), surge)
  returning id into ride_id;
  insert into public.trip_groups(category, stops, search_radius_m) values (p_category, jsonb_build_array(
    jsonb_build_object('ride_id', ride_id, 'type', 'pickup', 'label', p_pickup_label, 'lat', p_lat, 'lng', p_lng),
    jsonb_build_object('ride_id', ride_id, 'type', 'drop', 'label', p_drop_label, 'lat', d_lat, 'lng', d_lng)), p_radius_m)
  returning id into gid;
  insert into public.trip_group_members(group_id, ride_id) values (gid, ride_id);
  perform public._event(gid, 'ride_requested', null, 'requested', jsonb_build_object('category', p_category, 'surge', surge, 'radius_m', p_radius_m));
  offer := public._dispatch(gid);
  return jsonb_build_object('ride_id', ride_id, 'group_id', gid, 'offer_id', offer);
end $$;

-- ================= captain location updates =================
drop function public.update_location(float8, float8);
create function public.update_location(p_lat float8, p_lng float8, p_accuracy_m numeric default null, p_source text default 'gps') returns void
language plpgsql security definer set search_path = '' as $$
declare d public.driver_profiles;
begin
  if p_source not in ('gps', 'manual') then raise exception 'validation: source'; end if;
  if p_lat not between 12.7 and 13.2 or p_lng not between 77.4 and 77.9 then raise exception 'validation: outside demo area'; end if;
  if p_accuracy_m is not null and p_accuracy_m < 0 then raise exception 'validation: accuracy'; end if;
  select * into d from public.driver_profiles where user_id = auth.uid() for update;
  if not found or d.is_simulated then raise exception 'forbidden'; end if;
  -- reject teleports: two GPS fixes implying > 150 km/h (ponytail: fixed threshold, tune if real devices disagree)
  if p_source = 'gps' and d.location_source = 'gps' and d.location_updated_at > now() - interval '5 minutes'
     and public._km(d.lat, d.lng, p_lat, p_lng) / 1.35
         / greatest(extract(epoch from now() - d.location_updated_at) / 3600, 1.0 / 3600) > 150 then
    raise exception 'validation: implausible jump';
  end if;
  update public.driver_profiles set lat = p_lat, lng = p_lng, location_accuracy_m = p_accuracy_m,
    location_source = p_source, location_updated_at = now()
  where user_id = auth.uid();
end $$;

-- going offline stops sharing: the last position is no longer fresh, so it is never used or shown
create or replace function public.set_online(p_online boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- The captain's row lock is the same lock dispatch takes before offering, so "go offline" and
  -- "offer this captain a ride" cannot interleave: whichever commits first is seen by the other.
  perform 1 from public.driver_profiles where user_id = auth.uid() for update;
  if not found then raise exception 'forbidden'; end if;
  if not p_online then
    if exists (select 1 from public.trip_groups where driver_id = auth.uid() and status in ('accepted','arriving','ongoing')) then
      raise exception 'conflict: finish or cancel your current trip before going offline';
    end if;
    if exists (select 1 from public.ride_offers where driver_id = auth.uid() and outcome = 'pending') then
      raise exception 'conflict: respond to your pending ride request before going offline';
    end if;
  end if;
  update public.driver_profiles set online = p_online, idle_since = case when p_online then now() else null end,
    location_updated_at = case when p_online then location_updated_at else null end
  where user_id = auth.uid();
end $$;

-- ================= RLS: no fleet-wide coordinates for ordinary users =================
-- Precise captain rows: the captain, an admin, or the rider currently assigned to that captain (until the trip ends).
create function public._is_my_captain(p_driver uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.trip_groups g join public.trip_group_members m on m.group_id = g.id
                 join public.rides r on r.id = m.ride_id
                 where g.driver_id = p_driver and g.status in ('accepted','arriving','ongoing')
                   and r.rider_id = auth.uid() and r.status <> 'cancelled')
$$;
drop policy read_all on public.driver_profiles;
create policy own_admin_or_assigned on public.driver_profiles for select to authenticated
  using (user_id = auth.uid() or public.is_admin() or public._is_my_captain(user_id));

-- ================= single sweep at a time =================
-- Concurrent sweeps used to compete for the same expired offers and occasionally deadlock (caught, but real).
-- Transaction-scoped advisory lock: released on commit/rollback/crash; callers that lose simply skip and the
-- 3-second client timer retries. Key (727201, 1) = (urban pulse, sweep).
create or replace function public.sweep_exceptions() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.settings; o record; g record; n_timeout int := 0; n_delay int := 0; n_auto int := 0; errs jsonb := '[]';
begin
  if auth.uid() is null then raise exception 'forbidden'; end if;
  if not pg_catalog.pg_try_advisory_xact_lock(727201, 1) then
    return jsonb_build_object('timeouts', 0, 'delays', 0, 'auto', 0, 'errors', '[]'::jsonb, 'skipped', true, 'reason', 'sweep_in_progress');
  end if;
  select * into s from public.settings;
  for o in select id from public.ride_offers where outcome = 'pending' and expires_at < now() loop
    begin perform public._fail_offer(o.id, 'no_response'); n_timeout := n_timeout + 1;
    exception when others then errs := errs || jsonb_build_object('step', 'timeout', 'id', o.id, 'error', sqlerrm); end;
  end loop;
  for g in select id from public.trip_groups tg where status = 'arriving'
      and now() - arriving_at > make_interval(mins => 1) * (coalesce((select max(est_pickup_min) from public.rides r
          join public.trip_group_members m on m.ride_id = r.id where m.group_id = tg.id), 5) + s.delay_threshold_min)
      and not (select is_simulated from public.driver_profiles where user_id = tg.driver_id) loop
    begin perform public._release(g.id, 'arrival_delayed'); n_delay := n_delay + 1;
    exception when others then errs := errs || jsonb_build_object('step', 'delay', 'id', g.id, 'error', sqlerrm); end;
  end loop;
  if s.fast_demo then
    for o in select ro.id from public.ride_offers ro join public.driver_profiles dp on dp.user_id = ro.driver_id
             where ro.outcome = 'pending' and dp.is_simulated and now() - ro.offered_at > make_interval(secs => s.auto_accept_s) loop
      begin perform public._accept_offer(o.id); n_auto := n_auto + 1;
      exception when others then errs := errs || jsonb_build_object('step', 'auto_accept', 'id', o.id, 'error', sqlerrm); end;
    end loop;
    for g in select tg.id from public.trip_groups tg join public.driver_profiles dp on dp.user_id = tg.driver_id
             where dp.is_simulated and tg.status in ('accepted','arriving','ongoing')
               and now() - greatest(tg.accepted_at, coalesce(tg.arriving_at, tg.accepted_at), coalesce(tg.started_at, tg.accepted_at)) > interval '6 seconds' loop
      begin
        perform 1 from public.trip_groups where id = g.id for update;
        perform public._advance(g.id, case (select status from public.trip_groups where id = g.id)
          when 'accepted' then 'arriving' when 'arriving' then 'ongoing' when 'ongoing' then 'completed' end);
        n_auto := n_auto + 1;
      exception when others then errs := errs || jsonb_build_object('step', 'auto_advance', 'id', g.id, 'error', sqlerrm); end;
    end loop;
  end if;
  return jsonb_build_object('timeouts', n_timeout, 'delays', n_delay, 'auto', n_auto, 'errors', errs, 'skipped', false);
end $$;

-- ================= grants =================
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_admin(), public.zone_intelligence(text),
  public.nearby_availability(float8, float8, int),
  public.estimate_ride(float8, float8, float8, float8, int),
  public.request_ride(text, float8, float8, text, float8, float8, text, int),
  public.respond_offer(uuid, boolean), public.advance_trip(uuid, text), public.driver_cancel(uuid), public.cancel_ride(uuid),
  public.set_online(boolean), public.update_location(float8, float8, numeric, text), public.sweep_exceptions(),
  public.chaos_inject(uuid, text), public.rerank_preview(uuid, jsonb, jsonb, text), public.update_settings(jsonb),
  public.apply_repositioning(text), public.create_pool(uuid[], jsonb, jsonb),
  public.demo_request(uuid, text, float8, float8, text, float8, float8, text, boolean),
  public.admin_metrics(), public.demo_reset()
to authenticated;
-- nearby_drivers (exact coordinates) is now internal only: not in the grant list above.
