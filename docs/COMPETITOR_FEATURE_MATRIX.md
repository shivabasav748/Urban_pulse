# Competitor Feature Matrix — Urban Pulse

> Labels: ✅ Observed (confirmed in public UI/docs) · ⚠️ Inferred (likely, not confirmed) · ❌ Unavailable / Not found  
> Source: public websites, app store listings, blog posts, press releases. No proprietary data accessed.  
> Purpose: scope differentiation for hackathon PS 02 judges.

---

## Feature Comparison

| Feature | Uber | Ola | Rapido | **Urban Pulse (ours)** |
|---------|------|-----|--------|------------------------|
| **Ride request + driver match** | ✅ | ✅ | ✅ | ✅ Full lifecycle |
| **Real-time driver location** | ✅ | ✅ | ✅ | ⚠️ Simulated + labelled |
| **ETA estimate** | ✅ | ✅ | ✅ | ✅ Haversine × 1.35, hour-based speed |
| **Fare estimate before booking** | ✅ | ✅ | ✅ | ✅ Full breakdown shown |
| **Surge pricing** | ✅ Observed | ✅ Observed | ⚠️ Inferred | ✅ Zone-based, formula transparent |
| **Surge formula shown to user** | ❌ Opaque | ❌ Opaque | ❌ Opaque | ✅ Shown with components |
| **Demand forecasting** | ⚠️ Internal only | ⚠️ Internal only | ❌ | ✅ ML model, MAE vs baseline in UI |
| **Forecast vs actual chart** | ❌ Public | ❌ Public | ❌ | ✅ Admin view |
| **Ride pooling** | ✅ UberPool | ✅ Ola Share | ⚠️ Inferred | ✅ 2-rider, stop-order comparison |
| **Pooling stop-order diagram** | ❌ | ❌ | ❌ | ✅ |
| **Driver allocation scoring** | ❌ Public | ❌ Public | ❌ | ✅ 4-component, bars in UI |
| **Allocation weights editable** | ❌ | ❌ | ❌ | ✅ Admin sliders + live re-rank |
| **Automatic reassignment** | ✅ | ✅ | ✅ | ✅ With attempt counter shown to rider |
| **Reassignment attempt visible** | ❌ | ❌ | ❌ | ✅ |
| **Zone repositioning arrows** | ❌ Public | ❌ Public | ❌ | ✅ Greedy algorithm, Admin map |
| **Full event audit log** | ❌ Public | ❌ Public | ❌ | ✅ `ride_events` table, Admin UI |
| **Open-source / inspectable** | ❌ | ❌ | ❌ | ✅ GitHub repo |
| **Offline / local capable** | ❌ | ❌ | ❌ | ✅ pnpm dlx supabase start |

---

## Notes

### Uber
- Surge pricing (dynamic pricing) is well-documented publicly; formula not disclosed
- UberPool (now UberX Share) confirmed operational in Bengaluru
- Driver dispatch algorithm: not public; assumed multi-factor

### Ola
- OlaShare: pooling product, confirmed operational
- Surge: observed in pricing; mechanism not disclosed
- Zone-level operations: Ola Heat (driver guidance tool) inferred from driver-facing app

### Rapido
- Primarily bike-taxi; auto added later
- Pooling: not confirmed for all cities
- Surge: inferred from pricing variability; no public documentation

---

## Our Differentiators for PS 02

1. **Transparent allocation scoring** — judges can see exactly why a driver was chosen (score bars + weight breakdown), edit weights, and watch live re-ranking. Competitors do not expose this.

2. **Forecast accuracy shown** — we display model MAE vs naive baseline honestly, including when the gain is modest. This demonstrates scientific honesty, not just feature presence.

3. **Reassignment attempt counter** — riders see "Finding another driver (attempt 2 of 5)" rather than a spinner. Fully auditable in `ride_events`.

4. **Stop-order comparison for pooling** — judges see per-rider added minutes and total time comparison before confirming the pool. No production app shows this to users.

5. **Zone repositioning arrows** — greedy algorithm recommends specific driver movements from surplus to deficit zones, visualised on the map.

6. **Full audit trail** — `ride_events` is append-only and shown in the Admin Exceptions tab. Every state change is logged with actor and timestamp.
