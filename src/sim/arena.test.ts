import { describe, expect, it } from 'vitest'
import { generateInput, runArena, runWorld, scenarioChain } from './arena'

describe('Dispatch Arena', () => {
  it('same seed + scenario -> byte-identical input and results', () => {
    expect(JSON.stringify(generateInput(42, 'base'))).toBe(JSON.stringify(generateInput(42, 'base')))
    const a = runArena(42, 'heavy_rain'), b = runArena(42, 'heavy_rain')
    expect(JSON.stringify([a.baseline, a.urbanPulse])).toBe(JSON.stringify([b.baseline, b.urbanPulse]))
  })

  it('different seeds give different streams', () => {
    expect(JSON.stringify(generateInput(1, 'base').requests)).not.toBe(JSON.stringify(generateInput(2, 'base').requests))
  })

  it('worlds are isolated: running one never mutates the shared input', () => {
    const input = generateInput(7, 'rush_hour')
    const before = JSON.stringify(input)
    runWorld(structuredClone(input), 'nearest', false)
    runWorld(structuredClone(input), 'urban_pulse', true)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('both sides see the same submitted requests and produce bounded metrics', () => {
    const r = runArena(42, 'base')
    expect(r.baseline.counts.submitted).toBe(r.urbanPulse.counts.submitted)
    expect(r.baseline.counts.submitted).toBeGreaterThan(20)
    for (const w of [r.baseline, r.urbanPulse]) {
      expect(w.metrics.utilization!).toBeGreaterThan(0)
      expect(w.metrics.utilization!).toBeLessThanOrEqual(1)
      expect(w.metrics.completionRate!).toBeLessThanOrEqual(1)
      expect(w.counts.completed + w.counts.inFlight + w.counts.unserved).toBeLessThanOrEqual(w.counts.submitted)
    }
    expect(r.baseline.metrics.repoKm).toBe(0)
  })

  it('what-if rain raises forecast in rain zones (real model feature) and surge follows the shared formula', () => {
    const chain = scenarioChain(generateInput(42, 'heavy_rain'))
    const kora = chain.find((z) => z.zone === 1)!
    expect(kora.forecast).toBeGreaterThan(kora.base)
    expect(kora.surgeAfter).toBeGreaterThanOrEqual(kora.surgeBefore)
  })
})
