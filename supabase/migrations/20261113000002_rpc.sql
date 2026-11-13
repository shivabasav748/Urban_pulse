-- Urban Pulse RPCs. Identity from auth.uid(); internal helpers (_*) are never granted to clients.
-- Lock order everywhere: trip_groups -> driver_profiles -> ride_offers.

-- ================= pure helpers =================
create function public._km(lat1 float8, lng1 float8, lat2 float8, lng2 float8) returns numeric
language sql immutable set search_path = '' as $$
  select round((extensions.st_distance(
    extensions.st_setsrid(extensions.st_makepoint(lng1, lat1), 4326)::extensions.geography,
    extensions.st_setsrid(extensions.st_makepoint(lng2, lat2), 4326)::extensions.geography) / 1000.0 * 1.35)::numeric, 3)
$$; -- road distance estimate = great-circle x 1.35 (SIMULATED routing)

create function public._speed_kmh(cat text, at timestamptz) returns numeric
language sql stable set search_path = '' as $$
  select (case when extract(hour from at at time zone 'Asia/Kolkata') between 8 and 10
                 or extract(hour from at at time zone 'Asia/Kolkata') between 17 and 20 then 18 else 26 end)
         * (case when cat = 'bike' then 1.15 else 1 end)
$$;

create function public._minutes(km numeric, cat text) returns numeric
language sql stable set search_path = '' as $$
  select round(km / public._speed_kmh(cat, (select sim_clock from public.settings)) * 60, 1)
$$;

create function public._zone_of(p_lat float8, p_lng float8) returns smallint
language sql stable set search_path = '' as $$
  select z.id from public.zones z order by (z.lat - p_lat)^2 + ((z.lng - p_lng) * cos(radians(p_lat)))^2 limit 1
$$;

create function public._fare(cat text, km numeric, mins numeric, surge numeric) returns jsonb
language sql immutable set search_path = '' as $$
  with p(base, per_km, per_min) as (
    select b, k, m from (values ('bike',20,6,1.0), ('auto',30,11,1.5), ('cab',50,15,2.0)) v(c,b,k,m) where c = cat
  ), f as (select base, round(per_km*km) dist, round(per_min*mins) tm from p)
  select jsonb_build_object('base', base, 'distance', dist, 'time', tm, 'surge_mult', surge,
         'total', round((base + dist + tm) * surge)) from f
$$;

-- ================= zone intelligence (feature B) =================
-- raw = clamp(1 + 0.15*max(0, forecast/max(supply,1) - 1), 1, cap); smoothed = a*raw + (1-a)*raw_prev_bucket
create function public.zone_intelligence(p_scenario text default 'base') returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s public.settings; t timestamptz; out_zones jsonb; moves jsonb := '[]';
  z record; d record; need int;
