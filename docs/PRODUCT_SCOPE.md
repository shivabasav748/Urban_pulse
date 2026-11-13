# Product Scope — Urban Pulse

## In Scope

### Core Ride Lifecycle
- Rider sign-up / sign-in with role selection
- Ride estimate: pickup + drop (seeded Bengaluru places or map click), vehicle category, fare + ETA preview
- Ride request → real-time driver dispatch → driver offer notification
- Driver: accept or reject offer (with countdown timer)
- Full state machine: Requested → Offered → Accepted → Arriving → Ongoing → Completed
- Rider live status tracker showing current status + driver details
- Ride history (rider + driver views) with fare breakdown
- Cancel ride (rider or driver)

### Advanced Feature A — Demand Forecasting
- 8 Bengaluru zones × 42 days synthetic history (zone demand curves, rain boost, incident spikes)
- HistGradientBoosting model (scikit-learn); time-based train/test split (35/7 days)
- Features: zone (one-hot), hour, minute-bucket, day-of-week, weekend, rain, incident, lag-1, lag-48, lag-336, rolling 2-hour mean
- Test MAE vs naive baseline (same time last week) — both shown in Admin UI
- Admin can slide simulated clock to any moment in the test week
- Fallback: seasonal-naive heuristic if sklearn unavailable on Python 3.14 (labelled explicitly)

### Advanced Feature B — Zone Surge Pricing
- Surge computed per zone from forecast/supply gap
- Formula: `clamp(1 + 0.15 × max(0, forecast/supply − 1), 1.0, 2.0)`
- Zone heatmap (colour by surge level) + risk badge (low/medium/high)
- Forecast vs actual chart per zone
- Repositioning suggestions: greedy — nearest idle drivers from surplus zones directed to high-risk zones
- Surge multiplier applied in fare breakdown, shown to rider before requesting

### Advanced Feature C — Ride Pooling
- 2-rider matching: pickup ≤ 1.5 km apart, drop ≤ 2.5 km apart (or same direction: bearing diff < 30°)
- 4 valid stop orderings for 2 riders — brute-force, pick min total time subject to each rider detour ≤ 40%
- Admin Pooling tab: select 2 pending requests → stop-order diagram → per-rider added minutes → comparison vs solo → create pool
- Pooled fare = 0.7 × solo fare each (30% discount)
- Limitation explicitly stated: 2–3 riders, straight-line distances

### Advanced Feature D — Fair Allocation
- 4-component score per candidate: ETA (0.45), workload (0.25), reliability (0.20), idle time (0.10)
- Min-max normalisation over the candidate set
- Score + all components stored in `ride_offers.score_components`
- Admin Allocation tab: score bars for winner and runner-ups, weight sliders (must sum to 1), live re-rank without reassigning
- Labelled as "transparent prototype policy" — not a claim of bias-freedom

### Advanced Feature E — Reassignment
- Triggered by: rejection, offer timeout (no_response), driver cancel, arriving-delay
- Excludes previous drivers for this ride; `attempt_no` increments
- Rider sees live message: "Finding another driver (attempt 2 of 5)"
- Cap at 5 attempts → `no_driver_found` status with clear UI message
- Full attempt history visible in Admin Exceptions tab

### Admin / Judge View
- **Live tab:** real-time map with driver positions, active rides, zone overlays
- **Allocation tab:** offer history, score breakdown, weight editor
- **Zones tab:** heatmap, forecast vs actual, surge, repositioning arrows, model card (MAE)
- **Pooling tab:** create pools, view stop orders and comparisons
- **Exceptions tab:** `ride_events` log, sweep now button, event timeline
- **Metrics tab:** wait time, ETA error, utilisation, completion rate, per-driver assignment
- **Demo Controls:** fast mode toggle, reset scenario, force reject/timeout, simulate driver movement, seeded account list

---

## Out of Scope

| Item | Reason |
|------|--------|
| Real GPS / live location | Simulated positions; labelled SIMULATED |
| Payment processing | Out of scope for prototype |
| SMS / push notifications | Realtime via Supabase is sufficient for demo |
| Nominatim geocoding autocomplete | External dependency; seeded places instead |
| Dynamic routing (OSRM/Valhalla) | Straight-line × 1.35 factor, labelled "estimated" |
| Production security hardening | Prototype; RLS covers demo threat model |
| Multi-city support | 8 Bengaluru zones only |
| > 3 pooled riders | Brute-force complexity; 2-rider pooling fully implemented |
| Driver earnings / wallet | Out of scope |
| Ratings / reviews | Out of scope |
| Dynamic vehicle availability | Seeded vehicle categories per driver |

---

## Simulated Data Labels

Every view that uses synthetic or simulated data shows a clearly visible **"SIMULATED"** badge:
- Map: driver positions
- Zones: demand values and forecasts
- Forecast chart: all data points
- Admin metrics: all KPIs

This is a prototype requirement from the brief — all simulations are transparent to the judge.

---

## Demo Accounts (dev/seed only)

| Role | Email | Password |
|------|-------|---------|
| Rider | `rider@demo.local` | `demo1234` |
| Driver 1 | `driver1@demo.local` | `demo1234` |
| Driver 2 | `driver2@demo.local` | `demo1234` |
| Driver 3 | `driver3@demo.local` | `demo1234` |
| Admin / Judge | `admin@demo.local` | `demo1234` |

Accounts listed on the login page in development mode only.
