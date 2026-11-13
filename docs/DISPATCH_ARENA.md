# Dispatch Arena: A/B/C Simulator Design

**Update 13 Nov 2026 (arena-v2):** there are now three worlds: A nearest, B existing Urban Pulse (score + greedy 15-min moves), and C zone-aware (score + zone balance, plus a planner that mirrors `_reposition_tick`). There are 13 scenarios, including a railway-station spike, a zone shortage, many rejections, captains going offline and two women-driver-preference cases. New metrics: zone imbalance, reassignment success and delay, moves, unnecessary switches, and preference served, wait and violations. See `src/sim/arena.ts` (METRICS) and docs/FAIRNESS_AND_ALLOCATION.md for results.

Pure, deterministic TypeScript in `src/sim/`. It runs in the browser, never touches Supabase ride tables, and every value is **SIMULATED**.

## Inputs (one immutable `ScenarioInput`)
`{ runId, seed, scenarioId, horizonMin: 120, tickSec: 30, fleet: Driver[], requests: Request[], responses: ResponseRoll[], forecast: ZoneForecast[], algorithmVersion }`
- `generateInput(seed, scenarioId)` uses `mulberry32(seed)`. Same seed + scenario → byte-identical input (unit-tested).
- `responses[i]` is precomputed per (request, driver-rank) as accept/reject/no-response, so both worlds see the same driver behaviour.
- Trip durations are a function of distance and the simulated hour only.

## Worlds
`runWorld(policy, structuredClone(input)) → WorldResult`. There are two calls with independent clones, so no object is shared (an isolation test checks `Object.is` on drivers).
- **Baseline:** pick the eligible driver with minimum pickup ETA.
- **Urban Pulse:** `scoreDrivers()` from `src/lib/allocation.ts` (the same module used by the judge rerank preview; mirrors the SQL weights). Optional proactive repositioning every 15 sim-min, driven by the forecast.
- Event loop per tick: release finished trips → (UP only) reposition → match waiting requests FIFO → apply the response roll → on reject or no-response, exclude that driver and retry next tick → request abandons after 10 min unmatched (counted as unserved).

## Metric dictionary
| Metric | Formula | Window / denominator | Excludes | Type |
|---|---|---|---|---|
| Match wait | `accepted_at − requested_at` (mean, median) | requests accepted within the horizon | unserved | simulated |
| Pickup wait | `pickup_at − requested_at` | picked-up requests | unserved | simulated |
| Pickup ETA error | `abs(predicted_pickup_eta − actual pickup travel)` | picked-up requests | — | simulated |
| Driver utilization | `Σ busy_min / Σ online_min` (busy = en route to pickup + on trip) | whole horizon, all drivers | — | simulated |
| Completion rate | `completed / submitted` | submitted in the horizon | cancelled, unserved and in-flight shown separately | simulated |
| Empty pickup km | `Σ driver→pickup km` (deadhead only, not idle cruising) | completed + in-flight | — | simulated |
| Allocation spread | per-driver trip counts: min / max / range + Gini `Σ_i Σ_j abs(x_i−x_j) / (2 n² mean)` | all drivers | — | descriptive only, **not proof of fairness** |

An undefined metric (e.g. no completed trips) shows `N/A` with its reason, never 0.

## Honesty rules
- The winner is shown **per metric**. If Urban Pulse is worse on a metric, the UI says so.
- Run metadata (run ID, seed, scenario, algorithm version, timestamp) is shown beside the results, and a rerun with the same seed reproduces them.
- Scenarios are not cherry-picked: all four plus "normal" are runnable, and the seed is editable.