begin
  select * into s from public.settings;
  -- forecasts are in 30-min buckets; snap sim clock to the bucket
  t := to_timestamp(floor(extract(epoch from s.sim_clock) / 1800) * 1800);
  create temp table if not exists _zi(zone_id smallint, name text, kind text, lat float8, lng float8,
    forecast numeric, actual numeric, base_forecast numeric, supply int, gap numeric,
    raw numeric, raw_prev numeric, smoothed numeric, risk text) on commit drop;
  truncate _zi;
  insert into _zi
  select zn.id, zn.name, zn.kind, zn.lat, zn.lng, coalesce(f.predicted, 0), f.actual, coalesce(b.predicted, 0),
         coalesce(sp.n, 0), 0, 1, 1, 1, 'low'
  from public.zones zn
  left join public.demand_forecasts f on f.zone_id = zn.id and f.target_ts = t and f.scenario = p_scenario
  left join public.demand_forecasts b on b.zone_id = zn.id and b.target_ts = t and b.scenario = 'base'
  left join (select public._zone_of(dp.lat, dp.lng) zid, count(*)::int n from public.driver_profiles dp
             where dp.online and not exists (select 1 from public.trip_groups g where g.driver_id = dp.user_id
               and g.status in ('accepted','arriving','ongoing')) group by 1) sp on sp.zid = zn.id;
  update _zi set
    gap = round(forecast - supply, 2),
    raw = least(greatest(1 + 0.15 * greatest(0, forecast / greatest(supply, 1) - 1), 1), s.surge_cap),
    raw_prev = least(greatest(1 + 0.15 * greatest(0, coalesce((select pf.predicted from public.demand_forecasts pf
        where pf.zone_id = _zi.zone_id and pf.target_ts = t - interval '30 min' and pf.scenario = p_scenario), forecast)
        / greatest(supply, 1) - 1), 1), s.surge_cap);
  update _zi set smoothed = round(s.surge_alpha * raw + (1 - s.surge_alpha) * raw_prev, 3),
                 raw = round(raw, 3), raw_prev = round(raw_prev, 3),
                 risk = case when forecast > 2 * greatest(supply,1) then 'high'
                             when forecast > greatest(supply,1) then 'medium' else 'low' end;

  -- greedy repositioning: biggest gap first, nearest idle driver from a surplus zone
  create temp table if not exists _pool(driver_id uuid, zone_id smallint, lat float8, lng float8, used bool) on commit drop;
  truncate _pool;
  insert into _pool select dp.user_id, public._zone_of(dp.lat, dp.lng), dp.lat, dp.lng, false
    from public.driver_profiles dp
    where dp.online and not exists (select 1 from public.trip_groups g where g.driver_id = dp.user_id
      and g.status in ('accepted','arriving','ongoing'))
      and not exists (select 1 from public.ride_offers o where o.driver_id = dp.user_id and o.outcome = 'pending');
  for z in select * from _zi where gap >= 1 order by gap desc loop
    need := floor(z.gap);
    for d in select p.driver_id, p.zone_id, public._km(p.lat, p.lng, z.lat, z.lng) km
             from _pool p join _zi src on src.zone_id = p.zone_id
             where not p.used and src.supply - ceil(src.forecast) > 0
               and (select count(*) from _pool q where q.zone_id = p.zone_id and q.used) < src.supply - ceil(src.forecast)
             order by 3 limit need loop
      update _pool set used = true where driver_id = d.driver_id;
      moves := moves || jsonb_build_object('driver_id', d.driver_id, 'from_zone', d.zone_id,
               'to_zone', z.zone_id, 'km', d.km,
               'reason', format('%s forecast %s vs %s idle drivers', z.name, z.forecast, z.supply));
    end loop;
  end loop;

  select jsonb_agg(to_jsonb(_zi) order by zone_id) into out_zones from _zi;
  return jsonb_build_object('sim_clock', t, 'scenario', p_scenario, 'cap', s.surge_cap, 'alpha', s.surge_alpha,
    'formula', 'raw = clamp(1 + 0.15*max(0, forecast/max(supply,1) - 1), 1, cap); smoothed = alpha*raw + (1-alpha)*raw_prev_bucket',
    'zones', out_zones, 'moves', moves, 'simulated', true);
end $$;

create function public._zone_surge(zid smallint) returns numeric
language sql volatile security definer set search_path = '' as $$
  select (z.v->>'smoothed')::numeric from jsonb_array_elements(public.zone_intelligence('base')->'zones') as z(v)
  where (z.v->>'zone_id')::smallint = zid
$$;

