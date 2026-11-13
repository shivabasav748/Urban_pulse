# Fairness and allocation

The score is a **transparent prototype policy**, not a claim of fairness. What it does, and what the evidence shows, is below.

## What the score balances
- Pickup time (0.45), workload today (0.25), acceptance reliability with a prior (0.20), and idle time (0.10).
- With the zone-aware policy, a 0.15 zone-balance term on top (see DISPATCH_ALGORITHM.md).
- Each component is normalised across the eligible candidates, and every decision is stored with its components. The judge can re-score it with different weights in the Allocation tab.

## What the score never uses
- Gender, the women-rider opt-in, safety feedback or safety reports.
- The opt-in is only an eligibility filter, and only for requests that ask for it. Unreviewed reports and low ratings never reduce a captain's offers.

## Evidence (Dispatch Arena v3, simulated; 20 scenarios × 10 seeds; `scripts/arena-study.ts`)
Policies:
- **A:** nearest driver, no repositioning.
- **B:** four-part score with the greedy 15-min forecast planner.
- **C:** zone-aware score with the live shortage planner (hysteresis, cooldown, 15-min move cap).

Mean ± standard deviation over seeds, for selected scenarios (the full table is in the study output):

| Scenario | Match wait min (A / B / C) | Completion (A / B / C) | Zone imbalance (A / B / C) | Captain net ₹/online h (A / B / C) |
|---|---|---|---|---|
| Normal weekday | 0.89 / 0.92 / 0.93 | 77.2 / 77.0 / 77.0% | 2.10 / 1.75 / 1.77 | 62 / 48 / 57 |
| Evening peak | 2.76 / 3.00 / 3.06 | 53.7 / 55.2 / 53.9% | 2.48 / 2.00 / 2.26 | 72 / 64 / 70 |
| Station spike | 3.94 / 4.25 / 4.14 | 51.0 / 52.7 / 51.0% | 2.70 / 2.26 / 2.61 | 76 / 68 / 74 |
| Several zones short | 3.34 / 3.39 / 3.76 | 51.2 / 54.3 / 51.5% | 3.07 / 2.12 / 2.74 | 70 / 59 / 64 |
| Captains offline | 3.19 / 3.57 / 3.71 | 49.8 / 50.4 / 50.6% | 2.60 / 2.28 / 2.52 | 83 / 72 / 78 |
| High density (60 cabs) | 0.90 / 0.88 / 0.90 | 75.2 / 76.3 / 76.3% | 3.94 / 3.50 / 3.50 | 58 / 40 / 56 |

Typical seed-to-seed spread is ±0.5 min on wait and ±5 points on completion, so many differences above are within noise.

**Best mean per (scenario, metric) cell**, over 13 metrics × 20 scenarios: **A 89, B 110, C 35.**

Head-to-head, C vs B by scenario:
- **C better on captain net earnings** in 19 of 20 scenarios (it drives about 75% fewer repositioning kilometres).
- **C worse** on match wait (16 of 20), pickup wait (19), completion (15), zone imbalance (19) and Gini (17).

**Ablation** (5 seeds × 20 scenarios):
- The **zone term in the score** adds about 0.3 min of pickup wait with either planner.
- The **planner** is a real trade-off: greedy gives about +1.3 points of completion and lower imbalance, but 3.5× the empty repositioning km and about ₹7/h less for captains.

**Decisions taken:**
- **Score:** the live per-ride score defaults to B's four-part score (migration 0010).
- **Repositioning:** the conservative zone planner stays live; it protects driver earnings and stops oscillation (unnecessary switches: B up to 6.5 per run in high density, C 0.2).
- **Shortlist:** applied to every scored policy.

Preference scenarios are evaluated separately: **0 violations** for every policy and seed.

## Limitations
Everything is simulated: synthetic demand, straight-line routes × 1.35, made-up captain behaviour and 28-cab fleets. These results compare policies against each other; they don't predict real-world performance.
