# Zone intelligence, zone switching and repositioning

All demand is **simulated**. The forecast is model v2 (HistGradientBoosting, MAE 1.0149 vs 1.3077 baseline), trained on synthetic history with seed 42, not on real Belagavi traffic or rides. The eight demand zones are unchanged; see the boundary investigation in `docs/research/`.

## Zone balance (`public.zone_balance()`)
Computed live from the database at the simulated clock, every time it is asked for:

| Field | Definition |
|---|---|
| `predicted_now`, `predicted_next` | model v2 forecast for the current and the next 30-min bucket |
| `pending` | requests waiting in the zone now (status requested or offered) |
| `available` | free captains physically in the zone: online, fresh location, no trip, no pending offer, not en route elsewhere |
| `incoming` | captains with an accepted move into the zone |
| `finishing` | trips in progress that drop off in the zone |
| `demand_30` | `predicted_next + pending` |
| `expected_supply` | `available + incoming + finishing` |
| `shortage` | `demand_30 − expected_supply` |
| `state` | `undersupplied` if shortage ≥ 1; `oversupplied` if spare ≥ 2; otherwise `balanced` |
| `peak` | `demand_30 / max(expected_supply, 1) ≥ settings.peak_ratio (1.5)` and `demand_30 ≥ 2`, worked out from data, not from clock hours |
| `rising` | next bucket at least 15% and at least 0.5 requests above now |
| `pickup_eta_min` | minutes from the nearest free captain to the zone centre |
| `by_category` | free bikes, autos and cabs in the zone |

Physical zone = the nearest zone centre to the captain's current position. The TypeScript mirror (`src/lib/zones.ts`) is unit-tested.

## Captain zone switching
Four separate things are shown to the captain and the judge:
1. **Physical location:** from GPS, a manual pin, or simulated.
2. **Operational zone** (`driver_profiles.op_zone`): changes only when an accepted move is observed to arrive.
3. **Recommended zone:** an open `reposition_moves` row with status `recommended`, including its reason, distance and ETA.
4. **Repositioning status:** `recommended → accepted (en route) → arrived`, or `declined`, `expired` or `cancelled`.

The captain can accept or decline a recommendation (`captain_respond_move`), choose a zone themselves (`captain_request_zone`), or cancel a move (`captain_cancel_move`). Zone requests are refused when the captain is offline, has a stale location, is on a trip, is holding an offer, or is in cooldown, or when the target is the current zone or already oversupplied.

**Arrival must be observed:** a fresh location inside the target zone, no sooner than half the estimated drive. A manual pin dropped straight into the zone doesn't count (tested). Simulated captains in fast-demo mode drive 0.6 km per 10-second tick and are labelled simulated.

## Proactive repositioning (`_reposition_tick`, run by the sweep every 10 s or by the judge's "Run repositioning now")
1. Expire unanswered suggestions (2 min) and moves that have been en route too long (30 min). Cancel moves for captains who went offline, lost their location fix, or took a trip.
2. Cancel suggestions whose target is no longer short, so captains aren't pushed into a zone that has filled up.
3. Plan: the zone with the biggest shortage first. Need = ⌊shortage⌋ minus suggestions already open for that zone (no herding). For each slot, pick the nearest eligible idle captain:
   - online, fresh location, not busy, no open move;
   - outside the 10-min cooldown since their last zone change or answered move;
   - no more than 8 km straight-line away, and **able to arrive within 15 minutes** (`settings.reposition_max_move_min`, migration 0009), so the 30-minute forecast still applies on arrival. Arena, 20 scenarios × 10 seeds: unnecessary switches 3.5 → 1.9 (sum of means), moves 212 → 120, repositioning km 1,400 → 480, completion unchanged (11.40 → 11.42 summed).
   - from a **donor zone that keeps at least one spare captain** above its own 30-min demand (hysteresis);
   - a vehicle category the target has none of is preferred.
4. Every suggestion stores its reason (target demand, supply, shortage, peak, rising).

Captains with an active trip are never repositioned. **Investigated:** the earlier report of up to 4 unnecessary switches came from targets that stopped being short before the captain arrived. Two causes were fixed: long drives (the move cap above) and the Arena under-counting captains about to finish a trip in the zone, which `zone_balance` already counts in SQL. The Arena now mirrors that. A captain who accepts a ride stops repositioning.

## Peak-hour handling
A peak is flagged from the demand/supply ratio, not from the time of day. The judge's **Zone intelligence** tab shows expected demand, captains, shortage, peak and rising flags per zone, the repositioning feed and the dispatch policy. At the 18:00 demo clock every zone is busy, so there may be no donor zone and therefore no suggestion. That is correct behaviour, and the Arena shows repositioning across scenarios.

## Tests
- `pnpm db:safety` sections G, H and H2: anti-teleport, cooldown, hysteresis, no herding, no duplicates, simulated driving.
- Concurrency scenario 5f: two planners and two sweeps at once.
- E2E: "captain switches zone", "peak shortage: the system recommends repositioning…", "Zone intelligence shows…".
