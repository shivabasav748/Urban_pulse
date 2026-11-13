# Demo Script — Urban Pulse (PS 02)

> **Audience:** Hack Valley judges  
> **Duration:** ~12–15 minutes  
> **Mode:** Fast Demo Mode enabled (offer_timeout = 15s)  
> **Setup:** Supabase local running, `pnpm dev` running, 3 browser tabs open  

---

## Pre-Demo Checklist

- [ ] `pnpm dlx supabase start` — Postgres + Auth + Realtime running
- [ ] `pnpm dlx supabase db reset` — fresh seed data applied
- [ ] `pnpm dev` — Vite server running
- [ ] Browser tabs open: **Rider** (rider@demo.local), **Driver** (driver1@demo.local), **Admin** (admin@demo.local)
- [ ] Admin → Demo Controls → **Enable Fast Mode** (15s offer timeout)
- [ ] Admin → Demo Controls → **Reset Scenario** (positions at seed defaults)
- [ ] Screen resolution: 1440×900 or mirrored to projector

---

## Scene 1 — Core Ride Request & Dispatch (3 min)

**Tab: Rider**

1. Show login page → point out demo accounts listed
2. Sign in as `rider@demo.local`
3. Map view → select pickup: **Koramangala** → drop: **Indiranagar**
4. Choose **Auto** category
5. Point to fare estimate panel: base ₹30 + per-km + per-min + surge multiplier = **₹X total**
   - _"Surge is zone-based — Koramangala has a 1.2× surge right now due to forecast gap"_
6. Click **Request Ride**

**Tab: Driver** (side by side or switch)

7. driver1 is online → show incoming offer card: pickup label, drop label, pickup ETA, fare, **15s countdown**
8. Click **Accept**

**Tab: Rider**

9. Status updates to **Accepted** via Supabase Realtime — no page refresh
10. Driver card appears: name, vehicle, plate, ETA

> _Talking point: No REST server. React → Supabase RPC → Postgres trigger → Realtime WebSocket back to React. One fewer service to fail during judging._

---

## Scene 2 — Reassignment (Feature E) (2 min)

**Tab: Driver**

1. Click **Reject** on the offer (or Admin → Force Reject)

**Tab: Rider**

2. Status shows: _"Finding another driver (attempt 2 of 5)"_

**Tab: Admin → Exceptions tab**

3. Show `ride_events` log: `offer_created (attempt 1)` → `offer_rejected` → `offer_created (attempt 2)`
4. driver2 receives the offer → accept

> _Talking point: driver1 is excluded from future offers for this ride. attempt_no is stored in ride_offers and shown to the rider. Capped at 5 attempts → no_driver_found with clear message._

---

## Scene 3 — Full Lifecycle (2 min)

**Tab: Driver**

1. Click **I'm Arriving** → Rider sees "Driver arriving"
2. Click **Start Trip** → Status: Ongoing
3. Click **Complete Trip** → Status: Completed

**Tab: Rider**

4. Show fare breakdown in ride history: base + per-km + per-min + surge + category → total
5. Show ride detail: timestamps (accepted_at, arrived_at, started_at, completed_at)

---

## Scene 4 — Fair Allocation (Feature D) (2 min)

**Tab: Admin → Allocation tab**

1. Show the most recent offer: winner + runner-up drivers
2. For each driver: score bars — ETA score, Workload score, Reliability, Idle time
3. Show weights: 0.45 / 0.25 / 0.20 / 0.10
4. Move the **ETA weight** slider down, **Workload** up → click Re-rank
5. Show runner-up becomes winner based on new weights

> _Talking point: The algorithm is transparent. Weights are configurable. We store score_components per offer so you can audit any dispatch decision. We explicitly label this a prototype policy, not a bias-free guarantee._

---

## Scene 5 — Zone Intelligence + Surge + Forecast (Feature A + B) (3 min)

**Tab: Admin → Zones tab**

1. Zone heatmap: colours represent surge level (green = 1.0×, red = 2.0×)
2. Click **Whitefield** zone → panel: forecast demand = 18, online supply = 6, gap = 12, surge = 1.8×, risk = HIGH
3. Show **Forecast vs Actual chart** for Whitefield — test week data
4. Model card: `HistGradientBoosting · MAE: X.X · Baseline MAE: Y.Y`
   - _"We report MAE honestly even when the gain over baseline is modest"_
5. Slide the **sim_clock** to 9 AM → surge updates across zones (office areas spike)
6. Show **repositioning arrows**: idle driver in HSR → suggested to move to Whitefield

> _Talking point: 8 zones × 42 days synthetic history, features include lag-1, lag-48, lag-336, rolling mean. Time-based split, no data leakage. Fallback to labelled heuristic if model unavailable._

---

## Scene 6 — Ride Pooling (Feature C) (2 min)

**Tab: Admin → Pooling tab**

1. Two pending ride requests are visible (seeded)
2. Click both → system computes compatibility: pickup distance ≤ 1.5 km ✅, drop distance ≤ 2.5 km ✅
3. Show stop order diagram: P1 → P2 → D1 → D2 (chosen as min total time)
4. Per-rider breakdown: Rider A adds 4 min, Rider B adds 2 min — both under 40% detour ✅
5. Pooled fare: ₹X each (30% less than solo ₹Y)
6. Click **Create Pool** → both rides share `pool_group_id`, dispatched as one unit

> _Talking point: Brute-force over 4 valid orderings for 2 riders. Limitation stated: 2–3 riders, straight-line distances — honest prototype scoping._

---

## Closing Points (1 min)

- All simulated data clearly labelled **SIMULATED** throughout the UI
- Full audit trail in `ride_events` — append-only, no UPDATE/DELETE grants
- `pnpm test` passes: geo/fare, pooling compatibility, scoring parity test cases
- Playwright E2E: full lifecycle, reject → reassignment, zones, pooling — screenshots at 1440×900 and 390×844
- Local-first (Docker + Supabase CLI); GitHub Pages deploy ready pending approval

---

## Demo Fallbacks

| Scenario | Recovery |
|----------|---------|
| Docker / Supabase not running | Switch to hosted Supabase dev project (same schema) |
| Realtime not firing | Manually refresh; explain Realtime depends on Docker networking |
| OSM tiles blocked | Map shows markers/zones on blank canvas; list views work |
| Driver doesn't receive offer | Admin → Demo Controls → Force Assign |
| Clock wrong / surge looks flat | Admin → Demo Controls → Set sim_clock to 09:00 |

---

## Judge Q&A Prep

**Q: Why no Node.js backend?**  
A: GitHub Pages is static-only. We use Supabase SECURITY DEFINER RPCs with auth.uid() inside Postgres — same guarantees, one fewer service to fail during judging. Documented in IMPLEMENTATION_PLAN.md.

**Q: Is the forecast model real?**  
A: Yes — HistGradientBoosting trained on synthetic but structurally realistic data (zone demand curves, rain/incident effects, lag features). We show MAE vs a naive baseline honestly. The synthetic history is seeded in the DB and the trained model's predictions are committed as seed_forecast.sql.

**Q: How is pooling detour calculated?**  
A: Haversine × 1.35 for all legs, then compare each rider's pooled journey time vs their solo estimate. Reject if either exceeds 40% added time.

**Q: Can allocation weights be biased?**  
A: Yes — that's intentional transparency. We label it a "configurable prototype policy" not a bias-free guarantee. The admin can see and change the weights; every past decision's components are stored.
