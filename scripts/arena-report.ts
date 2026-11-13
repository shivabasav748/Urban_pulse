// Prints Arena results for every scenario (seed from argv, default 42). Run: pnpm arena:report [seed]
import { ARENA_SCENARIOS, METRICS, runArena, type ScenarioId } from '../src/sim/arena'
const seed = Number(process.argv[2] ?? 42)
const f = (v: number | null) => String(v ?? 'N/A').padStart(7)
for (const s of Object.keys(ARENA_SCENARIOS) as ScenarioId[]) {
  const r = runArena(seed, s)
  console.log(`\n${s}: ${ARENA_SCENARIOS[s].label} (seed ${seed}, ${r.baseline.counts.submitted} requests, ${r.baseline.counts.prefRequests} preference)`)
  console.log(`  ${'metric'.padEnd(32)} ${'A near'.padStart(7)} ${'B UP'.padStart(7)} ${'C zone'.padStart(7)}`)
  for (const m of METRICS) {
    const v = [r.baseline, r.urbanPulse, r.zoneAware].map((w) => w.metrics[m.key])
    if (v.every((x) => x == null)) continue
    console.log(`  ${m.label.padEnd(32)} ${v.map(f).join(' ')}`)
  }
}
