# API Contract — Urban Pulse

> All "API calls" are Supabase RPC invocations: `supabase.rpc('function_name', params)`.  
> All functions are `SECURITY DEFINER` and check `auth.uid()` internally.  
> There is no Node/Express server — this is intentional (see `docs/IMPLEMENTATION_PLAN.md`).

---

## Rider RPCs

### `estimate_ride`
**Caller:** Rider (authed)  
**Purpose:** Returns distance, ETAs, fare breakdown, and nearby available drivers — no DB write.

```ts
// Input
{
  pickup_lat: number, pickup_lng: number,
  drop_lat:   number, drop_lng:   number,
  category:   'bike' | 'auto' | 'sedan' | 'suv'
}

// Output
{
  est_distance_km:    number,
  est_pickup_eta_min: number,   // ETA of nearest available driver
  est_trip_min:       number,
  surge:              number,   // from zone of pickup
  fare_breakdown: {
    base:            number,
    per_km:          number,
    per_min:         number,
    surge_mult:      number,
    category_mult:   number,
    total:           number
  },
  nearby_drivers: [{
    driver_id: string,
    eta_min:   number,
    distance_m: number
  }]
}
```

---

### `request_ride`
**Caller:** Rider  
**Purpose:** Creates ride row (status: `requested`), then calls `dispatch()` internally.

```ts
// Input
{
  pickup_lat:    number, pickup_lng:    number,
  drop_lat:      number, drop_lng:      number,
  pickup_label:  string, drop_label:    string,
  category:      string,
  est_distance_km:    number,
  est_pickup_eta_min: number,
  est_trip_min:       number,
  surge:              number,
  fare_breakdown:     object
}

// Output
{ ride_id: string, status: 'offered' | 'requested' }
// 'requested' means no driver found immediately (dispatch will retry)
```

---

### `cancel_ride`
**Caller:** Rider (or Driver)  
**Purpose:** Cancels ride. If driver cancels an active ride, triggers re-dispatch.

```ts
// Input
{ ride_id: string, reason?: string }

// Output
{ ok: boolean }
// Writes ride_events row; if driver-cancel, calls dispatch() again
```

---

## Driver RPCs

### `set_online`
**Caller:** Driver  
```ts
{ online: boolean }
// Sets drivers.online, resets idle_since on going online
```

### `update_location`
**Caller:** Driver (called periodically / on movement simulation)  
```ts
{ lat: number, lng: number }
// Updates drivers.location geography; triggers Realtime
```

### `respond_offer`
**Caller:** Driver (must own the offer)  
**Purpose:** Accept or reject a pending offer.

```ts
// Input
{ offer_id: string, accept: boolean }

// Output (accept=true)
{ ok: true, ride_id: string, status: 'accepted' }

// Output (accept=false)
{ ok: true, next: 'redispatching' | 'no_driver_found' }
// Marks offer rejected, calls dispatch() with attempt_no+1
```

**Integrity:** `SELECT … FOR UPDATE` on the ride row; unique index ensures only one `pending` offer at a time.

---

### `advance_ride`
**Caller:** Driver (must be assigned driver)  
**Purpose:** Move ride through valid state transitions.

```ts
// Input
{ ride_id: string, to_status: 'arriving' | 'ongoing' | 'completed' }

// Output
{ ok: boolean, new_status: string, timestamp: string }
// Validates against transition table; sets arriving_at / started_at / completed_at
// Writes ride_events row
```

**Valid transitions:**
- `accepted → arriving`
- `arriving | delayed → ongoing`
- `ongoing → completed`

---

## Internal RPCs

### `dispatch` (internal, called by other RPCs)
Not callable directly by clients. Called by `request_ride`, `respond_offer` (on reject), `cancel_ride` (driver cancel), `sweep_exceptions`.

