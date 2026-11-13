# Urban Pulse

Intelligent ride matching and dynamic driver allocation (Hack Valley PS 02). Riders request trips, a nearby driver is chosen by a transparent multi-factor score, failures are reassigned automatically, and zone demand is forecast by a small trained model. **All drivers, demand, weather, traffic and surge are simulated.**

**Stack:** React 19 + TypeScript + Vite, Tailwind v4 + shadcn/ui, React-Leaflet (OpenStreetMap), Supabase (Postgres + PostGIS, Auth, Realtime, RPC functions), Python scikit-learn for forecasting. See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## What makes Urban Pulse different
- **Dispatch Arena:** runs the same deterministic request stream (same seed, fleet and driver responses) through two isolated worlds, nearest-driver vs Urban Pulse's ETA + workload + reliability + idle-time score, and compares match wait, pickup ETA error, utilization, completion rate, empty pickup km and allocation spread. Metrics where Urban Pulse loses are shown too. [Design](docs/DISPATCH_ARENA.md)
- **What-If Scenario Lab:** rain, concert, airport-wave and rush-hour events flow through forecast → supply gap → surge formula → repositioning → re-run. [Catalog](docs/SCENARIO_CATALOG.md)
- **Chaos Mode:** inject rejection, timeout, driver cancel or delay on a live ride and watch the real reassignment RPC recover it.

## Judges' feedback (13 Nov): what changed
- **Automatic zone-aware dispatch:** every request is allocated by Postgres. Hard eligibility rules come first, then an explainable score with a zone-balance term. [Algorithm](docs/DISPATCH_ALGORITHM.md)
- **Zone switching and proactive repositioning:** live demand vs supply per zone (model v2 forecast + waiting requests), with peak shortages detected from data. Captains get suggestions with reasons and can request a zone. A move becomes operational only on observed arrival, with cooldown and hysteresis. [Zone intelligence](docs/ZONE_INTELLIGENCE.md)
- **Automatic reassignment:** covers declines, timeouts, a captain going offline or stale, a captain withdrawing the opt-in, cancellations and unreachable captains.
- **"Prefer a woman driver":** captains opt in privately; the preference is a hard filter, never a ranking bonus. If nobody is available, the rider chooses between waiting and searching all captains. **Safety feedback** (published from 5 entries) and **safety reports** with an admin review trail. [Details](docs/WOMEN_DRIVER_PREFERENCE_AND_SAFETY.md)
- **Dispatch Arena:** nearest vs existing Urban Pulse vs zone-aware, across 13 scenarios. The results are mixed and are reported as such. [Fairness and results](docs/FAIRNESS_AND_ALLOCATION.md)
- **UI:** adopts the `UrbanPulse_jcr` design (the login screen is unchanged). The previous UI is kept in [docs/reference/ui-v1](docs/reference/ui-v1/README.md).
- **Boundary research:** no verified municipal polygon was found. [Investigation](docs/research/BELAGAVI_MUNICIPAL_BOUNDARY_INVESTIGATION.md)

## Run locally
Needs Node 22+, pnpm 10, and Docker Desktop running.

```bash
pnpm install
pnpm db:start            # local Supabase (Postgres + PostGIS, Auth, Realtime) in Docker
pnpm db:reset            # migrations + seed (demo users, drivers, zones, trained forecasts)
cp .env.example .env.local   # then paste the anon key from: pnpm dlx supabase@3.1.0 status
pnpm dev                 # http://localhost:5173
```

Demo accounts (local seed only, password `demo1234`): `rider@demo.up`, `captain1@demo.up`, `admin@demo.up` (judge console + Dispatch Arena). The login page has one-click buttons in dev.

Checks: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, `pnpm db:smoke`, `pnpm db:privacy`, `pnpm db:safety` (SQL integrity, privacy, dispatch and safety tests), `pnpm db:concurrency`, `pnpm e2e` (Playwright, uses local Chrome), `pnpm arena:report [seed]`.
Retrain the forecast (optional, output is committed): `pip install -r ml/requirements.txt && python ml/train.py`.

## Demo city: Belagavi (Belgaum)
The demo runs on Belagavi, Karnataka: 8 demand zones and 35 landmarks, with coordinates from a one-time OpenStreetMap lookup. Captains, demand, weather and surge are simulated.

**Fares are simulated** (fare model v2): no per-minute charge, surge off unless the judge enables it (then capped at 2x).

| | Minimum fare | Per km after that | Basis |
|---|---|---|---|
| Bike | ₹20 (first 1.5 km) | ₹6 | Illustrative; simulated service (no bike-taxi permits verified in Karnataka) |
| Auto | ₹30 (first 1.5 km) | ₹15 | Illustrative (Belagavi auto tariff not verified) |
| Cab | ₹100 (first 4 km) | ₹24 | Karnataka app-cab tariff, vehicles up to ₹10 lakh (as reported), + 5% GST; +10% 00:00-06:00 |

For example, Rani Channamma Circle to the railway station (about 2.8 km, estimated) costs ₹28 by bike, ₹49 by auto and ₹105 by cab. The full chart is in [docs/FARES.md](docs/FARES.md); the sources and driver economics are in [docs/FARE_ECONOMICS_AND_MARKET_BENCHMARK.md](docs/FARE_ECONOMICS_AND_MARKET_BENCHMARK.md).

## Docs
[Feature acceptance](docs/FEATURE_ACCEPTANCE_MATRIX.md) · [Reality and market audit](docs/REALITY_AND_MARKET_AUDIT.md) · [Demo data](docs/DEMO_DATA_SPECIFICATION.md) · [Scope](docs/PRODUCT_SCOPE.md) · [Data model](docs/DATA_MODEL.md) · [API](docs/API_CONTRACT.md) · [Demo](docs/DEMO_SCRIPT.md) · [Competitor matrix](docs/COMPETITOR_FEATURE_MATRIX.md)
