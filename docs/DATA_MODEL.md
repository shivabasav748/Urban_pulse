# Data Model — Urban Pulse

## Postgres Schema (Supabase + PostGIS)

---

### `profiles`
Extends `auth.users`. Role is **never** client-writable.

```sql
CREATE TABLE profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('rider','driver','admin')),
  name        text NOT NULL,
  created_at  timestamptz DEFAULT now()
);
-- RLS: users can read own row; role updates blocked by policy + trigger
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
```

### `drivers`
```sql
CREATE TABLE drivers (
  id               uuid PRIMARY KEY REFERENCES profiles ON DELETE CASCADE,
  vehicle_category text NOT NULL CHECK (vehicle_category IN ('bike','auto','sedan','suv')),
  plate            text NOT NULL,
  online           boolean DEFAULT false,
  location         geography(Point,4326),
  idle_since       timestamptz,
  rides_today      int DEFAULT 0,
  offers_received  int DEFAULT 0,
  offers_accepted  int DEFAULT 0,
  updated_at       timestamptz DEFAULT now()
);
CREATE INDEX drivers_location_gist ON drivers USING GIST(location);
CREATE INDEX drivers_online_idx ON drivers(online) WHERE online = true;
```

### `rides`
```sql
CREATE TABLE rides (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id          uuid NOT NULL REFERENCES profiles,
  driver_id         uuid REFERENCES drivers,
  pickup            geography(Point,4326) NOT NULL,
  drop              geography(Point,4326) NOT NULL,
  pickup_label      text NOT NULL,
  drop_label        text NOT NULL,
  vehicle_category  text NOT NULL,
  status            text NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested','offered','accepted','arriving',
                                      'delayed','ongoing','completed','cancelled','no_driver_found')),
  fare_breakdown    jsonb,          -- {base, per_km, per_min, surge_mult, category_mult, total}
  est_distance_km   numeric(8,2),
  est_pickup_eta_min numeric(6,1),
  est_trip_min      numeric(6,1),
  surge             numeric(4,2) DEFAULT 1.0,
  pool_group_id     uuid,
  requested_at      timestamptz DEFAULT now(),
  accepted_at       timestamptz,
  arrived_at        timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  cancelled_at      timestamptz
);
-- A driver cannot hold two active rides simultaneously
CREATE UNIQUE INDEX rides_driver_active_uniq
  ON rides(driver_id)
  WHERE status IN ('accepted','arriving','delayed','ongoing');
ALTER TABLE rides ENABLE ROW LEVEL SECURITY;
```

### `ride_offers`
```sql
CREATE TABLE ride_offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id          uuid NOT NULL REFERENCES rides ON DELETE CASCADE,
  driver_id        uuid NOT NULL REFERENCES drivers,
  attempt_no       int NOT NULL DEFAULT 1,
  score            numeric(5,4),
  score_components jsonb,  -- {eta_score, workload_score, reliability, idle_score, weights}
  outcome          text NOT NULL DEFAULT 'pending'
                   CHECK (outcome IN ('pending','accepted','rejected','no_response','cancelled')),
  offered_at       timestamptz DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  responded_at     timestamptz
);
-- Only one pending offer per ride at a time
CREATE UNIQUE INDEX ride_offers_pending_uniq
  ON ride_offers(ride_id)
  WHERE outcome = 'pending';
ALTER TABLE ride_offers ENABLE ROW LEVEL SECURITY;
```

### `ride_events`
Append-only audit log. No `UPDATE`/`DELETE` grants.

```sql
CREATE TABLE ride_events (
  id          bigserial PRIMARY KEY,
  ride_id     uuid NOT NULL REFERENCES rides,
  actor       uuid,          -- auth.uid() or NULL for system
  type        text NOT NULL, -- e.g. 'status_change','offer_created','offer_expired'
  from_status text,
  to_status   text,
  payload     jsonb,
  at          timestamptz DEFAULT now()
);
CREATE INDEX ride_events_ride_idx ON ride_events(ride_id, at DESC);
-- Revoke delete/update from all roles including service_role for audit integrity
```

