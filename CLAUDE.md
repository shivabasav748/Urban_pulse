# Urban Pulse: repo rules

- Architecture source of truth: `docs/IMPLEMENTATION_PLAN.md`. No Node/Express API; integrity logic lives in Postgres RPCs (`supabase/migrations`).
- Package manager: pnpm only. Supabase CLI via `pnpm dlx supabase`.
- RPCs: `SECURITY DEFINER`, `set search_path = ''`, schema-qualified, identity from `auth.uid()`, revoke from public.
- Label all simulated data `SIMULATED` in the UI. Never hard-code a metric, surge value or arena winner.
- Never commit `.env*` (except `.env.example`) or service-role keys. Never run `db reset` against a non-local project.
- Work on `feature/*` branches; `main` stays demo-ready. Don't force-push.
- Before claiming done: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
