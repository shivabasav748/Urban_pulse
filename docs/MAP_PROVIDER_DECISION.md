# Map Provider Decision

**Status:** DECIDED, Option A (keep OSM). Salman, 13 Nov 2026, 1:28 PM. No Google Cloud project, API, key or billing was created.

## What the code does today (verified)
- Map: React-Leaflet + OpenStreetMap tiles with visible attribution (`src/components/map/MapCanvas.tsx`).
- Places: 16 seeded Bengaluru demo places with our own coordinates (`src/lib/places.ts`). No geocoder or autocomplete API.
- Routing/ETA: great-circle distance × 1.35 road factor, hour-based speed, labelled "estimated" (`src/lib/geo.ts` and `public._km/_minutes` in SQL).
- Dispatch: PostGIS `ST_DWithin` on `driver_profiles.location`; ride pickup/drop coordinates are stored permanently in `rides` and `trip_groups.stops`.
- No Google API key, Google Cloud project or `gcloud` CLI on the build machine.

## Options
| | A. Keep OSM stack (recommended) | B. Google Maps web stack |
|---|---|---|
| Change | None | Swap the renderer to Maps JavaScript API; Places (New) autocomplete; Routes library `Route` + `RouteMatrix` |
| APIs enabled | 0 | Exactly 3: Maps JavaScript, Places (New), Routes |
| Setup | — | GCP project, billing account, browser key restricted to exact referrers + 3 APIs, quotas, budget alert (Salman must approve each) |
| Cost risk | None (respect OSM tile policy) | Billable SKUs; RouteMatrix bills per element (origins × destinations); re-check India pricing on the day |
| Data terms | No conflict | **Conflict:** Google-derived lat/lng may generally be cached ≤ 30 days. Our `rides`, `trip_groups.stops` and history keep coordinates indefinitely, and PostGIS dispatch runs on them. Needs a retention redesign (purge job or storing place IDs only) before integration |
| Offline / judging | Works with seeded places; tiles degrade gracefully | Needs the deterministic fallback to keep working without a key |
| Effort | 0 h | ~3–4 h including the provider interface, fallback and retention changes |
| Demo value | Same algorithms, straight-line route | Real road routes, real autocomplete |

## Rules if B is chosen
- Never draw Google content (places, routes) on Leaflet/OSM. The whole bundle switches together, behind a provider interface.
- Do not enable Geocoding, Roads, Route Optimization, Weather, Geolocation, legacy Directions/Distance Matrix or any native SDK.
- `VITE_GOOGLE_MAPS_API_KEY` stays in `.env.local` only, as a browser key with referrer and API restrictions. Use separate dev and demo keys.
- The app must start and the full ride lifecycle must work with the key absent ("Demo routing mode" indicator).
- RouteMatrix: one batched call per dispatch, capped at ≤ 10 candidate origins × 1 destination; never per render or per keystroke.

## Recommendation
**A for the hackathon.** It costs nothing, has no data-terms conflict with our persistent PostGIS model, and none of the five PS 02 features depend on real road routing. Revisit B after judging if the team wants real routes. It could be built as a parallel provider on a branch without touching dispatch.