### `zones`
```sql
CREATE TABLE zones (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name     text UNIQUE NOT NULL,
  polygon  geography(Polygon,4326) NOT NULL,
  centroid geography(Point,4326) NOT NULL
);
CREATE INDEX zones_polygon_gist ON zones USING GIST(polygon);
-- Seeded: Koramangala, Indiranagar, MG Road, HSR Layout,
--         Whitefield, Jayanagar, Hebbal, Electronic City
```

### `demand_observations`
```sql
CREATE TABLE demand_observations (
  id        bigserial PRIMARY KEY,
  zone_id   uuid NOT NULL REFERENCES zones,
  ts        timestamptz NOT NULL,
  demand    int NOT NULL,
  rain      boolean DEFAULT false,
  incident  boolean DEFAULT false,
  UNIQUE(zone_id, ts)
);
```

### `demand_forecasts`
```sql
CREATE TABLE demand_forecasts (
  id            bigserial PRIMARY KEY,
  zone_id       uuid NOT NULL REFERENCES zones,
  target_ts     timestamptz NOT NULL,
  predicted     numeric(8,2) NOT NULL,
  actual        numeric(8,2),
  model_version text NOT NULL,
  UNIQUE(zone_id, target_ts, model_version)
);
```

### `model_runs`
```sql
CREATE TABLE model_runs (
  version      text PRIMARY KEY,
  model        text NOT NULL,     -- 'HistGradientBoosting' or 'seasonal_naive'
  mae          numeric(8,4),
  baseline_mae numeric(8,4),
  features     text[],
  trained_at   timestamptz DEFAULT now()
);
```

### `settings` (single row)
```sql
CREATE TABLE settings (
  id                  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  weight_eta          numeric(4,2) DEFAULT 0.45,
  weight_workload     numeric(4,2) DEFAULT 0.25,
  weight_reliability  numeric(4,2) DEFAULT 0.20,
  weight_idle         numeric(4,2) DEFAULT 0.10,
  offer_timeout_s     int DEFAULT 60,          -- 15 for fast demo mode
  delay_threshold_min int DEFAULT 10,
  surge_cap           numeric(4,2) DEFAULT 2.0,
  pool_max_detour_pct int DEFAULT 40,
  sim_clock           timestamptz DEFAULT now() -- admin can slide to test-week moment
);
```

---

## State Machine

```
requested
  → offered       (dispatch found candidate, offer created)
  → accepted      (driver accepted via respond_offer)
  → arriving      (advance_ride: driver en route to pickup)
  → delayed       (sweep_exceptions: arriving > delay_threshold_min)
  → ongoing       (advance_ride: driver arrived, trip started)
  → completed     (advance_ride: trip ended)

offered → rejected / no_response → requested (re-dispatch, attempt_no++)
arriving → delayed → requested (re-dispatch)
requested | offered | accepted | arriving → cancelled
attempt_no > 5 → no_driver_found
```

Transition table enforced inside `advance_ride` SECURITY DEFINER function. Every transition writes a row to `ride_events`.

---

## Fare Formula

```
base          = ₹30
per_km_rate   = ₹12
per_min_rate  = ₹1.5
category_mult = { bike: 0.8, auto: 1.0, sedan: 1.3, suv: 1.6 }

fare = (base + per_km_rate × distance_km + per_min_rate × trip_min)
       × surge
       × category_mult
```

Speed by simulated hour: 18 km/h (peak: 8–10, 17–21), 28 km/h (off-peak).
Distance = haversine × 1.35 road correction factor.

---

## Scoring Formula (Fair Allocation)

For each candidate driver in dispatch():

```
eta_score        = 1 − min_max_norm(pickup_eta_min)
workload_score   = 1 − min_max_norm(rides_today)
reliability      = offers_accepted / offers_received  (prior 0.8 for new drivers)
idle_score       = min_max_norm(idle_minutes)

score = w_eta × eta_score
      + w_workload × workload_score
      + w_reliability × reliability
      + w_idle × idle_score
```

Weights from `settings` row. All components stored in `ride_offers.score_components` for UI display.
