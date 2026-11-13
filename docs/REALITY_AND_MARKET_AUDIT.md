# Reality and market audit (13 Nov 2026)

What this audit checked, what was wrong, what was fixed, and what still depends on someone outside the codebase. Feature-by-feature evidence is in [FEATURE_ACCEPTANCE_MATRIX.md](FEATURE_ACCEPTANCE_MATRIX.md). Fares and economics are in [FARE_ECONOMICS_AND_MARKET_BENCHMARK.md](FARE_ECONOMICS_AND_MARKET_BENCHMARK.md), and the synthetic data in [DEMO_DATA_SPECIFICATION.md](DEMO_DATA_SPECIFICATION.md).

## 1. Method
- **Code and database:** read the code and migrations 0001–0010.
- **Tests:** reran every suite on the current tree and read the assertions, not just the counts.
- **Simulation:** 10-seed, 20-scenario Dispatch Arena studies plus targeted ablations (`scripts/arena-study.ts`).
- **Desk research:** four parallel read-only research agents: Karnataka and Belagavi fares; bike taxis, the women-driver amendment and driver pay; fuel and vehicle specifications; competitor availability.

Primary government PDFs (MoRTH, the Karnataka Gazette) could not be retrieved: the MoRTH link redirected to a bot-protected page, and transport.karnataka.gov.in was not reached. Wherever a finding rests on news or legal-news coverage, it says "as reported".

## 2. Defects found and fixed in this audit
| # | Finding | Evidence | Fix |
|---|---|---|---|
| 1 | **Cab fare didn't follow the Karnataka app-cab tariff, and every category charged per minute of journey time**, which the reported tariff doesn't allow. | Research §3 of the fare document | Fare model v2 (migration 0009, `geo.ts`): cab ₹100 for 4 km + ₹24/km, night +10%, GST 5%; no per-minute charge; SQL tests J, unit tests |
| 2 | **Surge was always charged** to riders, although the Karnataka order bars extra charges. | Previous `_fare` | Surge off by default (`settings.surge_enabled`), capped at 2× when enabled; judge toggle; surge relabelled as a demand-pressure index |
| 3 | **Bike was shown as a normal commercial service**, though no Karnataka bike-taxi permits are verified. | Research | "SIMULATED SERVICE" tag, a permit notice and an illustrative tariff label |
| 4 | **Allocation flaw at scale:** min–max ETA normalisation across a wide candidate set made ETA nearly irrelevant. At 250 captains the score pulled distant captains (pickup wait 4.65 min against 2.14 for nearest-driver). | Arena stress study | Shortlist the nearest 8 before scoring (0009 `_rank`; Arena mirrors it). Result 2.33 min. SQL test "exactly the 8 nearest are scored"; unit test |
| 5 | **The zone-aware score term didn't help:** C was worse than B on pickup wait in 19 of 20 scenarios. | 10-seed study and ablation | Live default switched back to the four-part score (0010). The zone term stays judge-selectable. Documented in FAIRNESS_AND_ALLOCATION.md |
| 6 | **Unnecessary zone switches:** caused by long drives (the target changed before arrival) and by the Arena missing captains about to finish a trip in the zone. | Switch study | 15-min move cap (0009 `_reposition_tick`); Arena counts finishing trips like SQL. Unnecessary switches 3.5 → 1.9 and repositioning km 1,400 → 480 across 20 scenarios × 10 seeds, with no loss in completion |
| 7 | **The Arena treated every captain as always available.** | Code | Shifts (15% start late) and breaks (25% take 20 min); breaks fail pending offers, which are reassigned |
| 8 | **Captain earnings showed gross fares only.** | DriverPage | Earnings sheet now shows passenger fares, the 80% payout ex-GST, estimated vehicle cost for paid and empty km, and estimated net |
| 9 | **No driver or platform economics anywhere.** | — | `src/lib/economics.ts` (sourced energy prices and vehicle claims with low/base/high scenarios); Arena metric for captain net per online hour; unit tests reconcile fare = payout + platform + GST |
| 10 | **The earlier claim that "greedy one-at-a-time is the right size" was not tested.** | Batch study | Measured: per-tick batch assignment beats one-at-a-time under contention (up to −4 min pickup wait). Documented and classified as simulation-only; live implementation is the next step |
| 11 | **Fare integrity had no explicit test.** | — | SQL J0: riders can't edit a stored fare or insert a ride with their own fare |
| 12 | **v2 training defect:** the rolling mean isn't grouped by zone. | Code read | Affected rows fall outside the train and test windows, so published v2 metrics are unchanged. Fixed and tested in v3 |

Earlier work in the same session also fixed migration 0008: repositioning was silently failing on every fast-demo sweep.

