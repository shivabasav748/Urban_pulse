# Demo fares: Belagavi (Belgaum)

**These prices are made up for the demo.** They follow the shape of Indian city meters (a base fare that includes the first stretch, then per-km and per-minute charges), but they are not any operator's or government's tariff. Every fare in the app is labelled simulated.

## Formula
`fare = (base + per_km × max(0, distance − included_km) + per_min × trip_minutes) × surge`, rounded to the rupee.
It is implemented once in SQL (`public._fare`, migration `20261113000005_belagavi.sql`) and mirrored in `src/lib/geo.ts`, and the rider estimate, the captain's offer and the receipt all read the same stored value.

| Vehicle | Base fare | Included distance | Per km after that | Per minute |
|---|---|---|---|---|
| Bike | ₹20 | 1.5 km | ₹6 | ₹0.50 |
| Auto | ₹30 | 1.5 km | ₹13 | ₹1.00 |
| Cab | ₹55 | 2.0 km | ₹17 | ₹1.50 |

**Distance** is an estimate: straight-line distance × 1.35, with no road routing.
**Trip minutes** come from simulated speeds: 28 km/h off-peak and 20 km/h at peak (8–10 AM and 5–8 PM), with bikes 15% faster.
**Surge** (simulated) multiplies the total and is capped at ×2.0; it comes from the zone demand forecast and the free captains nearby.
**Pooling** gives each rider 25% off the cab fare.

## Fare chart (before surge): off-peak / peak
Peak costs a little more only because the time component grows; per-km prices don't change. Bike < auto < cab holds at every distance from 0.3 to 25 km (checked).

| Distance | Bike | Auto | Cab |
|---|---|---|---|
| 1 km | ₹21 / ₹21 | ₹32 / ₹33 | ₹58 / ₹59 |
| 2 km | ₹25 / ₹26 | ₹40 / ₹42 | ₹61 / ₹64 |
| 3 km | ₹32 / ₹33 | ₹56 / ₹59 | ₹82 / ₹86 |
| 5 km | ₹46 / ₹47 | ₹87 / ₹91 | ₹122 / ₹128 |
| 8 km | ₹66 / ₹69 | ₹131 / ₹138 | ₹183 / ₹193 |
| 12 km | ₹94 / ₹99 | ₹192 / ₹202 | ₹264 / ₹279 |
| 15 km | ₹115 / ₹121 | ₹238 / ₹251 | ₹324 / ₹344 |

## Example trips (off-peak, before surge)
Distances use the same estimate as the app. Coordinates are from OpenStreetMap.

| Trip | Est. distance | Bike | Auto | Cab |
|---|---|---|---|---|
| Rani Channamma Circle → Belagavi Railway Station | 2.8 km | ₹31 | ₹52 | ₹77 |
| Khade Bazar → Tilakwadi | 4.1 km | ₹40 | ₹73 | ₹104 |
| Central Bus Stand → KLE Hospital, Nehru Nagar | 3.6 km | ₹36 | ₹65 | ₹94 |
| Tilakwadi → VTU (Machhe) | 10.4 km | ₹84 | ₹168 | ₹231 |
| Rani Channamma Circle → Belagavi Airport (Sambra) | 14.4 km | ₹110 | ₹228 | ₹311 |
| Kakati → Belagavi Railway Station | 12.8 km | ₹100 | ₹204 | ₹279 |
