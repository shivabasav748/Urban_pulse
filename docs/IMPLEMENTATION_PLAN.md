# Implementation Plan — Urban Pulse (PS 02)

## Overview

Urban Pulse is a ride-hailing prototype built for Hack Valley PS 02. It demonstrates the full ride lifecycle (rider → driver match → completion) plus 5 mandatory advanced features using clearly-labelled simulated data.

---

## Architectural Decision: No Node/Express API

### Decision
React SPA talks **directly to Supabase** via `supabase-js`. Every integrity-critical operation is a `SECURITY DEFINER` Postgres function called via `supabase.rpc()`, using `auth.uid()` for identity verification.

### Rationale
- GitHub Pages (deployment target) is **static-only** — no server runtime
- Eliminates one service to build, host, and keep alive during judging
- Supabase Auth + RLS provides equivalent security guarantees
- Supabase Realtime replaces WebSocket server for live updates

### Trade-off
Deviation from the brief's Node API is **deliberate**. It is documented here and will be stated explicitly during the judging demo.

### Security model
- Anon key is public by design (Supabase convention)
- RLS (Row Level Security) is the security boundary — all tables have RLS enabled
- Role-sensitive operations (dispatch, scoring, state transitions) are `SECURITY DEFINER` and check `auth.uid()` + role within the function body
- `role` column on `profiles` is never client-writable (enforced by RLS policy + trigger)

---

## Environment

| Tool | Version |
|------|---------|
| Node | 22.23 |
| pnpm | 10.26 |
| Python | 3.14 |
| gh CLI | 2.102 |
| Docker | 29.8 (daemon may need manual start) |
| Supabase CLI | via `pnpm dlx supabase` |

---

## Stack Decisions

### Included
- **React 19 + TypeScript + Vite** — modern, fast HMR, easy Pages deploy
- **Tailwind v4 + shadcn/ui + Lucide** — consistent design, copy-paste components
- **React-Leaflet + OSM tiles** — free, offline-capable, visible attribution (required by OSM)
- **TanStack Query** — cache, loading/error states, background refresh
- **Zod** — form validation at the boundary
- **Vitest** — unit tests for geo/fare/pooling/scoring
- **Playwright** — E2E lifecycle tests with screenshots

### Explicitly Skipped (and why)
| Package | Reason |
|---------|--------|
| Zustand | TanStack Query + Supabase Realtime covers state needs |
| 21st.dev / Watermelon / React Bits | Licence uncertain; add only after check |
| Motion (Framer Motion) | Not needed for first build |

Add any of the above only after first build review with explicit licence check per component.

### Geocoding
Seeded Bengaluru demo places — **no Nominatim autocomplete** (avoids external dependency during judging, Nominatim TOS restricts bulk/rapid lookups).

### Routing
Straight-line × 1.35 road correction factor, hour-based speed model (18 km/h peak, 28 km/h off-peak). All ETAs labelled "estimated".

---

## Delivery Slices

### Slice 1 — Docs & Planning (→ 11:15)
- Clone repo into `D:\Jain Hackathon`, branch `docs/plan`
- Write 6 planning docs (this file + 5 others)
- Competitor matrix: browser subagent on 3 public sites (observed/inferred/unavailable labels)
- Start Docker Desktop in background

### Slice 2 — Foundation (→ 11:45)
- `pnpm create vite` + Tailwind v4 + shadcn init + Vitest config
- `.env.example`, `CLAUDE.md`, README
- `pnpm dlx supabase init` + first migration (schema skeleton) + seed
- `pnpm dlx supabase db reset` must succeed cleanly

### Slice 3 — Auth + Shell (→ 12:15)
- Supabase Auth: sign in/up, role choice
- Role-based routing (rider/driver/admin)
- RLS policies on `profiles`

### Slice 4 — Core Ride Slice (→ 13:00 ✅ CHECKPOINT)
- `estimate_ride` RPC + Rider estimate UI
- `request_ride` → `dispatch` → `ride_offers` row
- Driver receives offer via Supabase Realtime (`postgres_changes`)
- Driver `respond_offer(accept=true)` → ride moves to `accepted`
- **Mentoring demo ready at this point**

### Slice 5 — Lifecycle + History + Exceptions (→ 17:30)
- Full state machine via `advance_ride` (arriving → started → completed)
- Rider history list + detail + fare breakdown
- Driver history + utilisation
- `sweep_exceptions`: expired offers → `no_response` → re-dispatch
- Delay detection: arriving past threshold → `delayed` → re-dispatch
- `cancel_ride` (rider and driver paths)
- Demo control buttons (fast mode, force reject, force timeout, reset scenario)

### Slice 6 — Fairness UI + Zones + Forecast (→ 21:00)
- **Walk-through with Salman for ML training**
- `ml/train.py` — generate `seed_forecast.sql` + `metrics.json`
- `zone_intelligence` RPC + Admin Zones tab (heatmap, forecast vs actual chart, surge, repositioning arrows)
- Admin Allocation tab: score breakdown bars, weight sliders, live re-rank

### Slice 7 — Pooling + Admin Metrics (→ 01:00)
- `src/lib/pooling.ts` finalized + unit tests passing
- `create_pool` RPC with server-side re-validation
- Admin Pooling tab: pick 2 requests → stop-order diagram → comparison → create pool
- `admin_metrics` RPC + Metrics tab

### Slice 8 — Polish + Test + Freeze (→ 04:30)
- `pnpm lint && pnpm typecheck && pnpm test` all green
- Playwright: full E2E suite (ride lifecycle, reject → reassignment, zones, pooling)
- Screenshots at 1440×900 and 390×844 (Chrome)
- Review screenshots before moving on
- `pnpm build` passes
- **Freeze at 04:30**

### Slice 9 — Push (→ 05:45)
- `git push origin main`
- GitHub Pages deploy (only after explicit go-ahead from lead)

---

## Risks & Fallbacks

| Risk | Fallback |
|------|---------|
| Docker won't start / venue Wi-Fi too slow for Supabase images | Use hosted Supabase dev project (same migrations, `supabase db push`) |
| scikit-learn fails on Python 3.14 | Seasonal-naive heuristic fallback, labelled "heuristic, not trained model" in UI and docs |
| OSM tiles blocked at venue | Map shows zones/markers on blank canvas; list view still works fully |
| GitHub flaky | Commit locally, push at breaks; `gh` CLI as backup |

---

## Team Ownership

| Area | Owner |
|------|-------|
| `supabase/` (migrations, seed, RPCs) | Salman |
| `ml/` (train.py, metrics) | Salman |
| `src/lib/` (supabase.ts, geo.ts, pooling.ts) | Salman |
| `src/pages/` | Shiv |
| `src/components/` | Shiv |

**Branching:** `feature/*` → PRs into `main`. No direct pushes to `main`.
