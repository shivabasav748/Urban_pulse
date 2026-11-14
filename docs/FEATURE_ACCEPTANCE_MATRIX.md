# Feature acceptance matrix (13–14 Nov 2026)

Statuses: **Verified** (code + backend + automated tests, including the end-to-end flow) · **Partially verified** · **Partial** (part of the behaviour is missing) · **Simulation only** · **Blocked** (an external, legal or physical dependency).

Test suites:
- **SQL** `pnpm db:safety` 65/65 · `db:privacy` 28/28 · `db:smoke` 5/5
- **Concurrency** `pnpm db:concurrency` 16/16 scenarios, 495/495 rounds, 0 deadlocks (last complete run, with migration 0009)
- **Unit** `pnpm test` 42/42
- **E2E** core + judge + features 17/17
- **Visual** 40/40 at 360, 390, 430, 768 and 1440 px (95 screenshots), 0 horizontal overflow across 48 screen, tab and width combinations
- **ML** `ml/test_v3.py` 6/6, `ml/test_train.py` ok
- **Static** typecheck, build, lint (0 errors, 30 warnings)

## A. Core rider and captain
| Requirement | Where | Evidence | Status |
|---|---|---|---|
| Rider and captain sign-in | LoginPage, Supabase Auth, `profiles` (role not client-writable) | every E2E logs in; privacy RLS tests | Verified |
| Captain online/offline | DriverPage, `set_online` (releases pending offers) | SQL D, privacy, concurrency 3a/5c, E2E | Verified |
| Pickup and destination selection | RiderPage search, quick chips, map pin | E2E (search); the map pin isn't E2E-tested | Verified (pin partially) |
| Current location + fallback | `useCurrentPosition`, GEO_MESSAGE, manual pin | desktop only | **Blocked: physical phone checklist** (REALITY_AND_MARKET_AUDIT.md §5) |
| Nearby captain discovery | `nearby_availability` (grid-snapped, no ids) | privacy 28/28 | Verified |
| Vehicle compatibility | `_rank` category filter | SQL privacy, E2E bike/auto | Verified |
| Fare calculation | `_fare` v2 + `geo.ts` mirror | SQL J/J0, unit, E2E fare test | Verified; tariff basis partly **Blocked** (auto and bike illustrative; cab as reported) |
| Allocation, offer accept/reject | `_dispatch`, `respond_offer` | smoke, concurrency 2a–2c, E2E | Verified |
| Lifecycle, live status, start, complete | `_advance`, realtime + 5 s poll | E2E core (3 flows) | Verified |
| Captain "arrived at pickup" | none (the `arriving` status means en route) | — | **Partial**: no arrival timestamp, so the waiting charge isn't possible |
| Fare integrity | fare computed server-side at booking; riders can't write rides | SQL J0 | Verified |
| Rider history; captain history and earnings | HistorySheet; earnings sheet (payout, costs, net, simulated) | E2E core, E2E fare test | Verified (economics are estimates) |

## B. Advanced PS02
| Requirement | Evidence | Status |
|---|---|---|
| Demand forecasting | v2 live (MAE 1.015 vs 1.308); v3 evaluation (0.746 vs 0.777 recent average, 0.958 seasonal naive) | Verified (synthetic only) |
| Zone intelligence | `zone_balance`, judge tab; SQL G/H, E2E | Verified |
| Peak demand and supply | data-driven peak flag, repositioning planner; SQL H/H2/H3, E2E, Arena | Verified (the 18:00 demo clock often has no donor zone) |
| Pooling | `create_pool`, `planPool`, judge Pooling tab; unit, E2E | **Partial**: operator-initiated, 2 riders, straight-line |
| Route optimisation | pool stop order (all valid orders, detour ≤ 40%); single trips straight-line × 1.35 | **Partial**: no road router |
| Multi-factor allocation and fairness | `_rank` (shortlist 8, weights sum to 1); Allocation tab; unit, SQL | Verified |
| Reassignment and exception handling | reject, timeout, offline, stale, opt-in withdrawn, cancel, unreachable, delay; Chaos Mode | SQL D/I, concurrency 4–5, E2E | Verified |
| Batch matching | `assign()` (Hungarian), Arena study | **Simulation only**: better under contention; not live |

## C. Judges' six points
| Requirement | Evidence | Status |
|---|---|---|
| Captain zone switching | `captain_*_move`, anti-teleport, cooldown; SQL G, E2E | Verified (physical GPS movement is on the phone checklist) |
| Passenger reassignment | as in B | Verified |
| Peak shortage and repositioning | planner with hysteresis, cooldown and 15-min cap; SQL H, E2E, Arena (unnecessary switches 3.5 → 1.9) | Verified |
| Advanced automatic allocation | live four-part score + shortlist (evidence-based default); zone-aware selectable | Verified; batch is simulation only |
| Women-driver preference | hard filter, private opt-in, the rider decides; SQL A–D, I, concurrency 5a/5b, E2E | Verified; **Blocked** for production (self-declared; Karnataka adoption of the MoRTH clause unverified) |
| Safety ratings and reports | separate tables, 5-entry threshold, audited review, no auto-penalty; SQL E/F, concurrency 5e, E2E | Verified |

## Blocked or manual items
- Physical Android GPS tests.
- Competitor price screenshots.
- Primary Karnataka fare notification and the Belagavi auto tariff.
- Bike-taxi permits.
- Karnataka adoption of the MoRTH 2025 guidelines.
- Approval of the KGIS study area and the Cantonment question.
- TomTom licence.
