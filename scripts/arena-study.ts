// Multi-seed Dispatch Arena study (SIMULATED). Run: pnpm exec vite-node scripts/arena-study.ts [seeds|switches|batch|all] [nSeeds]
//  seeds    : every scenario x policies A/B/C over seeds 1..n: mean, median, standard deviation per metric
//  switches : unnecessary zone switches of the zone-aware planner with vs without the 15-min move cap
//  batch    : one-at-a-time (live) vs per-tick min-ETA batch assignment, fleets 17/50/100/250 x demand 1x/2x/4x
import { ARENA_SCENARIOS, METRICS, generateInput, runWorld, type MetricKey, type ScenarioId, type WorldResult } from '../src/sim/arena'

const mode = process.argv[2] ?? 'all', N = Number(process.argv[3] ?? 10)
const seeds = Array.from({ length: N }, (_, i) => i + 1)
const stat = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null)
  if (!v.length) return null
  const mean = v.reduce((s, x) => s + x, 0) / v.length, sorted = [...v].sort((a, b) => a - b)
  const median = sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(v.length - 1, 1))
  return { mean: +mean.toFixed(3), median: +median.toFixed(3), sd: +sd.toFixed(3), n: v.length }
}
const KEY: MetricKey[] = ['matchWaitAvg', 'pickupWaitAvg', 'completionRate', 'cancelRate', 'utilization', 'deadheadKm', 'driverNetPerHour',
  'zoneImbalance', 'moves', 'unnecessaryMoves', 'reassignSuccess', 'reassignDelay', 'gini', 'prefServed', 'prefViolations']
const out: Record<string, unknown> = { generated: new Date().toISOString(), seeds, synthetic: true }

if (mode === 'seeds' || mode === 'all') {
  const res: Record<string, Record<string, Record<string, ReturnType<typeof stat>>>> = {}
  for (const sc of Object.keys(ARENA_SCENARIOS) as ScenarioId[]) {
    const worlds: Record<string, WorldResult[]> = { A_nearest: [], B_urban_pulse: [], C_zone_aware: [] }
    for (const seed of seeds) {
      const input = generateInput(seed, sc)
      worlds.A_nearest.push(runWorld(structuredClone(input), 'nearest', false))
      worlds.B_urban_pulse.push(runWorld(structuredClone(input), 'urban_pulse', true))
      worlds.C_zone_aware.push(runWorld(structuredClone(input), 'zone_aware', true))
    }
    res[sc] = Object.fromEntries(Object.entries(worlds).map(([w, rs]) => [w, Object.fromEntries(KEY.map((k) => [k, stat(rs.map((r) => r.metrics[k]))]))]))
    const line = (k: MetricKey) => Object.keys(worlds).map((w) => `${res[sc][w][k]?.mean ?? 'n/a'}±${res[sc][w][k]?.sd ?? ''}`).join(' | ')
    console.log(`\n${sc} (${N} seeds)\n  wait ${line('matchWaitAvg')}\n  completion ${line('completionRate')}\n  imbalance ${line('zoneImbalance')}\n  net/h ${line('driverNetPerHour')}\n  unnecessary ${line('unnecessaryMoves')}`)
  }
  out.seeds_study = res
  // tally: on how many (scenario, metric) cells is each policy best by mean
  const better = Object.fromEntries(METRICS.map((m) => [m.key, m.better]))
  const tally = { A_nearest: 0, B_urban_pulse: 0, C_zone_aware: 0 } as Record<string, number>
  for (const sc of Object.keys(res)) for (const k of KEY) {
    if (['moves', 'prefViolations'].includes(k)) continue
    const vals = Object.entries(res[sc]).map(([w, m]) => [w, m[k]?.mean] as const).filter(([, v]) => v != null) as [string, number][]
    if (vals.length < 3) continue
    const best = better[k] === 'lower' ? Math.min(...vals.map((v) => v[1])) : Math.max(...vals.map((v) => v[1]))
    const winners = vals.filter(([, v]) => Math.abs(v - best) < 1e-9)
    if (winners.length < 3) winners.forEach(([w]) => tally[w]++)
  }
  out.best_cell_tally = tally
  console.log('\nbest-by-mean cell tally', tally)
}

