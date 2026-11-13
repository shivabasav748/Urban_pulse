import { describe, expect, it } from 'vitest'
import { ARENA_SCENARIOS, assign, generateInput, mulberry32, nearestZone, runArena, runWorld, scenarioChain, type ScenarioId } from './arena'

describe('Dispatch Arena', () => {
  it('same seed + scenario -> byte-identical input and results for all three worlds', () => {
    expect(JSON.stringify(generateInput(42, 'base'))).toBe(JSON.stringify(generateInput(42, 'base')))
    const a = runArena(42, 'heavy_rain'), b = runArena(42, 'heavy_rain')
    expect(JSON.stringify([a.baseline, a.urbanPulse, a.zoneAware])).toBe(JSON.stringify([b.baseline, b.urbanPulse, b.zoneAware]))
  })

  it('different seeds give different streams', () => {
    expect(JSON.stringify(generateInput(1, 'base').requests)).not.toBe(JSON.stringify(generateInput(2, 'base').requests))
  })

  it('worlds are isolated: running one never mutates the shared input', () => {
    const input = generateInput(7, 'rush_hour')
    const before = JSON.stringify(input)
    runWorld(structuredClone(input), 'nearest', false)
    runWorld(structuredClone(input), 'urban_pulse', true)
    runWorld(structuredClone(input), 'zone_aware', true)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('all worlds see the same requests and produce bounded metrics, in every scenario', () => {
    for (const s of Object.keys(ARENA_SCENARIOS) as ScenarioId[]) {
      const r = runArena(42, s)
      expect(r.urbanPulse.counts.submitted).toBe(r.baseline.counts.submitted)
      expect(r.zoneAware.counts.submitted).toBe(r.baseline.counts.submitted)
      for (const w of [r.baseline, r.urbanPulse, r.zoneAware]) {
        expect(w.metrics.utilization!).toBeGreaterThanOrEqual(0)
        expect(w.metrics.utilization!).toBeLessThanOrEqual(1)
        expect(w.counts.completed + w.counts.inFlight + w.counts.unserved).toBeLessThanOrEqual(w.counts.submitted)
      }
      expect(r.baseline.metrics.moves).toBe(0)
    }
  })

  it('women-driver preference is never violated, with adequate or insufficient supply, on any seed', () => {
    for (const seed of [1, 7, 42]) for (const s of ['women_pref_ok', 'women_pref_short'] as const) {
      const r = runArena(seed, s)
      expect(r.baseline.counts.prefRequests).toBeGreaterThan(0)
      for (const w of [r.baseline, r.urbanPulse, r.zoneAware]) expect(w.metrics.prefViolations).toBe(0)
    }
  })

  it('scenario fixtures do what they say', () => {
    expect(generateInput(42, 'zone_shortage').fleet.some((d) => nearestZone(d) === 3)).toBe(false)
    expect(generateInput(42, 'station_spike').requests.length).toBeGreaterThan(generateInput(42, 'multi_reject').requests.length) // same base stream + hotspot
    expect(generateInput(42, 'captain_offline').fleet.filter((d) => d.offlineAt != null).length).toBeGreaterThan(0)
    expect(generateInput(42, 'base').requests.every((r) => !r.pref)).toBe(true)
  })

  it('reassignment metrics are defined when offers fail', () => {
    const r = runArena(42, 'multi_reject')
    for (const w of [r.baseline, r.urbanPulse, r.zoneAware]) {
      expect(w.counts.reassignments).toBeGreaterThan(0)
      expect(w.metrics.reassignSuccess).not.toBeNull()
    }
  })

  it('batch assignment is optimal: matches brute force on small random cost matrices, and skips infeasible pairs', () => {
    const rnd = mulberry32(9)
    const perms = (n: number, m: number): number[][] => n === 0 ? [[]] : perms(n - 1, m).flatMap((p) => Array.from({ length: m }, (_, j) => j).filter((j) => !p.includes(j)).map((j) => [...p, j]))
    for (let trial = 0; trial < 30; trial++) {
      const n = 1 + Math.floor(rnd() * 3), m = n + Math.floor(rnd() * 3)
      const c = Array.from({ length: n }, () => Array.from({ length: m }, () => Math.round(rnd() * 20)))
      const best = Math.min(...perms(n, m).map((p) => p.reduce((s, j, i) => s + c[i][j], 0)))
      const got = assign(c)
      expect(new Set(got).size).toBe(n)
      expect(got.reduce((s, j, i) => s + c[i][j], 0)).toBe(best)
    }
    expect(assign([[1e6, 1e6], [3, 1e6]], 1e6)).toEqual([-1, 0])
    expect(assign([[5], [2], [9]])).toEqual([-1, 0, -1]) // more requests than captains
  })

  it('captains are not all available at once: shifts and breaks reduce online time', () => {
    const input = generateInput(42, 'evening_peak')
    expect(input.fleet.some((d) => d.onAt > 0)).toBe(true)
    expect(input.fleet.some((d) => d.breakFrom != null)).toBe(true)
    expect(JSON.stringify(generateInput(42, 'evening_peak').requests)).toBe(JSON.stringify(input.requests))
  })

  it('stress options scale fleet and demand; impatient riders give up more often', () => {
    expect(generateInput(1, 'evening_peak', 100).fleet).toHaveLength(100)
    expect(generateInput(1, 'evening_peak', 28, 120, 3).requests.length).toBeGreaterThan(2 * generateInput(1, 'evening_peak').requests.length)
    expect(generateInput(1, 'high_density').fleet).toHaveLength(60)
    const patient = runArena(3, 'evening_peak').zoneAware.metrics.cancelRate!, impatient = runArena(3, 'high_cancellation').zoneAware.metrics.cancelRate!
    expect(impatient).toBeGreaterThanOrEqual(patient)
  })

  it('shortlisting the nearest captains stops the score from sending far captains in a dense fleet', () => {
    const input = generateInput(2, 'evening_peak', 250)
    const all = runWorld(structuredClone(input), 'zone_aware', true, { shortlist: 9999 })
    const short = runWorld(structuredClone(input), 'zone_aware', true)
    expect(short.metrics.deadheadKm!).toBeLessThan(all.metrics.deadheadKm!)
  })

  it('driver net earnings are reported and include empty kilometres', () => {
    const r = runArena(42, 'evening_peak')
    for (const w of [r.baseline, r.urbanPulse, r.zoneAware]) expect(w.metrics.driverNetPerHour).not.toBeNull()
  })

  it('what-if rain raises forecast in rain zones (real model feature) and surge follows the shared formula', () => {
    const chain = scenarioChain(generateInput(42, 'heavy_rain'))
    const z1 = chain.find((z) => z.zone === 1)!
    expect(z1.forecast).toBeGreaterThan(z1.base)
    expect(z1.surgeAfter).toBeGreaterThanOrEqual(z1.surgeBefore)
  })
})
