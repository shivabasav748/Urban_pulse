# Fare economics and market benchmark

Retrieved 13 Nov 2026. **Every price in the app is a simulated demo fare.** Sources are listed with their confidence. "As reported" means the primary government document was not retrieved and the figure comes from news or legal-news coverage.

## 1. What changed (fare model v1 → v2, migration 0009)
| | v1 (until 13 Nov) | v2 (now) | Why |
|---|---|---|---|
| Cab | ₹55 for 2 km + ₹17/km + ₹1.50/min, × surge | **₹100 for the first 4 km + ₹24/km**, +10% between 00:00 and 06:00, **+5% GST**, tolls extra; **no per-minute charge** | Karnataka's statewide app-cab tariff for vehicles up to ₹10 lakh (order of 3 Feb 2024, gazetted 5 Feb 2024, as reported). It has no journey-time charge, only a waiting charge. |
| Auto | ₹30 for 1.5 km + ₹13/km + ₹1/min | **₹30 for the first 1.5 km + ₹15/km**, illustrative | The Belagavi auto tariff could not be verified (see §3); the per-minute charge was removed. |
| Bike | ₹20 for 1.5 km + ₹6/km + ₹0.50/min | **₹20 for the first 1.5 km + ₹6/km**, illustrative, **simulated service** | No bike-taxi permits are verified in Karnataka (§3). The UI labels bike as a simulated service. |
| Surge | always applied (zone formula, cap 2×) | **off by default**; when the judge enables it, capped at 2× | The Karnataka cab order bars extra charges, and the state has restricted surge before. The MoRTH 2025 guideline caps dynamic pricing at 2× the base fare. |

The same formula runs in Postgres (`public._fare`) and TypeScript (`src/lib/geo.ts`), checked by SQL tests (section J) and unit tests. Rides already booked keep the fare stored at booking.

**Fare formula:**
`pre-tax = round((minimum + perKm × max(km − included, 0) + night) × surge)`, `GST = round(pre-tax × 5%)` (cab only), `total = pre-tax + GST`.
- The night charge applies only to cabs, at 10% between 00:00 and 06:00 on the simulated clock.
- Surge is 1 unless enabled.
- Every component is rounded to the rupee.

**Fare chart** (straight-line distance × 1.35, so these are estimates, not road distances):

| km | 1 | 2 | 3 | 4 | 5 | 8 | 10 | 15 | 20 |
|---|---|---|---|---|---|---|---|---|---|
| Bike | 20 | 23 | 29 | 35 | 41 | 59 | 71 | 101 | 131 |
| Auto | 30 | 38 | 53 | 68 | 83 | 128 | 158 | 233 | 308 |
| Cab | 105 | 105 | 105 | 105 | 130 | 206 | 256 | 382 | 508 |

### Not charged in the demo (documented gaps)
- **Waiting charge:** the cab order says 5 minutes free, then ₹1/min. The app has no "arrived at pickup" timestamp, so waiting time can't be measured. It is not charged; this is listed as remaining work.
- **Cancellation fee:** MoRTH 2025 reports 10% of the fare, capped at ₹100, for cancellations without a valid reason. Karnataka adoption is not found, so no fee is charged.
- **Tolls:** extra and not modelled. There are no tolled roads on the demo routes.

**Quote validity:** the price is fixed at booking (an upfront fare), so the estimate equals the final fare. Night status and surge are read when the fare is computed.

## 2. Worked examples (6 PM on the demo clock, surge off; 1.5 km empty pickup)
| Route (estimated km) | Fare (night) | Driver payout (80% ex-GST) | Vehicle cost | **Driver net** | Net per hour of the ride | Platform contribution |
|---|---|---|---|---|---|---|
| Rani Channamma Circle → Railway Station (2.76 km), bike | ₹28 (28) | ₹22.40 | ₹13.28 | **₹9.12** | ₹45 | ₹1.82 |
| same, auto | ₹49 (49) | ₹39.20 | ₹24.01 | **₹15.19** | ₹69 | ₹5.43 |
| same, cab | ₹105 (116) | ₹80.00 | ₹31.71 | **₹48.29** | ₹218 | ₹14.10 |
| Rani Channamma Circle → Airport Sambra (14.38 km), bike | ₹97 | ₹77.60 | ₹49.53 | **₹28.07** | ₹40 | ₹13.96 |
| same, auto | ₹223 | ₹178.40 | ₹89.54 | **₹88.86** | ₹111 | ₹36.39 |
| same, cab | ₹366 (403) | ₹279.20 | ₹118.28 | **₹160.92** | ₹201 | ₹58.48 |

