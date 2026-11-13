# Urban Pulse

Intelligent ride matching and dynamic driver allocation (Hack Valley PS 02). Riders request trips, a nearby driver is chosen by a transparent multi-factor score, failures are reassigned automatically, and zone demand is forecast by a small trained model. **All drivers, demand, weather, traffic and surge are simulated.**

**Stack:** React 19 + TypeScript + Vite, Tailwind v4 + shadcn/ui, React-Leaflet (OpenStreetMap), Supabase (Postgres + PostGIS, Auth, Realtime, RPC functions), Python scikit-learn for forecasting. See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## What makes Urban Pulse different
- **Dispatch Arena:** runs the same deterministic request stream (same seed, fleet and driver responses) through two isolated worlds, nearest-driver vs Urban Pulse's ETA + workload + reliability + idle-time score, and compares match wait, pickup ETA error, utilization, completion rate, empty pickup km and allocation spread. Metrics where Urban Pulse loses are shown too. [Design](docs/DISPATCH_ARENA.md)
- **What-If Scenario Lab:** rain, concert, airport-wave and rush-hour events flow through forecast → supply gap → surge formula → repositioning → re-run. [Catalog](docs/SCENARIO_CATALOG.md)
- **Chaos Mode:** inject rejection, timeout, driver cancel or delay on a live ride and watch the real reassignment RPC recover it.

## Run locally
_Setup steps are added with the foundation slice._

## Docs
[Scope](docs/PRODUCT_SCOPE.md) · [Data model](docs/DATA_MODEL.md) · [API](docs/API_CONTRACT.md) · [Demo](docs/DEMO_SCRIPT.md) · [Competitor matrix](docs/COMPETITOR_FEATURE_MATRIX.md)