**Logic:**
1. Candidates = drivers WHERE `online=true` AND no active ride AND within radius AND NOT already tried for this ride
2. Score each candidate (see DATA_MODEL.md scoring formula)
3. If candidates exist: insert `ride_offers` row (outcome: `pending`, expires_at = now() + offer_timeout_s), set ride status = `offered`, write `ride_events`
4. If no candidates: write `ride_events` row `{type:'no_driver', attempt_no}`; if attempt_no > 5 → status = `no_driver_found`

---

## Shared RPCs (all authed roles)

### `sweep_exceptions`
**Caller:** Any authed user (idempotent; server checks clocks)  
**Purpose:** Handles timeouts and delays. Called by client timers every ~10s and by Admin "Run now" button.

```ts
// No input needed

// Output
{
  expired_offers: number,    // count of no_response offers processed
  delayed_rides:  number     // count of rides flagged as delayed
}
// For each expired offer: outcome='no_response', re-dispatch
// For each arriving ride past delay_threshold_min: status='delayed', re-dispatch
```

---

### `zone_intelligence`
**Caller:** Any authed user  
**Purpose:** Per-zone metrics for the Admin Zones tab.

```ts
// Input
{ at?: string }  // ISO timestamp; defaults to settings.sim_clock

// Output: array of zones
[{
  zone_id:    string,
  zone_name:  string,
  forecast:   number,      // predicted demand at `at`
  actual:     number | null,
  online_supply: number,   // online drivers currently in zone
  gap:        number,      // forecast - online_supply
  surge:      number,
  risk:       'low' | 'medium' | 'high',
  repositioning_suggestions: [{
    from_zone:   string,
    driver_id:   string,
    to_zone:     string,
    dist_km:     number
  }]
}]
```

**Surge formula:**
```
surge = clamp(1 + 0.15 × max(0, forecast / max(supply, 1) − 1), 1.0, surge_cap)
```

---

## Pooling RPCs

### `create_pool`
**Caller:** Rider or Admin  
**Purpose:** Server-side re-validation of a client-computed pool, then persist.

```ts
// Input
{
  ride_ids: [string, string],  // exactly 2 ride IDs in requested status
  stop_order: ['P1','P2','D1','D2'] | ['P1','P2','D2','D1'],
  per_rider_added_min: [number, number]
}

// Output
{
  ok: boolean,
  pool_group_id: string,
  stop_order: string[],
  pooled_fare_each: number,
  vs_solo_total: number,
  vs_pooled_total: number
}
// Validates: pickup distance ≤ 1.5 km, drop distance ≤ 2.5 km, detour ≤ 40%
// Sets pool_group_id on both rides; triggers dispatch for the pool as one unit
```

---

## Admin RPCs

### `admin_metrics`
**Caller:** Admin role only  

```ts
// Output
{
  avg_wait_time_min:     number,
  avg_eta_error_pct:     number,   // |actual - estimated| / estimated
  driver_utilisation:    number,   // % time drivers are on a trip
  completion_rate:       number,   // completed / (completed + cancelled + no_driver_found)
  per_driver: [{
    driver_id:   string,
    name:        string,
    rides_today: number,
    score:       number  // last offer score
  }]
}
```

### Demo Control RPCs (admin only)

| RPC | Action |
|-----|--------|
| `demo_reset_scenario` | Delete in-progress rides, reset driver positions to seed |
| `demo_force_reject(offer_id)` | Force a pending offer to `rejected` outcome |
| `demo_expire_offer(offer_id)` | Force a pending offer to `no_response` outcome |
| `demo_set_fast_mode(enabled)` | Toggle offer_timeout_s between 15 (fast) and 60 (normal) |
| `demo_simulate_movement` | Advance driver positions along seeded paths |

---

## Error Conventions

All RPCs return an error object on failure (Supabase propagates Postgres exceptions):

```ts
{
  code:    string,   // e.g. 'RIDE_NOT_FOUND', 'NOT_YOUR_RIDE', 'INVALID_TRANSITION'
  message: string,
  hint:    string
}
```

Client wraps all `supabase.rpc()` calls in try/catch and surfaces errors via toast notifications.
