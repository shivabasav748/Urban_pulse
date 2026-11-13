# Demo Script (3 minutes)

**Setup:** two browser windows. Left: rider `rider@demo.up`. Right: judge console `admin@demo.up`, plus driver `captain1@demo.up` in a third tab if needed. Fast-demo mode is ON. Run `demo_reset()` first. The password is in `.env.local` (dev only), never on slides.

| Time | Action | Say |
|---|---|---|
| 0:00–0:35 | Rider: Rani Channamma Circle → Belagavi Railway Station; ride types show ETA + fare (₹28 bike, labelled simulated service / ₹49 auto / ₹105 cab, fare model v2, surge off); Request | "Nearby drivers from a PostGIS query; distance and ETA are straight-line estimates. The cab fare follows the reported Karnataka app-cab tariff; auto and bike are illustrative. Surge is off unless enabled." |
| 0:35–1:05 | Driver accepts → Arriving → Ongoing; rider tracker updates live | "Realtime from Postgres changes; every transition is validated and logged." |
| 1:05–1:35 | Judge › Chaos: **Reject** on a new ride → attempt 2 → recovery time | "The real reassignment RPC: the driver is excluded, the next-ranked driver is offered." |
| 1:35–2:15 | Arena: seed 42, run → split screen | "Same requests, same fleet, two isolated worlds. Here's where we win, and where we don't." |
| 2:15–2:40 | What-If: Heavy rain → Apply | "Rain is a real model feature: forecast → gap → surge formula → repositioning → rerun." |
| 2:40–3:00 | Pooling: two compatible rides → stop order, savings | "All data is simulated; the logic is real. Limitations are in the README." |

**Pitch line:** Most basic dispatchers choose the nearest available driver. Urban Pulse balances pickup ETA, workload, reliability and idle time, anticipates zone demand, and recovers when rides fail. Dispatch Arena tests both approaches against the same requests, side by side.