## 3. Regulatory and market findings
| Topic | Status | Effect on the demo |
|---|---|---|
| Karnataka app-cab tariff (Feb 2024, as reported) | Applied for cab, band 1 | Notification number and later amendments or court orders are unverified |
| Belagavi auto tariff (₹37 for 1.6 km reported to us) | **Not found**; 2022 report gives ₹25 for 1.5 km; meters not enforced (2024) | Auto fare is illustrative |
| Bike taxis | High Court (23 Jan 2026) lifted the blanket ban, but no permits were found; state SLP and enforcement continue | Bike is a simulated service |
| MoRTH Aggregator Guidelines 2025 | 2× surge cap, 80% driver share, cancellation 10% capped at ₹100, as reported; Karnataka adoption not found | Surge cap and payout share are used; no cancellation fee is charged |
| Women-driver option | MoRTH amendment of about Dec 2025 (cl. 15.6), as reported; Karnataka adoption not found | Our self-declared opt-in is consistent with "where available"; not verified |
| Karnataka gig-worker welfare fee | 1% of payout, capped at ₹0.50, ₹0.75 and ₹1.00 per payout (Feb 2026, as reported) | In the economics model |
| Fuel prices, Belagavi, 13 Nov 2026 | Petrol ₹110.71, diesel ₹98.67 (another source ₹100.10), CNG ₹105/kg | In the economics model |
| Competitors in Belagavi | Rapido and Ola list bike, auto and cab nationally; Belagavi isn't named on public pages; Uber's Belgaum page returns 404 | **No competitor prices used.** The fare document lists the screenshots needed |

## 4. Routing and ETA realism
- **How distance and ETA are computed:** straight-line distance × 1.35, with speed of 20 km/h at peak or 28 km/h off-peak (bikes ×1.15).
- **How the UI labels it:**
  - The map chip says "Estimated route · straight-line, not road".
  - The fare details say "a straight-line estimate × 1.35, not a road route".
  - ETAs are shown as "est.".
  - No screen claims live traffic.
- **What remains:** a real road-network router (OSRM or Valhalla on OpenStreetMap data, both open-licensed) is the next step. TomTom stays blocked until its licence and pricing are confirmed, and the boundary study area has been agreed (see the research folder).

## 5. Physical-device checklist (needs a person with an Android phone)
Prerequisites:
- `pnpm cert:dev`, then install `certs/ca.crt` on the phone (Settings → Security → Encryption & credentials → Install a certificate → CA certificate).
- Open TCP 5173 on the laptop firewall, then run `pnpm dev:https`.
- Phone and laptop on the same Wi-Fi; open `https://<laptop-LAN-IP>:5173`.

| # | Step | Expected |
|---|---|---|
| 1 | Rider: tap "Use my current location" and allow "Precise" | Pickup = "Current location · ±N m"; the warning appears if accuracy is worse than 100 m |
| 2 | Allow "Approximate" only (Android 12+) | Accuracy hundreds of metres; low-accuracy warning shown; manual pin still works |
| 3 | Deny permission | "Location permission was denied…" message; search and map-pin still work |
| 4 | Turn GPS off in quick settings, then retry | "Location unavailable" message; recovers after GPS is turned back on and retried |
| 5 | Indoors, or a weak signal | Accuracy over 100 m → the captain isn't matched (server rule); the UI explains why |
| 6 | Captain: Go online with GPS | ONLINE; "GPS · ±N m · sent Xs ago" updates about every 10 s or 30 m |
| 7 | Captain: lock the screen for 2 minutes | Location goes stale after 90 s → not matched; a pending offer is reassigned |
| 8 | Captain: Go offline | Location sharing stops (rider and judge no longer see a fresh position) |
| 9 | Captain: accept a zone move and physically drive into the zone | Status "En route" → "arrived" only after the GPS fix is inside the zone and at least half the estimated drive time has passed |
| 10 | Captain: drop a manual pin into a zone straight away | Must **not** count as arrival (anti-teleport) |
| 11 | Rider and captain on two phones: full trip | Live captain marker on the rider map; status steps update without a refresh |

None of these have been performed yet. Desktop Chrome emulation is not evidence that Android GPS works.

## 6. Remaining external dependencies
- **Government documents:** the primary Karnataka cab-fare notification and the Belagavi RTA auto tariff.
- **Permits:** confirmation of bike-taxi permits.
- **State adoption:** whether Karnataka has adopted the MoRTH 2025 guidelines and the women-driver amendment.
- **Competitor quotes:** the screenshots listed in the fare document.
- **Physical testing:** the phone checklist above.
- **Approvals:** for the KGIS study area and the Cantonment question.
- **TomTom:** licence and pricing confirmation.