- "Net per hour of the ride" counts only the trip and pickup time. Across a whole shift, idle time and repositioning bring it down: the Arena reports **₹35–83 per online hour** for cabs (§5).
- **Bike rides barely cover the platform's costs** (₹1.82 contribution after the illustrative ₹3 support cost). This is a real finding for an illustrative tariff, not a bug.

## 3. Regulatory and market sources
| Topic | Finding | Source and date | Confidence |
|---|---|---|---|
| Karnataka app-cab fares | Slabs: ≤₹10 lakh vehicle cost ₹100 for 4 km + ₹24/km; ₹10–15 lakh ₹115 + ₹28; >₹15 lakh ₹130 + ₹32. Waiting 5 min free then ₹1/min; +10% from 00:00 to 06:00; 5% GST and tolls may be collected; no other extra charges. | The Week, 4 Feb 2024 (theweek.in). The order is dated 3 Feb 2024 and gazetted 5 Feb 2024 per a search snippet. Notification number not found. A search snippet claimed a later High Court ruling set the order aside: **unverified**. | Medium (single news source); applies statewide per the report |
| Demo cab class | Maruti Dzire ₹6.31–9.54 lakh, Hyundai Aura ₹6.00–8.67 lakh, Toyota Glanza mostly under ₹10 lakh, so **band 1** fits. Maruti Ertiga CNG (₹10.94–12.00 lakh) would be band 2 (₹115 + ₹28). | cardekho.com overviews, 13 Nov 2026 | Medium |
| Belagavi auto fare | **₹37 for 1.6 km: not found** in any source. 2022 report: ₹25 minimum for 1.5 km, with the DC ordering meters. Nov 2024 report: meters still not enforced. | thegoan.net 28 Sep 2022; newskarnataka.com 15 Nov 2024 (snippet) | Low; **auto tariff unverified** |
| Bike taxis | High Court Division Bench, 23 Jan 2026 (*Uber India Systems v. State of Karnataka*, WA 848/2025 and batch) set aside the blanket ban; registration and permits must be considered. The state filed an SLP (Apr 2026) and resumed enforcement around Aug 2026. No permits found. | livelaw.in (fetched); Bar & Bench; Deccan Herald (snippet) | Medium; **treat as not permitted** |
| Dynamic pricing | MoRTH Motor Vehicle Aggregator Guidelines 2025, cl. 16: between 50% and 200% of the state base fare. Karnataka adoption not found. | scconline.com 4 Jul 2025; Business Standard; Entrackr | Medium (clause numbers from a secondary source) |
| Driver share | At least 80% of the fare for driver-owned vehicles; 60% for aggregator-owned (MoRTH 2025). No Karnataka-specific rule found. | Business Standard, The Week, scconline.com | Medium-high |
| Cancellation | 10% of the fare, capped at ₹100, applies to drivers and riders (MoRTH 2025, cl. 17 per secondary source) | scconline.com | Medium |
| Gig-worker welfare fee | Karnataka Platform-based Gig Workers Act 2025: ride-hailing **1% of payout**, capped at ₹0.50 (2-wheeler), ₹0.75 (3-wheeler) and ₹1.00 (4-wheeler) per payout; notified 16 Feb 2026, applicable from 13 Feb 2026 | scconline.com 18 Feb 2026 (fetched) | Medium |
| Women-driver option | MoRTH amendment (about 15 Dec 2025), cl. 15.6: passengers may choose a same-gender driver where available. Karnataka adoption not found. | inc42, lokmattimes, livelaw (secondary); MoRTH PDF not readable | Medium |
| Competitors in Belagavi | Rapido (bike, auto, cab) and Ola (bikes, autos, sedans) list categories nationally but don't name Belagavi on public pages. The Uber Belgaum page returns 404, and the India city list was truncated before the "Be" entries. No public fare figures. | rapido.bike, olacabs.com, uber.com, 13 Nov 2026 | Availability unconfirmed |

**Competitor prices: not captured.** Route quotes need the apps (login and location). **No competitor price appears anywhere in this project.** To benchmark, please capture these screenshots on a phone in Belagavi, for each of Rapido, Uber and Ola (whichever operate):
- Rani Channamma Circle → Belagavi Railway Station and Rani Channamma Circle → Belagavi Airport;
- for bike, auto and cab (each category shown);
- at about 9 AM, 2 PM and 7 PM on a weekday.

Record the date, local time, quoted fare, ETA and any surge or "high demand" label.

