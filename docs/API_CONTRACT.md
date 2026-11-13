# API Contract (Supabase RPC)

All calls are `supabase.rpc(name, args)` with the user's JWT. Functions are `SECURITY DEFINER`, `set search_path = ''`, schema-qualified, `revoke execute from public`, `grant execute to authenticated`. Identity always comes from `auth.uid()`. Errors are raised as `P0001` with messages `forbidden | not_found | invalid_transition | conflict | expired | validation`.

| REST equivalent (from brief) | RPC | Role | Args → returns |
|---|---|---|---|
| `GET /drivers/nearby` | `nearby_drivers(lat,lng,radius_m=5000,category?)` | any | → `[{driver_id,name,category,lat,lng,distance_km,pickup_eta_min}]` |
| `PATCH /drivers/me/availability` | `set_online(online bool)` | driver | → driver row |
| `POST /drivers/me/location` | `update_location(lat,lng)` | driver | → ok (client throttles to ≤ 1 call / 2 s) |
| `POST /rides/estimate` | `estimate_ride(p_lat,p_lng,d_lat,d_lng)` | rider | → `{distance_km, trip_min, zone, surge:{raw,smoothed,forecast,supply,cap}, categories:[{category,fare:{base,distance,time,surge_mult,total},pickup_eta_min,drivers}]}` |
| `POST /rides` | `request_ride(pickup, dropoff, labels, category)` | rider | → `{ride_id, group_id, status, offer?}`; creates a group, calls `dispatch()` |
| `GET /rides/:id` | `select` on `rides` (RLS) + realtime | owner / driver / admin | |
| `POST /rides/:id/accept` | `respond_offer(offer_id, accept=true)` | driver (offer owner) | → group |
| `POST /rides/:id/reject` | `respond_offer(offer_id, accept=false)` | driver | → next offer or `no_driver_found` |
| `POST /rides/:id/status` | `advance_trip(group_id, to_status)` | assigned driver | → group; validated by `ride_transitions` |
| `POST /rides/:id/cancel` | `cancel_ride(ride_id)` | rider (own) / driver (assigned → re-dispatch) | |
| `GET /rides/history` | `select` on `rides` (RLS) | rider / driver | |
| — | `sweep_exceptions()` | any authed, idempotent | expires overdue offers (`no_response`) and marks late arrivals (`delayed`), then re-dispatches; returns counts |
| `GET /zones/intelligence` | `zone_intelligence(at timestamptz, scenario='base')` | any | → `[{zone, forecast, actual, supply, gap, surge_raw, surge_smoothed, risk}]` + `repositioning:[{driver_id, from_zone, to_zone, km}]` |
| — | `apply_repositioning(moves jsonb)` | admin | moves simulated drivers |
| `GET /forecasts` | `select` on `demand_forecasts`, `model_runs` | any | |
| `POST /pooling/evaluate` | client `pooling.ts` → `create_pool(ride_ids uuid[])` | admin | server re-checks distances and detour, then merges groups |
| `GET /admin/metrics` | `admin_metrics(from,to)` | admin | → waiting, ETA error, utilization, completion, per-driver distribution |
| — | `chaos_inject(group_id, kind)` | admin | `kind ∈ reject, no_response, driver_cancel, delay`; runs the **same** code path as the real event and returns the recovery chain |
| — | `rerank_preview(group_id, weights jsonb, overrides jsonb)` | admin | read-only re-score for the "what if workload/idle changed" demo |
| — | `demo_reset()` | admin | restores seed drivers and clears demo rides |

## Realtime channels
- `rides:rider_id=eq.{uid}`, `trip_groups:id=eq.{gid}`: rider tracker.
- `ride_offers:driver_id=eq.{uid}`: driver incoming offers.
- `trip_groups`, `ride_events`, `driver_profiles` (admin): judge console.
RLS applies to every channel.
