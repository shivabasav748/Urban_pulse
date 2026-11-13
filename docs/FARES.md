# Demo fares: Belagavi (Belgaum), fare model v2

**Every fare in the app is a simulated demo fare.** Model v2 (migration `20261113000009`) replaced the 13 Nov v1 tariff after the reality audit. The reasoning, sources and economics are in [FARE_ECONOMICS_AND_MARKET_BENCHMARK.md](FARE_ECONOMICS_AND_MARKET_BENCHMARK.md).

## Formula
`pre-tax = round((minimum + per_km × max(0, km − included_km) + night) × surge)`, `total = pre-tax + GST`.
- **No per-minute journey charge.**
- **Night:** +10% between 00:00 and 06:00 on the simulated clock, cabs only.
- **GST:** 5%, cabs only.
- **Surge:** 1 unless the judge turns it on; then it is capped at 2×.

The formula is implemented in SQL (`public._fare`) and mirrored in `src/lib/geo.ts`. The estimate, the captain's offer and the receipt all read the value stored at booking.

| Vehicle | Minimum fare | Included | Per km after | Basis |
|---|---|---|---|---|
| Bike | ₹20 | 1.5 km | ₹6 | Illustrative; **simulated service** (no bike-taxi permits verified in Karnataka) |
| Auto | ₹30 | 1.5 km | ₹15 | Illustrative (Belagavi auto tariff not verified) |
| Cab | ₹100 | 4 km | ₹24 | Karnataka app-cab tariff for vehicles up to ₹10 lakh (Feb 2024 state order, as reported), + 5% GST, tolls extra |

**Distance** is an estimate: straight-line × 1.35, with no road routing. **Pooling** gives each rider 25% off the cab fare.

## Fare chart (surge off, daytime)
| km | 1 | 2 | 3 | 4 | 5 | 8 | 10 | 15 | 20 |
|---|---|---|---|---|---|---|---|---|---|
| Bike | 20 | 23 | 29 | 35 | 41 | 59 | 71 | 101 | 131 |
| Auto | 30 | 38 | 53 | 68 | 83 | 128 | 158 | 233 | 308 |
| Cab | 105 | 105 | 105 | 105 | 130 | 206 | 256 | 382 | 508 |

## Example trips
| Trip | Distance (est.) | Bike | Auto | Cab (night) |
|---|---|---|---|---|
| Rani Channamma Circle → Belagavi Railway Station | 2.76 km | ₹28 | ₹49 | ₹105 (₹116) |
| Rani Channamma Circle → Belagavi Airport (Sambra) | 14.38 km | ₹97 | ₹223 | ₹366 (₹403) |

Not charged in the demo: waiting time (₹1/min after 5 min under the cab order; captain arrival isn't measured), cancellation fees (Karnataka adoption of the MoRTH rule not found) and tolls.
