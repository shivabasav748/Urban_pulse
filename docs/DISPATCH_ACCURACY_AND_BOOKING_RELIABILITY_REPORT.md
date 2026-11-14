# Dispatch accuracy and booking reliability report (14 Nov 2026)

Branch `feature/gps-privacy`, on top of 97c3dad. Everything here was run against the **local** Supabase stack only. Nothing was pushed, merged or deployed.

Evidence labels used below:
- **Runtime-tested**: an automated test exercises the behaviour.
- **Source-verified**: confirmed by reading the code, with no dedicated test.

## 1. Summary
- **Silent substitution fixed.** The rider page used to swap the passenger's chosen vehicle for any category that had a captain. It no longer does.
- **Zero-availability categories stay selectable.** They show "0 captains within 2 km".
- **Alternatives need a click.** They appear only as explicit "Choose Auto instead (3 nearby)" buttons.
- **Wider search is always available** while a larger search stage exists, both before booking and after "No captain found".
- **"Booking confirmed" appears only after `rides.status = accepted`,** i.e. once the acceptance has been written to the database.
- **Demo auto-accept is labelled in the audit trail.** It uses the same code path as a real captain's acceptance, and only simulated captains are auto-accepted.

## 2. Root causes
| # | Defect | Where | Fix |
|---|---|---|---|
| 1 | The chosen category fell back to any category that had drivers (silent substitution) | `RiderPage.tsx`: `chosen = find(cat && drivers>0) ?? find(drivers>0)` | `chosen = find(c => c.category === cat)`, with no fallback |
| 2 | Zero-availability categories were `disabled` | the ride-type radio buttons | Always selectable; Confirm is disabled with "No Cab captains within 2 km" |
| 3 | The wider-search button was hidden whenever the substituted category had drivers | `nextRadius && chosen.category !== cat` | Shown whenever a larger stage exists: "Search for more Cab drivers within 3 km" |
| 4 | After `no_driver_found` the search area couldn't be widened | `retry_ride(p_ride, p_drop_preference)` | Migration 0011 adds `p_radius_m` (2000/3000/5000; can only grow; category unchanged) |
| 5 | Auto-accept and captain acceptance were indistinguishable in the audit log | `_accept_offer` | 0011: `offer_accepted.payload.acceptance` is `captain` or `simulated_auto_accept` |
| 6 | On a fresh `db reset`, simulated captains had `location_source='manual'` and no timestamp, so **no ride could ever be dispatched** | `seed.sql` inserts drivers *after* migration 0004 has set `'simulated'` | The seed now sets `location_source = 'simulated'` |
| 7 | Rider status copy didn't match the lifecycle | `riderMessage`, `STATUS_TEXT` | See section 6 |

## 3. Vehicle category integrity (Phase 2)
- **Frontend:**
  - It sends exactly the selected category.
  - It cannot book a category with 0 captains.
  - The ride tracker shows the requested category.
- **Backend (runtime-tested, SQL K1):**
  - A cab request with only an auto nearby ends in `no_driver_found`.
  - No offer is made to the auto, and the ride's category stays `cab`.
  - An unknown category is refused.

## 4. Search radius (Phase 3)
- There is one configuration everywhere: `RADII = [2000, 3000, 5000]` in the frontend and `trip_groups.search_radius_m check in (2000,3000,5000)` in the database. The maximum was not raised.
- **Before booking:** widening re-queries `estimate_ride` at the new radius and keeps the selected category. (Runtime-tested: e2e "no cab nearby".)
- **After no_driver_found (runtime-tested, SQL K3):**
  - `retry_ride(p_radius_m => 3000)` updates the group's radius and offers the cab 2.5 km away.
  - The captain who rejected the ride is not offered it again; `_rank` excludes captains already tried for this group.
  - Shrinking the radius, or passing an invalid one, is refused.

## 5. Long trips, pickup distance vs trip distance (Phases 4–5)
- **Source-verified:**
  - Eligibility in `_rank` uses only the **pickup** distance (`ST_DWithin` around the pickup), plus online status, location freshness, category, not busy, no pending offer, not already tried, and the women-driver preference.
  - Trip distance is never used as a filter.
  - The shortlist is the 8 nearest captains, scored with the urban_pulse weights 0.45/0.25/0.20/0.10. Both are unchanged.
- **Runtime-tested (SQL K2):** RCC→VTU (cab and bike) and RCC→Sambra Airport (auto) are each offered to a captain of the requested category, with trip distance > 10 km and pickup ETA < 5 min.
- **Runtime-tested (e2e):** RCC→VTU as an auto stays an auto end to end.
- **Known, deliberate gap:** the estimate counts captains on privacy-snapped grid cells (0.003°), while dispatch uses exact distances. A captain near the edge of the search area can therefore be counted in the estimate but miss dispatch. The privacy design is kept. Recovery is the accurate "No captain found" message plus a wider-search retry.

