// Prints Arena results for every scenario (seed from argv, default 42). Run: pnpm arena:report [seed]
import { ARENA_SCENARIOS, METRICS, runArena, type ScenarioId } from '../src/sim/arena'
const seed = Number(process.argv[2] ?? 42)
for (const s of Object.keys(ARENA_SCENARIOS) as ScenarioId[]) {
  const r = runArena(seed, s)
  console.log(`\n${s} (seed ${seed}, ${r.baseline.counts.submitted} requests)`)
  for (const m of METRICS) console.log(`  ${m.label.padEnd(22)} nearest ${String(r.baseline.metrics[m.key]).padStart(7)}   urban_pulse ${String(r.urbanPulse.metrics[m.key]).padStart(7)}`)
  console.log(`  counts nearest ${JSON.stringify(r.baseline.counts)}\n  counts UP      ${JSON.stringify(r.urbanPulse.counts)}`)
}