-- ================= ranking (feature D) =================
-- Shared by dispatch() and rerank_preview(). Components normalised over the candidate set:
-- eta = 1 - norm(pickup_min) (closer is better), workload = 1 - norm(trips_today) (fewer is better),
-- reliability = (accepted+4)/(received+5) (Bayesian prior 0.8), idle = norm(idle_min) (waited longer is better).
create function public._rank(p_group uuid, p_weights jsonb default null, p_overrides jsonb default '{}',
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
      and dp.vehicle_category = g.category
      and extensions.st_dwithin(dp.location,
            extensions.st_setsrid(extensions.st_makepoint(plng, plat), 4326)::extensions.geography, s.search_radius_m)
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

-- ================= events / sync =================
create function public._event(p_group uuid, p_type text, p_from text, p_to text, p_payload jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into public.ride_events(group_id, ride_id, actor, type, from_status, to_status, payload)
  select p_group, m.ride_id, auth.uid(), p_type, p_from, p_to, p_payload
  from public.trip_group_members m where m.group_id = p_group
$$;

-- mirror group state onto its passenger rides
create function public._sync(p_group uuid) returns void language sql security definer set search_path = '' as $$
  update public.rides r set status = g.status, driver_id = g.driver_id, attempt_no = g.attempt_no,
    accepted_at = g.accepted_at, arriving_at = g.arriving_at, started_at = g.started_at, completed_at = g.completed_at,
    est_pickup_min = coalesce((select (o.summary->>'pickup_min')::numeric from public.ride_offers o
      where o.group_id = g.id and o.outcome in ('pending','accepted') order by o.attempt_no desc limit 1), r.est_pickup_min)
  from public.trip_groups g, public.trip_group_members m
  where g.id = p_group and m.group_id = g.id and r.id = m.ride_id and r.status not in ('cancelled')
$$;

-- ================= dispatch (features D + E) =================
create function public._dispatch(p_group uuid) returns uuid
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
    -- lock the candidate; skip if someone else is dispatching to them right now
    perform 1 from public.driver_profiles where user_id = c.driver_id for update skip locked;
    if not found then continue; end if;
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
  perform public._event(p_group, 'no_driver_found', prev, 'no_driver_found', jsonb_build_object('reason','no_eligible_driver'));
  perform public._sync(p_group);
  return null;
end $$;

-- close a pending offer with a failure outcome, exclude driver, re-dispatch
create function public._fail_offer(p_offer uuid, p_outcome text) returns uuid
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
    jsonb_build_object('offer_id', p_offer, 'driver_id', o.driver_id, 'excluded', true, 'attempt', o.attempt_no));
  return public._dispatch(o.group_id);
end $$;

create function public._accept_offer(p_offer uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.ride_offers;
begin
  select * into o from public.ride_offers where id = p_offer;
  perform 1 from public.trip_groups where id = o.group_id for update;
  perform 1 from public.driver_profiles where user_id = o.driver_id for update;
  select * into o from public.ride_offers where id = p_offer for update;
  if o.outcome <> 'pending' then raise exception 'conflict: offer already %', o.outcome; end if;
  if o.expires_at < now() then  -- too late: treat as no response and reassign (no raise, or the reassignment rolls back)
    perform public._fail_offer(p_offer, 'no_response'); return;
  end if;
  update public.ride_offers set outcome = 'accepted', responded_at = now() where id = p_offer;
  update public.trip_groups set status = 'accepted', driver_id = o.driver_id, accepted_at = now() where id = o.group_id;
  update public.driver_profiles set offers_accepted = offers_accepted + 1, idle_since = null where user_id = o.driver_id;
  perform public._event(o.group_id, 'offer_accepted', 'offered', 'accepted',
    jsonb_build_object('offer_id', p_offer, 'driver_id', o.driver_id, 'attempt', o.attempt_no));
  perform public._sync(o.group_id);
end $$;

-- driver drops an accepted/arriving trip (cancel or delay): free driver, back to requested, re-dispatch
create function public._release(p_group uuid, p_type text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare g public.trip_groups;
begin
  select * into g from public.trip_groups where id = p_group for update;
  if g.status not in ('accepted','arriving') then raise exception 'invalid_transition: % from %', p_type, g.status; end if;
  update public.driver_profiles set idle_since = now() where user_id = g.driver_id;
  update public.trip_groups set status = 'requested', driver_id = null, accepted_at = null, arriving_at = null where id = p_group;
  perform public._event(p_group, p_type, g.status, 'requested', jsonb_build_object('driver_id', g.driver_id, 'excluded', true));
  perform public._sync(p_group);
  return public._dispatch(p_group);
end $$;

create function public._advance(p_group uuid, p_to text) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.trip_groups;
begin
  select * into g from public.trip_groups where id = p_group for update;
  if not exists (select 1 from public.ride_transitions where from_status = g.status and to_status = p_to and actor_role = 'driver') then
    raise exception 'invalid_transition: % -> %', g.status, p_to;
  end if;
  update public.trip_groups set status = p_to,
    arriving_at = case when p_to = 'arriving' then now() else arriving_at end,
    started_at = case when p_to = 'ongoing' then now() else started_at end,
    completed_at = case when p_to = 'completed' then now() else completed_at end
  where id = p_group;
  if p_to = 'completed' then
    update public.driver_profiles dp set trips_today = trips_today + 1, idle_since = now(),
      lat = (g.stops->-1->>'lat')::float8, lng = (g.stops->-1->>'lng')::float8
    where user_id = g.driver_id;
  end if;
  perform public._event(p_group, 'status_' || p_to, g.status, p_to);
  perform public._sync(p_group);
end $$;

-- ================= public RPCs =================
create function public.nearby_drivers(p_lat float8, p_lng float8, p_radius_m int default 6000, p_category text default null)
returns table(driver_id uuid, name text, category text, lat float8, lng float8, distance_km numeric, pickup_eta_min numeric, busy boolean)
language sql stable security definer set search_path = '' as $$
  select dp.user_id, p.display_name, dp.vehicle_category, dp.lat, dp.lng,
    public._km(dp.lat, dp.lng, p_lat, p_lng), public._minutes(public._km(dp.lat, dp.lng, p_lat, p_lng), dp.vehicle_category),
    exists (select 1 from public.trip_groups g where g.driver_id = dp.user_id and g.status in ('accepted','arriving','ongoing'))
  from public.driver_profiles dp join public.profiles p on p.id = dp.user_id
  where dp.online and (p_category is null or dp.vehicle_category = p_category)
    and extensions.st_dwithin(dp.location, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography, p_radius_m)
  order by 6
$$;

create function public.estimate_ride(p_lat float8, p_lng float8, d_lat float8, d_lng float8) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare km numeric := public._km(p_lat, p_lng, d_lat, d_lng); zid smallint := public._zone_of(p_lat, p_lng);
  zi jsonb; surge numeric; cats jsonb;
begin
  select z.v into zi from jsonb_array_elements(public.zone_intelligence('base')->'zones') as z(v) where (z.v->>'zone_id')::smallint = zid;
  surge := coalesce((zi->>'smoothed')::numeric, 1);
  select jsonb_agg(jsonb_build_object('category', c,
      'trip_min', public._minutes(km, c),
      'fare', public._fare(c, km, public._minutes(km, c), surge),
      'drivers', (select count(*) from public.nearby_drivers(p_lat, p_lng, 6000, c) n where not n.busy),
      'pickup_eta_min', (select min(n.pickup_eta_min) from public.nearby_drivers(p_lat, p_lng, 6000, c) n where not n.busy))
    order by array_position(array['bike','auto','cab'], c))
  into cats from unnest(array['bike','auto','cab']) c;
  return jsonb_build_object('distance_km', km, 'zone', zi, 'surge', surge, 'categories', cats, 'simulated', true);
end $$;

create function public.request_ride(p_pickup_label text, p_lat float8, p_lng float8,
  p_drop_label text, d_lat float8, d_lng float8, p_category text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); km numeric; mins numeric; surge numeric; ride_id uuid; gid uuid; offer uuid;
begin
  if uid is null or (select role from public.profiles where id = uid) <> 'rider' then raise exception 'forbidden'; end if;
  if p_category not in ('bike','auto','cab') then raise exception 'validation: category'; end if;
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
  insert into public.trip_groups(category, stops) values (p_category, jsonb_build_array(
    jsonb_build_object('ride_id', ride_id, 'type', 'pickup', 'label', p_pickup_label, 'lat', p_lat, 'lng', p_lng),
    jsonb_build_object('ride_id', ride_id, 'type', 'drop', 'label', p_drop_label, 'lat', d_lat, 'lng', d_lng)))
  returning id into gid;
  insert into public.trip_group_members(group_id, ride_id) values (gid, ride_id);
  perform public._event(gid, 'ride_requested', null, 'requested', jsonb_build_object('category', p_category, 'surge', surge));
  offer := public._dispatch(gid);
  return jsonb_build_object('ride_id', ride_id, 'group_id', gid, 'offer_id', offer);
end $$;

create function public.respond_offer(p_offer uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.ride_offers where id = p_offer and driver_id = auth.uid()) then raise exception 'forbidden'; end if;
  if p_accept then perform public._accept_offer(p_offer); else perform public._fail_offer(p_offer, 'rejected'); end if;
end $$;

create function public.advance_trip(p_group uuid, p_to text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.trip_groups where id = p_group and driver_id = auth.uid()) then raise exception 'forbidden'; end if;
  perform public._advance(p_group, p_to);
end $$;

create function public.driver_cancel(p_group uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.trip_groups where id = p_group and driver_id = auth.uid()) then raise exception 'forbidden'; end if;
  perform public._release(p_group, 'driver_cancelled');
end $$;

create function public.cancel_ride(p_ride uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rides; gid uuid; g public.trip_groups;
begin
  select * into r from public.rides where id = p_ride and rider_id = auth.uid();
  if not found then raise exception 'forbidden'; end if;
  select group_id into gid from public.trip_group_members where ride_id = p_ride;
  select * into g from public.trip_groups where id = gid for update;
  if g.status not in ('requested','offered','accepted','arriving') then raise exception 'invalid_transition: cannot cancel when %', g.status; end if;
  update public.rides set status = 'cancelled', cancelled_at = now() where id = p_ride;
  perform public._event(gid, 'rider_cancelled', g.status, 'cancelled');
  if (select count(*) from public.trip_group_members m join public.rides x on x.id = m.ride_id
      where m.group_id = gid and x.status <> 'cancelled') = 0 then
    update public.ride_offers set outcome = 'cancelled', responded_at = now() where group_id = gid and outcome = 'pending';
    update public.trip_groups set status = 'cancelled' where id = gid;
    if g.driver_id is not null then update public.driver_profiles set idle_since = now() where user_id = g.driver_id; end if;
  end if;
end $$;

create function public.set_online(p_online boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.driver_profiles set online = p_online, idle_since = case when p_online then now() else null end
  where user_id = auth.uid();
  if not found then raise exception 'forbidden'; end if;
end $$;

create function public.update_location(p_lat float8, p_lng float8) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_lat not between 12.7 and 13.2 or p_lng not between 77.4 and 77.9 then raise exception 'validation: outside demo area'; end if;
  update public.driver_profiles set lat = p_lat, lng = p_lng where user_id = auth.uid();
  if not found then raise exception 'forbidden'; end if;
end $$;

-- Idempotent; safe for any signed-in client to call on a timer. All clocks are checked server-side.
create function public.sweep_exceptions() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.settings; o record; g record; n_timeout int := 0; n_delay int := 0; n_auto int := 0;
begin
  if auth.uid() is null then raise exception 'forbidden'; end if;
  select * into s from public.settings;
  for o in select id from public.ride_offers where outcome = 'pending' and expires_at < now() loop
    perform public._fail_offer(o.id, 'no_response'); n_timeout := n_timeout + 1;
  end loop;
  for g in select id from public.trip_groups tg where status = 'arriving'
      and now() - arriving_at > make_interval(mins => 1) * (coalesce((select max(est_pickup_min) from public.rides r
          join public.trip_group_members m on m.ride_id = r.id where m.group_id = tg.id), 5) + s.delay_threshold_min)
      and not (select is_simulated from public.driver_profiles where user_id = tg.driver_id) loop
    perform public._release(g.id, 'arrival_delayed'); n_delay := n_delay + 1;
  end loop;
  -- fast demo: SIMULATED drivers respond and drive on their own
  if s.fast_demo then
    for o in select ro.id from public.ride_offers ro join public.driver_profiles dp on dp.user_id = ro.driver_id
             where ro.outcome = 'pending' and dp.is_simulated and now() - ro.offered_at > interval '4 seconds' loop
      perform public._accept_offer(o.id); n_auto := n_auto + 1;
    end loop;
    for g in select tg.id, tg.status from public.trip_groups tg join public.driver_profiles dp on dp.user_id = tg.driver_id
             where dp.is_simulated and tg.status in ('accepted','arriving','ongoing')
               and now() - greatest(tg.accepted_at, coalesce(tg.arriving_at, tg.accepted_at), coalesce(tg.started_at, tg.accepted_at)) > interval '6 seconds' loop
      perform public._advance(g.id, case g.status when 'accepted' then 'arriving' when 'arriving' then 'ongoing' else 'completed' end);
      n_auto := n_auto + 1;
    end loop;
  end if;
  return jsonb_build_object('timeouts', n_timeout, 'delays', n_delay, 'auto', n_auto);
end $$;

-- ================= judge / admin =================
create function public._require_admin() returns void language plpgsql stable security definer set search_path = '' as $$
begin if not public.is_admin() then raise exception 'forbidden'; end if; end $$;

-- Chaos Mode: runs the same internal paths as real events
create function public.chaos_inject(p_group uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.trip_groups; o public.ride_offers; t0 timestamptz := clock_timestamp(); new_offer uuid; excluded uuid;
begin
  perform public._require_admin();
  select * into g from public.trip_groups where id = p_group;
  if p_kind in ('reject','no_response') then
    select * into o from public.ride_offers where group_id = p_group and outcome = 'pending';
    if not found then raise exception 'invalid_transition: no pending offer'; end if;
    excluded := o.driver_id;
    new_offer := public._fail_offer(o.id, case p_kind when 'reject' then 'rejected' else 'no_response' end);
  elsif p_kind in ('driver_cancel','delay') then
    excluded := g.driver_id;
    if p_kind = 'delay' and g.status <> 'arriving' then raise exception 'invalid_transition: delay needs arriving'; end if;
    new_offer := public._release(p_group, case p_kind when 'delay' then 'arrival_delayed' else 'driver_cancelled' end);
  else raise exception 'validation: kind';
  end if;
  return jsonb_build_object('exception', p_kind, 'exception_at', t0, 'excluded_driver', excluded,
    'next_offer', (select to_jsonb(x) from (select id, driver_id, attempt_no, score from public.ride_offers where id = new_offer) x),
    'status', (select status from public.trip_groups where id = p_group));
end $$;

create function public.rerank_preview(p_group uuid, p_weights jsonb default null, p_overrides jsonb default '{}',
  p_policy text default 'urban_pulse') returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_admin();
  return query select to_jsonb(r) from public._rank(p_group, p_weights, p_overrides, p_policy) r;
end $$;

create function public.update_settings(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_admin();
  update public.settings set
    w_eta = coalesce((p->>'w_eta')::numeric, w_eta), w_workload = coalesce((p->>'w_workload')::numeric, w_workload),
    w_reliability = coalesce((p->>'w_reliability')::numeric, w_reliability), w_idle = coalesce((p->>'w_idle')::numeric, w_idle),
    offer_timeout_s = coalesce((p->>'offer_timeout_s')::int, offer_timeout_s),
    fast_demo = coalesce((p->>'fast_demo')::boolean, fast_demo),
    surge_cap = coalesce((p->>'surge_cap')::numeric, surge_cap),
    sim_clock = coalesce((p->>'sim_clock')::timestamptz, sim_clock);
end $$;

create function public.apply_repositioning(p_scenario text default 'base') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare mv jsonb := public.zone_intelligence(p_scenario)->'moves'; m jsonb;
begin
  perform public._require_admin();
  for m in select * from jsonb_array_elements(mv) loop
    update public.driver_profiles dp set
      lat = z.lat + (random() - 0.5) * 0.01, lng = z.lng + (random() - 0.5) * 0.01
    from public.zones z where z.id = (m->>'to_zone')::smallint and dp.user_id = (m->>'driver_id')::uuid and dp.is_simulated;
  end loop;
  return mv;
end $$;

-- Pooling (feature C): client computes order with src/lib/pooling.ts; server re-validates and merges
create function public.create_pool(p_rides uuid[], p_stops jsonb, p_detours jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.settings; a public.rides; b public.rides; gid uuid; r uuid; old uuid;
begin
  perform public._require_admin();
  select * into s from public.settings;
  if array_length(p_rides, 1) <> 2 then raise exception 'validation: pool exactly 2 rides'; end if;
  select * into a from public.rides where id = p_rides[1] for update;
  select * into b from public.rides where id = p_rides[2] for update;
  if a.status not in ('requested','offered','no_driver_found') or b.status not in ('requested','offered','no_driver_found') then
    raise exception 'invalid_transition: rides already assigned';
  end if;
  if public._km(a.pickup_lat, a.pickup_lng, b.pickup_lat, b.pickup_lng) > 1.5 * 1.35
     or public._km(a.drop_lat, a.drop_lng, b.drop_lat, b.drop_lng) > 2.5 * 1.35 then
    raise exception 'validation: rides not compatible';
  end if;
  if exists (select 1 from jsonb_each_text(p_detours) d where d.value::numeric > s.pool_max_detour_pct) then
    raise exception 'validation: detour above limit';
  end if;
  insert into public.trip_groups(category, stops, is_pool) values ('cab', p_stops, true) returning id into gid;
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

-- demo helper: create a ride for a seeded rider (judge needs compatible requests for pooling / chaos)
create function public.demo_request(p_rider uuid, p_pickup_label text, p_lat float8, p_lng float8,
  p_drop_label text, d_lat float8, d_lng float8, p_category text default 'cab', p_dispatch boolean default true) returns uuid
language plpgsql security definer set search_path = '' as $$
declare km numeric; mins numeric; ride_id uuid; gid uuid;
begin
  perform public._require_admin();
  km := public._km(p_lat, p_lng, d_lat, d_lng); mins := public._minutes(km, p_category);
  insert into public.rides(rider_id, pickup_label, drop_label, pickup_lat, pickup_lng, drop_lat, drop_lng, category,
    est_distance_km, est_trip_min, fare, surge)
  values (p_rider, p_pickup_label, p_drop_label, p_lat, p_lng, d_lat, d_lng, p_category, km, mins,
    public._fare(p_category, km, mins, 1), 1) returning id into ride_id;
  insert into public.trip_groups(category, stops) values (p_category, jsonb_build_array(
    jsonb_build_object('ride_id', ride_id, 'type', 'pickup', 'label', p_pickup_label, 'lat', p_lat, 'lng', p_lng),
    jsonb_build_object('ride_id', ride_id, 'type', 'drop', 'label', p_drop_label, 'lat', d_lat, 'lng', d_lng))) returning id into gid;
  insert into public.trip_group_members(group_id, ride_id) values (gid, ride_id);
  perform public._event(gid, 'ride_requested', null, 'requested', jsonb_build_object('demo', true));
  if p_dispatch then perform public._dispatch(gid); end if;
  return ride_id;
end $$;

create function public.admin_metrics() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  perform public._require_admin();
  with r as (select * from public.rides where requested_at > now() - interval '24 hours')
  select jsonb_build_object(
    'window', '24h, live rides (not Arena)',
    'requested', (select count(*) from r),
    'completed', (select count(*) from r where status = 'completed'),
    'cancelled', (select count(*) from r where status = 'cancelled'),
    'no_driver_found', (select count(*) from r where status = 'no_driver_found'),
    'completion_rate', (select round(count(*) filter (where status = 'completed')::numeric
        / nullif(count(*) filter (where status in ('completed','no_driver_found') or (status = 'cancelled' and accepted_at is not null)), 0), 3) from r),
    'avg_match_wait_s', (select round(avg(extract(epoch from accepted_at - requested_at))) from r where accepted_at is not null),
    'avg_pickup_wait_s', (select round(avg(extract(epoch from started_at - requested_at))) from r where started_at is not null),
    'avg_pickup_eta_err_s', (select round(avg(abs(extract(epoch from started_at - accepted_at) - est_pickup_min * 60)))
        from r where started_at is not null and est_pickup_min is not null),
    'reassignments', (select count(*) from public.ride_events e join r on r.id = e.ride_id
        where e.type in ('offer_rejected','offer_no_response','driver_cancelled','arrival_delayed')),
    'drivers', (select jsonb_agg(jsonb_build_object('driver_id', dp.user_id, 'name', p.display_name,
        'trips_today', dp.trips_today, 'online', dp.online,
        'busy_min_24h', coalesce((select round(sum(extract(epoch from coalesce(g.completed_at, now()) - g.accepted_at)) / 60, 1)
           from public.trip_groups g where g.driver_id = dp.user_id and g.accepted_at > now() - interval '24 hours'), 0),
        'acceptance', round((dp.offers_accepted + 4)::numeric / (dp.offers_received + 5), 3)) order by dp.trips_today desc)
      from public.driver_profiles dp join public.profiles p on p.id = dp.user_id)
  ) into res;
  return res;
end $$;

create function public.demo_reset() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_admin();
  delete from public.ride_events; delete from public.ride_offers; delete from public.trip_group_members;
  delete from public.trip_groups; delete from public.rides;
  update public.driver_profiles set lat = home_lat, lng = home_lng, online = true, trips_today = seed_trips,
    offers_received = 10, offers_accepted = seed_accepted, idle_since = now() - make_interval(mins => seed_idle_min)
  from public.demo_driver_seed s where s.user_id = driver_profiles.user_id;
end $$;

-- ================= grants =================
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_admin(), public.zone_intelligence(text), public.nearby_drivers(float8,float8,int,text),
  public.estimate_ride(float8,float8,float8,float8), public.request_ride(text,float8,float8,text,float8,float8,text),
  public.respond_offer(uuid,boolean), public.advance_trip(uuid,text), public.driver_cancel(uuid), public.cancel_ride(uuid),
  public.set_online(boolean), public.update_location(float8,float8), public.sweep_exceptions(),
  public.chaos_inject(uuid,text), public.rerank_preview(uuid,jsonb,jsonb,text), public.update_settings(jsonb),
  public.apply_repositioning(text), public.create_pool(uuid[],jsonb,jsonb),
  public.demo_request(uuid,text,float8,float8,text,float8,float8,text,boolean),
  public.admin_metrics(), public.demo_reset()
to authenticated;