## 6. Confirmation and status messages (Phase 6)
| Status | Heading | Detail |
|---|---|---|
| requested | Finding your captain | Matching you with the best {Cab} captain nearby. |
| offered | Waiting for acceptance | The best available captain has been notified. Waiting for acceptance. |
| requested after a failure | Finding another captain | Your previous captain became unavailable. Finding another captain. |
| accepted | **Booking confirmed** | (comes only from the persisted `accepted` status) |
| arriving | Your captain is on the way | |
| no_driver_found | No captain found | No eligible captain is currently available for your selected vehicle (Cab). |

## 7. Demo auto-accept (Phase 7)
- **Runtime-tested (SQL K4):**
  - The `sweep_exceptions` auto-accept calls `_accept_offer(id, true)`, which takes the same locks and runs the same checks as `respond_offer`.
  - It only selects offers where `dp.is_simulated`.
  - A real captain's offer stays `offered` after a sweep and is accepted only through `respond_offer`; the audit records `captain`, with exactly one accepted offer.
- Concurrency (16/16 scenarios) shows no duplicate acceptances.
- No demo settings were changed in any shared database.

## 8. Routing (Phase 8)
- Fares and ETAs still use straight-line distance × 1.35; no fare assumption changed.
- **Display only:** the map now draws the road route from the public OSRM demo server (`src/lib/road.ts`).
  - Coordinates are rounded to about 11 m.
  - There is a 4-second timeout, with the straight line as fallback.
  - No new dependency.
  - The public demo server is not for production; self-host OSRM or use a licensed router.

## 9. Simulation smoothness, vehicle marker, contact (added 14 Nov at the team's request)
- **Jerking:**
  - `FitTo` used to re-fit the map whenever any point changed (each poll or sweep). It now re-fits only when the trip stage changes (`fitKey`).
  - Markers glide instead of teleporting.
- **Vehicle:**
  - A top-down cab, auto or bike SVG with a ground shadow and halo, rotated to the road heading (`Vehicle.tsx`).
  - It moves imperatively in `requestAnimationFrame`, so React doesn't re-render per frame.
  - Simulated captains glide along the road on the server's stage clock. Migration 0013 replaces the hard-coded 6 s step with `settings.sim_step_s`, default 10 s.
  - Real captains' GPS positions are snapped onto the road.
  - Reduced-motion is respected.
- **Contact:**
  - Migration 0012 adds `ride_messages` and `send_ride_message`.
  - Only the ride's rider and assigned captain can read or send, and only during accepted/arriving/ongoing.
  - Quick replies are provided. No phone numbers are stored.
  - "Call" explains that masked calling needs a telephony provider and is not connected in the demo.
- **Judge page:**
  - Four main views: City overview, Live trips, Why this captain?, Safety. The rest sit under "More tools", and each view has a one-line explanation.
  - The zone table became a ranked list ("Needs 4 more · busy"). The full numbers and the policy maths are behind expanders.

## 10. Database safety (Phase 9)
- **Migrations:**
  - 0011–0013 are forward-only and add new objects or `create or replace`; no historical migration was edited.
  - A `pg_dump` backup was taken before 0011 and before 0012.
  - All were applied only to the local stack at 127.0.0.1:54322.
- **SQL tests** run in one transaction and roll back.
- **Concurrency harness:** it now removes only its own `conc%@test.up` riders at start, as well as in `finally`.
- **Incident:** a Docker Desktop update removed the local containers.
  - On `supabase start` the CLI rebuilt the **local** database from migrations and seed.
  - The 21 seeded demo accounts (3 riders, 17 captains, 1 judge) are intact; earlier local-only ride history was lost.
  - The hosted project was not touched.
  - This incident is what exposed root cause 6.

## 11. Tests added
- **SQL section K (13 checks):** category integrity, unknown category, long trips for each category, pickup vs trip distance, radius stages, non-shrinking radius, no re-offer after reject, auto-accept labelling, real captain never auto-accepted.
- **e2e/booking.spec.ts (4 tests):** Auto and Bike auto-accept → "Booking confirmed"; no cab → no substitution, explicit alternative, wider search books a cab at 3 km; long route keeps the category.
- **Coverage of the remaining brief scenarios:**
  - Scenario 1 (captain accepts): core.spec "captain accepts…".
  - Scenario 6 (reject → second cab): core.spec reject test.
  - Scenario 8 (concurrency): `pnpm db:concurrency`.
- **Unit:** `src/lib/road.test.ts` covers the route walking and GPS snapping maths.

