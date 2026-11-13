# CLAUDE.md — Urban Pulse Agent Instructions

## Project Overview

Ride-hailing prototype for Hack Valley PS 02. React 19 + TypeScript + Vite SPA talking directly to Supabase (Postgres + PostGIS + Auth + Realtime). No Node/Express server — all business logic is in SECURITY DEFINER Postgres RPCs.

## Commands

```bash
pnpm dev              # Start Vite dev server
pnpm build            # Production build
pnpm preview          # Preview production build
pnpm test             # Vitest unit tests
pnpm test:e2e         # Playwright E2E
pnpm lint             # ESLint
pnpm typecheck        # tsc --noEmit

# Supabase
pnpm dlx supabase start       # Start local Supabase (Docker required)
pnpm dlx supabase stop        # Stop local Supabase
pnpm dlx supabase db reset    # Apply all migrations + seed (destructive)
pnpm dlx supabase db push     # Push to hosted project (needs SUPABASE_ACCESS_TOKEN)

# ML model
cd ml && pip install -r requirements.txt && python train.py
# Writes: supabase/seed_forecast.sql, ml/metrics.json
```

## Architecture

- **Frontend:** `src/` — React 19, TypeScript, Vite, Tailwind v4, shadcn/ui, React-Leaflet
- **Backend:** `supabase/migrations/` — numbered SQL files; all RPCs are SECURITY DEFINER
- **ML:** `ml/train.py` — HistGradientBoosting; output is committed SQL seed
- **Tests:** `src/lib/*.test.ts` (Vitest), `e2e/` (Playwright)

## Key Files

- `src/lib/supabase.ts` — Supabase client, type-safe RPC wrappers
- `src/lib/geo.ts` — haversine, ETA, fare calculation (shared with tests and RPCs)
- `src/lib/pooling.ts` — pooling compatibility + stop-order algorithm (unit-tested)
- `supabase/migrations/` — ordered SQL; don't edit old files, add new ones
- `supabase/seed.sql` — demo users, drivers, zones, settings, rides
- `docs/API_CONTRACT.md` — full RPC contract (read before adding RPCs)
- `docs/DATA_MODEL.md` — full schema + state machine

## State Machine

```
requested → offered → accepted → arriving → [delayed] → ongoing → completed
                    ↘ rejected/no_response → requested (re-dispatch, attempt++)
arriving → delayed → requested (re-dispatch)
any → cancelled
attempt > 5 → no_driver_found
```

Enforced in `advance_ride` Postgres function. Every transition writes `ride_events`.

## Branching

- `main` — protected, merge via PR only
- `feature/<name>` — all work here
- Salman owns: `supabase/`, `ml/`, `src/lib/`
- Shiv owns: `src/pages/`, `src/components/`

## Do Not

- Do not write business logic in React components — use `supabase.rpc()` calls to SECURITY DEFINER functions
- Do not add packages without checking licence compatibility
- Do not add Zustand, Framer Motion, 21st.dev without explicit approval
- Do not edit old migration files — add new numbered migrations
- Do not use `UPDATE`/`DELETE` on `ride_events` — it's append-only by design
- Do not hardcode Supabase URL or anon key — use `import.meta.env.VITE_SUPABASE_*`
- Do not deploy to GitHub Pages without explicit lead approval

## Environment Variables

See `.env.example`. Copy to `.env.local` for local dev.

## Testing Standards

- All `src/lib/` functions must have Vitest tests
- Pooling: test at least compatibility check, all 4 orderings, detour limit boundary
- Scoring: test min-max normalisation edge cases (all same ETA, single candidate)
- Fare: test surge cap, category multipliers, boundary hours for speed
- E2E: full lifecycle (request → accept → complete), reject → reassignment (attempt 2 visible)

## Simulated Data Policy

Every view using synthetic data must show a visible "SIMULATED" badge. This is non-negotiable for the demo.
