-- 0015: why_my_captain fixes: operator precedence ("-" binds tighter than "->"); the safety summary is optional;
-- _pool_pair also pairs a request that already reached no_driver_found (as admin create_pool does). Forward-only.
create or replace function public.why_my_captain(p_ride uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.ride_offers; d public.driver_profiles; n int; saf jsonb;
begin
  if not exists (select 1 from public.rides where id = p_ride and rider_id = auth.uid()) then raise exception 'forbidden'; end if;
  select ro.* into o from public.ride_offers ro join public.trip_group_members m on m.group_id = ro.group_id
   where m.ride_id = p_ride and ro.outcome = 'accepted' order by ro.offered_at desc limit 1;
  if o.id is null then return null; end if;
  select * into d from public.driver_profiles where user_id = o.driver_id;
  begin saf := public.captain_safety_summary(o.driver_id); exception when others then saf := null; end;  -- optional part
  select coalesce(jsonb_array_length(a.ranking), 0) into n from public.dispatch_audit a where a.offer_id = o.id;
  return jsonb_build_object('score', o.score, 'chosen', (o.components->'chosen') - 'driver_id', 'weights', o.components->'weights',
    'policy', o.components->>'policy', 'attempt', o.attempt_no, 'compared', n,
    'trips_today', d.trips_today, 'acceptance', round((d.offers_accepted + 4)::numeric / (d.offers_received + 5), 2),
    'vehicle_label', d.vehicle_label, 'simulated', d.is_simulated, 'safety', saf);
end $$;

create or replace function public._pool_pair(p_a uuid, p_b uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.settings; a public.rides; b public.rides; pts jsonb; ord text; st jsonb; km numeric; best jsonb; best_km numeric := 1e9;
  k int; ia int; ja int; ib int; jb int; da numeric; db numeric; det jsonb; best_det jsonb; gid uuid; r uuid; old uuid;
begin
  select * into s from public.settings;
  select * into a from public.rides where id = p_a for update;
  select * into b from public.rides where id = p_b for update;
  if a.status not in ('requested', 'offered', 'no_driver_found') or b.status not in ('requested', 'offered', 'no_driver_found') then return null; end if;
  if public._km(a.pickup_lat, a.pickup_lng, b.pickup_lat, b.pickup_lng) > 1.5 * 1.35
     or public._km(a.drop_lat, a.drop_lng, b.drop_lat, b.drop_lng) > 2.5 * 1.35 then return null; end if;
  pts := jsonb_build_array(
    jsonb_build_object('type', 'pickup', 'ride_id', a.id, 'label', a.pickup_label, 'lat', a.pickup_lat, 'lng', a.pickup_lng),
    jsonb_build_object('type', 'pickup', 'ride_id', b.id, 'label', b.pickup_label, 'lat', b.pickup_lat, 'lng', b.pickup_lng),
    jsonb_build_object('type', 'drop', 'ride_id', a.id, 'label', a.drop_label, 'lat', a.drop_lat, 'lng', a.drop_lng),
    jsonb_build_object('type', 'drop', 'ride_id', b.id, 'label', b.drop_label, 'lat', b.drop_lat, 'lng', b.drop_lng));
  foreach ord in array array['0123', '0132', '1023', '1032'] loop
    select jsonb_agg(pts->(substr(ord, i, 1)::int) order by i) into st from generate_series(1, 4) i;
    km := 0;
    for k in 1..3 loop km := km + public._km((st->(k-1)->>'lat')::float8, (st->(k-1)->>'lng')::float8, (st->k->>'lat')::float8, (st->k->>'lng')::float8); end loop;
    ia := strpos(ord, '0') - 1; ja := strpos(ord, '2') - 1; ib := strpos(ord, '1') - 1; jb := strpos(ord, '3') - 1;
    da := 0; for k in ia + 1..ja loop da := da + public._km((st->(k-1)->>'lat')::float8, (st->(k-1)->>'lng')::float8, (st->k->>'lat')::float8, (st->k->>'lng')::float8); end loop;
    db := 0; for k in ib + 1..jb loop db := db + public._km((st->(k-1)->>'lat')::float8, (st->(k-1)->>'lng')::float8, (st->k->>'lat')::float8, (st->k->>'lng')::float8); end loop;
    det := jsonb_build_object(a.id::text, round(100 * (da / greatest(public._km(a.pickup_lat, a.pickup_lng, a.drop_lat, a.drop_lng), 0.1) - 1)),
                              b.id::text, round(100 * (db / greatest(public._km(b.pickup_lat, b.pickup_lng, b.drop_lat, b.drop_lng), 0.1) - 1)));
    if (det->>a.id::text)::numeric <= s.pool_max_detour_pct and (det->>b.id::text)::numeric <= s.pool_max_detour_pct and km < best_km then
      best := st; best_km := km; best_det := det;
    end if;
  end loop;
  if best is null then return null; end if;

  insert into public.trip_groups(category, stops, is_pool, women_driver_pref, shared_requested)
  values ('cab', best, true, a.women_driver_pref or b.women_driver_pref, true) returning id into gid;
  foreach r in array array[a.id, b.id] loop
    select group_id into old from public.trip_group_members where ride_id = r;
    update public.ride_offers set outcome = 'cancelled', responded_at = now() where group_id = old and outcome = 'pending';
    update public.trip_groups set status = 'cancelled' where id = old;
    perform public._event(old, 'merged_into_pool', null, 'cancelled', jsonb_build_object('pool_group', gid));
    update public.trip_group_members set group_id = gid,
      pickup_seq = (select (i - 1)::int from jsonb_array_elements(best) with ordinality e(v, i) where v->>'ride_id' = r::text and v->>'type' = 'pickup'),
      drop_seq = (select (i - 1)::int from jsonb_array_elements(best) with ordinality e(v, i) where v->>'ride_id' = r::text and v->>'type' = 'drop'),
      detour_min = coalesce((best_det->>r::text)::numeric, 0)
    where ride_id = r;
    update public.rides set status = 'requested', category = 'cab',
      fare = public._fare('cab', est_distance_km, est_trip_min, surge) || jsonb_build_object('pool_discount', 0.25, 'shared', true,
        'solo_total', (public._fare('cab', est_distance_km, est_trip_min, surge)->>'total')::numeric,
        'total', round((public._fare('cab', est_distance_km, est_trip_min, surge)->>'total')::numeric * 0.75))
    where id = r;
  end loop;
  perform public._event(gid, 'pool_created', null, 'requested', jsonb_build_object('rides', array[a.id, b.id], 'stops', best, 'shared', true));
  perform public._dispatch(gid);
  return gid;
end $$;
