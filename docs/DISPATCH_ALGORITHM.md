# Dispatch algorithm

Every passenger request is allocated automatically by Postgres functions (`supabase/migrations`, latest definitions in 0007/0008). The browser never chooses a captain.

## Flow
1. `request_ride` validates the rider, category, radius (2, 3 or 5 km) and the optional `p_prefer_woman` flag. It creates the ride and its trip group, then calls `_dispatch`.
2. `_dispatch` locks the trip group, checks the attempt budget for the current search window, then ranks candidates with `_rank`.
3. **Hard eligibility rules**, applied before any score: matching vehicle category; online; fresh location (`_location_ok`: simulated, or updated within 90 s with GPS accuracy of 100 m or better); within the trip's search radius (PostGIS `ST_DWithin`); no active trip; no pending offer; not already tried in this search window and never someone who declined; **opted in, if the rider asked for a woman driver** (`_pref_ok`).
4. Candidates are scored (below), and the best is locked with `FOR UPDATE SKIP LOCKED` and re-validated under the lock. A single pending offer is then created. Unique indexes guarantee one pending offer per ride, one per captain, and one active trip per captain.
5. Accept → `_accept_offer` (re-checks expiry and the preference, cancels any open repositioning move). Reject, timeout, going offline, a stale location, ineligibility, a captain cancelling or an unreachable captain → `_fail_offer` / `_release` excludes that captain and dispatches again.
6. If nobody is eligible, the ride becomes `no_driver_found` and the passenger chooses: **keep waiting** (`retry_ride`, which re-dispatches every sweep for 5 minutes), or **remove the preference**. Nothing is reassigned silently.

`dispatch_audit` (judge-only) stores, for every decision, the full ranking, the reason each nearby captain was or wasn't eligible, the policy, and a zone snapshot. Riders and captains can't read it, so the eligibility of other captains never leaks.

## Score
All components are min–max normalised across the eligible candidates (0 to 1):

| Component | Meaning | Weight |
|---|---|---|
| `c_eta` | closer pickup = higher | 0.45 |
| `c_workload` | fewer trips today = higher | 0.25 |
| `c_reliability` | acceptance with a Bayesian prior (accepted + 4) / (received + 5) | 0.20 |
| `c_idle` | idle longer = higher | 0.10 |
| `c_zone` | the candidate's zone has more spare captains (expected supply − 30-min demand) = higher | `w_zone` = 0.15 |

- **`urban_pulse`** (the existing policy): `0.45·eta + 0.25·workload + 0.20·reliability + 0.10·idle`.
- **`zone_aware`** (judge-selectable): `(1 − w_zone) × urban_pulse + w_zone × c_zone`.
  - The weights are renormalised: 0.85 × (0.45 + 0.25 + 0.20 + 0.10) + 0.15 = 1.00, not 115% (unit-tested).
  - The zone term only breaks near-ties toward captains whose departure won't drain a short zone, and it can't overturn a large ETA advantage (unit-tested).
- **Default since migration 0010: `urban_pulse`.** A 10-seed, 20-scenario Arena study plus an ablation (score term vs planner) showed the zone term added about 0.3 min of pickup wait without improving completion. Zone intelligence still drives the repositioning planner.
- **Shortlist (migration 0009):** only the 8 nearest eligible captains are scored (`settings.rank_shortlist`). Without it, normalisation across a wide candidate spread made ETA nearly irrelevant. With a simulated 250-cab fleet the score sent far captains: pickup wait 4.65 min, against 2.33 min with the shortlist and 2.14 for nearest-driver (5 seeds).
- **Deterministic tie-breaking:** score descending, then pickup minutes, then captain id.
- **`nearest`**: lowest pickup minutes. Used only as the Arena baseline.

## Batch (minimum-cost) matching: measured, not yet adopted live
`scripts/arena-study.ts batch` compares one-at-a-time matching (the live approach) against a per-tick global min-ETA assignment (Hungarian algorithm; `assign()` in `src/sim/arena.ts`, checked against brute force). Evening-peak scenario, 5 seeds:

| Fleet × demand | Pickup wait, one-at-a-time → batch | Completion | Empty pickup km |
|---|---|---|---|
| 17 captains, 1× (~103 requests) | 19.2 → 15.2 min | 34.8% → 38.2% | 227 → 205 |
| 50, 2× (~227) | 16.3 → 13.3 | 49.6% → 51.6% | 627 → 564 |
| 100, 4× (~450) | 15.8 → 12.3 | 51.4% → 55.0% | 1,296 → 1,110 |
| 250, 1× (~111) | 2.33 → 2.14 | 77.4% → 78.2% | 57 → 50 |

**Conclusion:**
- Batching helps whenever several requests compete for the same captains: up to 4 minutes less pickup wait under scarcity.
- At low contention, batching is roughly equal to one-at-a-time nearest-driver; the remaining gap is the ETA-only objective, not batching.
- So the earlier claim that "greedy is the right size" is **not supported**.
- Live dispatch still offers each request immediately, because the 17-captain demo rarely has two requests waiting at once and a live batch window would need new locking work.

**Recommended next step:** run a 3–5 s matching window inside the sweep (under the existing advisory lock) for requests still waiting, using the same assignment with fairness as a tie-break. Classified as **implemented in simulation only**.

## Reassignment lifecycle
| Trigger | Where | Outcome / event |
|---|---|---|
| Captain declines | `respond_offer` → `_fail_offer('rejected')` | `offer_rejected`, re-dispatch |
| Offer times out | sweep → `_fail_offer('no_response','timeout')` | `offer_no_response` |
| Captain goes offline holding an offer | `set_online(false)`, plus the sweep as a backstop | `offer_no_response` (reason `captain_went_offline` / `captain_unavailable`) |
| Location goes stale while holding an offer | sweep | as above |
| Captain withdraws the women-rider opt-in | `set_women_riders_optin(false)`, plus the sweep | `offer_cancelled` (`captain_withdrew_preference`) |
| Captain cancels after accepting | `driver_cancel` → `_release` | `driver_cancelled` |
| Captain unreachable before pickup (offline or stale) | sweep → `_release` | `captain_unreachable` |
| Late to pickup | sweep → `_release` | `arrival_delayed` |

Riders see plain messages ("Captain notified", "Captain unavailable · finding another captain", "New captain assigned", "No suitable captains available right now"); database errors are never shown. Concurrency control: lock order trip_groups → driver_profiles → ride_offers → reposition_moves, and a single sweep at a time via `pg_try_advisory_xact_lock(727201, 1)`.

## Tests
- SQL: `pnpm db:safety` (55 checks), `pnpm db:privacy` (28), `pnpm db:smoke` (5).
- Concurrency: `pnpm db:concurrency` (16 scenarios).
- Unit: `src/lib/dispatch.test.ts`.
- E2E: `e2e/features.spec.ts`, `e2e/core.spec.ts`.