if (mode === 'switches' || mode === 'all') {
  const rows: Record<string, unknown> = {}
  for (const sc of Object.keys(ARENA_SCENARIOS) as ScenarioId[]) {
    const capped: WorldResult[] = [], uncapped: WorldResult[] = []
    for (const seed of seeds) {
      const input = generateInput(seed, sc)
      capped.push(runWorld(structuredClone(input), 'zone_aware', true, { maxMoveMin: 15 }))
      uncapped.push(runWorld(structuredClone(input), 'zone_aware', true, { maxMoveMin: 999 }))
    }
    const pick = (rs: WorldResult[]) => Object.fromEntries((['moves', 'unnecessaryMoves', 'matchWaitAvg', 'completionRate', 'repoKm', 'driverNetPerHour'] as MetricKey[]).map((k) => [k, stat(rs.map((r) => r.metrics[k]))]))
    rows[sc] = { cap15: pick(capped), no_cap: pick(uncapped) }
  }
  out.switch_study = rows
  const sum = (k: 'cap15' | 'no_cap', m: string) => Object.values(rows).reduce((s: number, r) => s + (((r as Record<string, Record<string, { mean: number } | null>>)[k][m])?.mean ?? 0), 0)
  console.log(`\nunnecessary switches (sum of means over scenarios): cap15 ${sum('cap15', 'unnecessaryMoves').toFixed(2)} vs no cap ${sum('no_cap', 'unnecessaryMoves').toFixed(2)}`
    + ` | moves ${sum('cap15', 'moves').toFixed(1)} vs ${sum('no_cap', 'moves').toFixed(1)} | wait ${sum('cap15', 'matchWaitAvg').toFixed(2)} vs ${sum('no_cap', 'matchWaitAvg').toFixed(2)}`
    + ` | completion ${sum('cap15', 'completionRate').toFixed(3)} vs ${sum('no_cap', 'completionRate').toFixed(3)}`)
}

if (mode === 'batch' || mode === 'all') {
  const rows: Record<string, unknown> = {}
  for (const fleet of [17, 50, 100, 250]) for (const demand of [1, 2, 4]) {
    const seq: WorldResult[] = [], bat: WorldResult[] = []
    const t0 = Date.now()
    for (const seed of seeds.slice(0, Math.min(N, 5))) {
      const input = generateInput(seed, 'evening_peak', fleet, 120, demand)
      seq.push(runWorld(structuredClone(input), 'zone_aware', true))
      bat.push(runWorld(structuredClone(input), 'zone_aware', true, { batch: true }))
    }
    const pick = (rs: WorldResult[]) => Object.fromEntries((['matchWaitAvg', 'pickupWaitAvg', 'completionRate', 'deadheadKm', 'driverNetPerHour', 'gini'] as MetricKey[]).map((k) => [k, stat(rs.map((r) => r.metrics[k]))]))
    const key = `fleet${fleet}_demand${demand}x`
    rows[key] = { requests: seq[0].counts.submitted, sequential: pick(seq), batch: pick(bat), seconds: (Date.now() - t0) / 1000 }
    const r = rows[key] as { sequential: Record<string, { mean: number } | null>; batch: Record<string, { mean: number } | null> }
    console.log(`${key}: requests ~${seq[0].counts.submitted} | pickup wait seq ${r.sequential.pickupWaitAvg?.mean} vs batch ${r.batch.pickupWaitAvg?.mean}`
      + ` | completion ${r.sequential.completionRate?.mean} vs ${r.batch.completionRate?.mean} | empty km ${r.sequential.deadheadKm?.mean} vs ${r.batch.deadheadKm?.mean}`)
  }
  out.batch_study = rows
}

if (process.env.STUDY_OUT) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.env.STUDY_OUT, JSON.stringify(out, null, 1))
}