## 12. Results (14 Nov, local)
- `pnpm test` 44/44.
- typecheck, build and lint: 0 errors.
- `db:safety` 78/78; `db:privacy` 28/28; `db:smoke` OK.
- `db:concurrency` 16/16 scenarios, 495/495 rounds, 0 deadlocks.
- **E2E core + features + judge + booking: 21/21.**
  - "peak shortage" failed once in one run order and passed on rerun and alone. Treat it as flaky; it is order-sensitive through repositioning state.
- **Visual:** rider-arriving and judge checked at 390 and 1440 px. The full 360/390/430/768/1440 sweep was not re-run after these changes.

## 13. Files
- **Migrations:** `supabase/migrations/20261114000011_booking_reliability.sql`, `…12_ride_messages.sql`, `…13_sim_step.sql`; `supabase/seed.sql`.
- **Frontend:**
  - `src/pages/rider/RiderPage.tsx`, `src/components/ride/bits.tsx`, `src/components/ride/Contact.tsx`.
  - `src/components/map/MapCanvas.tsx`, `src/components/map/Vehicle.tsx`, `src/lib/road.ts`, `src/index.css`.
  - `src/pages/driver/DriverPage.tsx`, `src/pages/judge/JudgePage.tsx`, `src/pages/judge/ZoneIntelTab.tsx`.
- **Tests:**
  - `supabase/tests/safety_dispatch.sql`, `supabase/tests/concurrency.ts`.
  - `e2e/booking.spec.ts`, plus `e2e/core|features|judge|visual.spec.ts` updated for the new copy.
  - `playwright.config.ts` (`E2E_PORT`).

## 14. Open items
- The full five-width visual sweep has not been re-run since the map and judge changes.
- Masked calling needs a telephony provider.
- The public OSRM server should be replaced before any real traffic.
- The peak-shortage e2e is order-sensitive.
- The hosted Supabase project needs migrations 0011–0013 applied there before the hosted demo shows these changes. Not done: it needs your go-ahead.

## 15. Addendum: shared rides, women-driver demo data, quick tries, traffic (migrations 0014–0015)
- **Women-driver preference.**
  - Demo opt-ins are now the fictional SIMULATED captains presented as women: Farah, Lakshmi, Divya (cab), Sneha, Pooja (bike), Ayesha, Tanvi (auto).
  - The previous set was every third plate, which showed men's names on women-driver matches.
  - Farah (cab) and Sneha (bike) are near Rani Channamma Circle; Lakshmi (cab), Tanvi (auto) and Pooja (bike) are near JCER, Machhe.
  - Runtime-tested: SQL L1 and e2e "woman driver requested" (Captain Farah arrives).
- **Quick tries in busy areas.**
  - When the pickup zone is undersupplied or at peak, each offer lasts `settings.quick_offer_s` (10 s) instead of 15 s, within the existing 5-try limit.
  - The offer event records `quick`, `timeout_s` and `max_attempts`.
  - The rider sees a live clock, "Try N of 5" and a progress bar.
- **Captain actions.**
  - Accept, Ignore (`ignore_offer`: recorded as no response, next captain at once) and Decline.
  - Cancel after accepting re-dispatches immediately (`driver_cancel` → `_release`).
  - Runtime-tested: SQL L2.
- **Shared rides.**
  - `request_shared_ride` pairs with a compatible shared request: pickups ≤ 2 km and drops ≤ 3.4 km apart, best of the 4 valid stop orders, each detour ≤ 40%.
  - Each co-rider pays 75% of their solo cab fare. The captain gets one shared trip to accept or decline.
  - Fast-demo only: `demo_add_corider` adds a SIMULATED co-rider from a free demo rider account through the same path.
  - Runtime-tested: SQL L4 and e2e "shared cab".
- **Why this captain.**
  - `why_my_captain` returns only the rider's own accepted offer: score parts, ETA and distance, how many were compared, workload, acceptance and safety. It includes no captain ids and is refused for anyone else (SQL L3).
  - The profile panel (experience, rating, trips, languages) is **made-up demo data**, labelled as such, and is never used in matching.
- **Traffic map.** `zone_traffic()` gives each zone a level of heavy (red), moderate (yellow) or low (green) from expected riders vs captains. It is shown on the rider and captain maps with a legend.
- **JCER, Machhe.**
  - Added as an approximate landmark; OpenStreetMap has no entry for the college, so the position is placed near Hunchyanatti Cross.
  - "Use my current location" keeps a precise fix (±300 m or better) inside Belagavi. Otherwise it uses JCER, Machhe and says so.
- **Results after these changes:**
  - SQL safety 88/88, privacy 28/28, smoke OK.
  - Concurrency 16/16 (495 rounds).
  - E2E core + features + judge + booking 23/23.
  - Unit 44/44; typecheck, lint and build clean.
