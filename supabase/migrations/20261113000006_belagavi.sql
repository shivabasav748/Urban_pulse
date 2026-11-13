-- Demo city: Belagavi (Belgaum), Karnataka. SIMULATED prices and speeds, made up for the demo, not any operator's tariff.
-- Data (zones, captain positions) lives in seed.sql; this migration only changes logic that depends on the city.

-- Smaller city, lighter traffic than Bengaluru: 20 km/h at peak (8-10, 17-20 h), 28 km/h otherwise; bikes 15% faster.
create or replace function public._speed_kmh(cat text, at timestamptz) returns numeric
language sql stable set search_path = '' as $$
  select (case when extract(hour from at at time zone 'Asia/Kolkata') between 8 and 10
                 or extract(hour from at at time zone 'Asia/Kolkata') between 17 and 20 then 20 else 28 end)
         * (case when cat = 'bike' then 1.15 else 1 end)
$$;

-- Fare = base (covers the first included_km) + per_km x km beyond that + per_min x trip minutes, x surge.
--   bike: Rs 20 incl. 1.5 km, Rs 6/km, Rs 0.50/min
--   auto: Rs 30 incl. 1.5 km, Rs 13/km, Rs 1.00/min
--   cab : Rs 55 incl. 2.0 km, Rs 17/km, Rs 1.50/min
-- Mirrored exactly in src/lib/geo.ts (fare). Output keys keep the old ones (base, distance, time, surge_mult, total).
create or replace function public._fare(cat text, km numeric, mins numeric, surge numeric) returns jsonb
language sql immutable set search_path = '' as $$
  with p(base, incl, per_km, per_min) as (
    select b, i, k, m from (values ('bike', 20, 1.5, 6, 0.5), ('auto', 30, 1.5, 13, 1.0), ('cab', 55, 2.0, 17, 1.5)) v(c, b, i, k, m) where c = cat
  ), f as (select base, incl, per_km, per_min, round(per_km * greatest(km - incl, 0)) dist, round(per_min * mins) tm from p)
  select jsonb_build_object('base', base, 'included_km', incl, 'per_km', per_km, 'per_min', per_min,
         'distance', dist, 'time', tm, 'surge_mult', surge, 'total', round((base + dist + tm) * surge)) from f
$$;

-- Demo service area = Belagavi (was a Bengaluru box). Mirrored in src/lib/places.ts (inDemoArea).
create or replace function public.update_location(p_lat float8, p_lng float8, p_accuracy_m numeric default null, p_source text default 'gps') returns void
language plpgsql security definer set search_path = '' as $$
declare d public.driver_profiles;
begin
  if p_source not in ('gps', 'manual') then raise exception 'validation: source'; end if;
  if p_lat not between 15.70 and 16.00 or p_lng not between 74.40 and 74.70 then raise exception 'validation: outside demo area'; end if;
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
