# Product Scope: Urban Pulse

## Roles and journeys
- **Rider:** sign up/in → choose pickup and drop (demo places or map click) → see nearby drivers, pickup ETA, trip time/distance, fare per category → request → track `requested → offered → accepted → arriving → ongoing → completed` (with attempt # on reassignment) → fare breakdown → history. Can cancel before pickup.
- **Driver / Captain:** sign up/in → go online → location simulated (seeded position, optional "drive to pickup" simulation) → receive offer (pickup, drop, pickup ETA, fare, countdown) → accept/reject → arriving → start → complete → history + utilization.
- **Judge / Admin:** live map, allocation explanations with alternatives and weight sliders, zone intelligence and forecast, pooling, Chaos Mode, metrics, Dispatch Arena + What-If.

## Mandatory advanced features → where shown
| PS 02 feature | Screen |
|---|---|
| A. Demand forecast (trained GBM) | Judge › Zones, Arena |
| B. Zone surge + repositioning | Judge › Zones, rider fare breakdown |
| C. Pooling | Judge › Pooling |
| D. Fair allocation | Judge › Allocation, driver card "why you" |
| E. Reassignment | Rider tracker, Judge › Chaos |

## Assumptions
Belagavi (Belgaum) demo area with 8 zones and 35 named places from OpenStreetMap. 17 seeded captains across Bike/Auto/Cab (16 simulated, 1 real login). Demo fares in docs/FARES.md. All demand, weather, traffic, positions and surge are simulated. Currency is ₹, estimates only.

## Non-goals
Payments/wallets, live traffic or weather, turn-by-turn navigation, real GPS tracking, scheduling/rentals/outstation/parcel, tipping, multi-language, copying any competitor's branding or assets.
