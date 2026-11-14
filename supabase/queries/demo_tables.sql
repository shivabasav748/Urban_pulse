-- Read-only demo queries (local Supabase). Paste one into Studio > SQL Editor (http://127.0.0.1:54323), or run:
--   docker exec -i supabase_db_urban-pulse psql -U postgres < supabase/queries/demo_tables.sql

-- 1. Drivers (captains)
select p.display_name as driver, u.email, d.online, d.is_simulated, d.trips_today,
       round(100.0 * d.offers_accepted / nullif(d.offers_received, 0)) as acceptance_pct, z.name as zone
from public.driver_profiles d
join public.profiles p on p.id = d.user_id
join auth.users u on u.id = d.user_id
left join public.zones z on z.id = d.op_zone
order by p.display_name;

-- 2. Their vehicles
select p.display_name as driver, d.vehicle_category as category, d.vehicle_label as vehicle, d.plate
from public.driver_profiles d
join public.profiles p on p.id = d.user_id
order by d.vehicle_category, d.plate;

-- 3. Passengers (riders) and how many rides each has booked
select p.display_name as passenger, u.email, p.created_at::date as joined, count(r.id) as rides_booked
from public.profiles p
join auth.users u on u.id = p.id
left join public.rides r on r.rider_id = p.id
where p.role = 'rider'
group by p.id, p.display_name, u.email, p.created_at
order by p.display_name;

-- 4. Rides booked: date, time (IST), places, vehicle, status, fare
select to_char(r.requested_at at time zone 'Asia/Kolkata', 'DD Mon YYYY') as date,
       to_char(r.requested_at at time zone 'Asia/Kolkata', 'HH24:MI') as time_ist,
       pr.display_name as passenger, r.pickup_label as pickup, r.drop_label as drop,
       r.category as vehicle, pd.display_name as driver, r.status, (r.fare->>'total')::numeric as fare_inr
from public.rides r
join public.profiles pr on pr.id = r.rider_id
left join public.profiles pd on pd.id = r.driver_id
order by r.requested_at desc;
