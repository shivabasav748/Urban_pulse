-- 0010: evidence-based default (13 Nov 2026). The 10-seed Dispatch Arena study (scripts/arena-study.ts, 20 scenarios) and an
-- ablation (score term vs planner) showed the zone-balance term in the per-ride score adds ~0.3 min pickup wait without
-- improving completion. Zone intelligence still drives repositioning; the per-ride score defaults back to the four-part
-- score. The zone-aware score stays selectable by the judge (settings.dispatch_policy). No other data changes.
alter table public.settings alter column dispatch_policy set default 'urban_pulse';
update public.settings set dispatch_policy = 'urban_pulse' where id;