## 4. Driver and platform economics model (`src/lib/economics.ts`)
**Energy prices, Belagavi, 13 Nov 2026:**
- **Petrol:** ₹110.71/L (goodreturns.in and cardekho.com agree).
- **Diesel:** ₹98.67/L (cardekho.com); other trackers show ₹100.10.
- **CNG:** ₹105/kg (cardekho.com, one source).
- **Electricity:** about ₹7.5/kWh, an assumption based on Karnataka public-charger listings of ₹7.0–8.3; no Belagavi rate was found.
- **Auto LPG:** no Belagavi price found.

**Vehicles:**
- **Claimed efficiency** comes from listings: Dzire CNG 35.63 km/kg, Dzire petrol 25.15 km/l, Aura CNG 22 km/kg, Bajaj RE CNG 37.5 km/kg (a low-confidence aggregator listing), Mahindra Treo 141 km per 7.37 kWh, Splendor Plus 70 km/l, Activa 59.5 km/l.
- **Real-world factor:** 0.80 (low cost), 0.72 (base) and 0.65 (high cost) of the claimed figure. The 25–35% city shortfall is from a consumer blog, so it is an **assumption**.
- **Maintenance and tyres per km:** cab ₹0.6, 0.9 and 1.2 (derived from vendor blogs: tyres ₹0.37–0.8/km, service ₹0.25–0.65/km). Auto and bike values are **assumptions; no source was found**.
- **Depreciation:** (price × (1 − residual)) / service life. Life is 250,000 km for a cab, 150,000 km for an auto and 100,000 km for a bike, with 15–25% residual value. All are assumptions.

| Vehicle | Cost per km, low / base / high (₹) | Of which energy (base) |
|---|---|---|
| Dzire CNG (cab default) | 6.74 / 7.45 / 8.19 | 4.09 |
| Dzire petrol | 8.14 / 9.05 / 10.01 | 6.11 |
| Aura CNG | 8.64 / 9.60 / 10.61 | 6.63 |
| Bajaj RE CNG (auto default) | 5.05 / 5.64 / 6.36 | 3.89 |
| Mahindra Treo EV | 2.39 / 2.59 / 2.85 | 0.54 |
| Splendor Plus (bike default) | 2.80 / 3.12 / 3.51 | 2.20 |
| Activa | 3.17 / 3.52 / 3.95 | 2.58 |

**Platform side, per ride:**
- **Driver payout:** 80% of the fare excluding GST.
- **Platform gross:** the remaining 20%.
- **Welfare fee:** 1% of the payout, capped.
- **Payment processing:** 2% of the fare (an **assumption**).
- **Support and operations:** ₹3 per ride (an **assumption**).
- **Contribution** = platform gross − welfare fee − payment cost − support.

**GST is collected for the government and is never counted as platform revenue** (unit-tested). Driver net = payout − (paid km + empty pickup km + repositioning km) × cost per km (unit-tested).

## 5. Fleet-level evidence (Dispatch Arena, simulated, 10 seeds)
The Arena's "captain net earnings per online hour" covers every online minute, including idle and repositioning time. For cabs on the zone-aware live planner it ranges from **₹45 (weekend) to ₹78 (low density, captains always busy)**. The nearest-driver baseline earns captains more per hour (₹49–83) because it repositions nobody. The greedy planner earns the least (₹34–79), because repositioning drives empty kilometres. See docs/FAIRNESS_AND_ALLOCATION.md.

At about ₹50–80 per online hour, a full-time cab captain in this simulation would earn well below typical expectations. The simulated demand per captain is low: about 28 cabs serve about 120 requests per 2 hours. This is a statement about the synthetic market, not about Belagavi.

## 6. Surge and incentive safeguards
- Surge is off by default. When enabled it is capped at 2× in SQL and TypeScript and shown as a separate line, with "simulated" on the rider's fare breakdown.
- Zone surge numbers are shown to the judge as a demand-pressure index whether or not riders are charged.
- There are no driver incentives or bonuses. Repositioning suggestions are optional, have a 15-minute drive cap and a 10-minute cooldown, and move only donors that have spare supply. That limits empty mileage: the zone planner drove 480 km of repositioning across all scenarios against 1,400 km uncapped (switch study).

## 7. Remaining dependencies
- The primary Karnataka cab fare notification (number and any later amendment or court order).
- The Belagavi RTA auto tariff and meter status.
- Bike-taxi permits.
- Karnataka adoption of the MoRTH 2025 guidelines (dynamic pricing, cancellation, women-driver option).
- Competitor screenshots (§3).
- A measured captain-arrival time, needed to charge waiting time.
