import { describe, expect, it } from 'vitest'
import { scoreDrivers, ZONE_WEIGHT } from './allocation'
import { classifyZone, safetyLabel } from './zones'

const base = { offersAccepted: 9, offersReceived: 10, tripsToday: 2, idleMin: 5 }

describe('zone-aware allocation', () => {
  it('equal zone balance: same winner and order as the existing Urban Pulse score', () => {
    const c = [{ id: 'a', pickupMin: 3, ...base, zoneSlack: 1 }, { id: 'b', pickupMin: 6, ...base, zoneSlack: 1 }, { id: 'c', pickupMin: 4, ...base, tripsToday: 0, zoneSlack: 1 }]
    expect(scoreDrivers(c, 'zone_aware').map((x) => x.id)).toEqual(scoreDrivers(c, 'urban_pulse').map((x) => x.id))
  })
  it('otherwise-identical captains: the one from a zone with spare supply is chosen (does not drain a short zone)', () => {
    const r = scoreDrivers([{ id: 'short-zone', pickupMin: 3, ...base, zoneSlack: -3 }, { id: 'spare-zone', pickupMin: 3, ...base, zoneSlack: 2 }], 'zone_aware')
    expect(r[0].id).toBe('spare-zone')
    expect(r[0].c_zone).toBe(1)
    expect(r[1].c_zone).toBe(0)
  })
  it('zone balance is bounded: it cannot overturn a large ETA advantage', () => {
    const r = scoreDrivers([{ id: 'near', pickupMin: 2, ...base, zoneSlack: -4 }, { id: 'far', pickupMin: 12, ...base, zoneSlack: 4 }], 'zone_aware')
    expect(r[0].id).toBe('near')
  })
  it('score = (1 - w_zone) x four-part score + w_zone x zone component', () => {
    const [x] = scoreDrivers([{ id: 'x', pickupMin: 5, ...base, zoneSlack: 0 }], 'zone_aware')
    const four = 0.45 * x.c_eta + 0.25 * x.c_workload + 0.2 * x.c_reliability + 0.1 * x.c_idle
    expect(x.score).toBeCloseTo((1 - ZONE_WEIGHT) * four + ZONE_WEIGHT * x.c_zone, 4)
  })
  it('nearest and urban_pulse ignore zone balance', () => {
    const c = [{ id: 'a', pickupMin: 3, ...base, zoneSlack: -5 }, { id: 'b', pickupMin: 3.2, ...base, zoneSlack: 5 }]
    const flat = c.map((y) => ({ ...y, zoneSlack: 0 }))
    expect(scoreDrivers(c, 'nearest')[0].id).toBe('a')
    expect(scoreDrivers(c, 'urban_pulse').map((x) => x.score)).toEqual(scoreDrivers(flat, 'urban_pulse').map((x) => x.score))
  })
})

describe('zone classification (mirrors zone_balance)', () => {
  it('shortage of 1 or more is undersupplied; 2+ spare is oversupplied; otherwise balanced', () => {
    expect(classifyZone(7.2, 3, 5, 6).state).toBe('undersupplied')
    expect(classifyZone(1, 3, 1, 1).state).toBe('oversupplied')
    expect(classifyZone(3.1, 3, 3, 3).state).toBe('balanced')
  })
  it('peak comes from demand vs supply, not the clock', () => {
    expect(classifyZone(6, 3, 5, 5).peak).toBe(true)       // ratio 2.0
    expect(classifyZone(6, 5, 5, 5).peak).toBe(false)      // ratio 1.2
    expect(classifyZone(1.8, 0, 1, 1).peak).toBe(false)    // too little demand to call it a peak
  })
  it('rising needs +15% and at least +0.5 requests', () => {
    expect(classifyZone(5, 5, 4, 5).rising).toBe(true)
    expect(classifyZone(5, 5, 1, 1.2).rising).toBe(false)
  })
})

describe('safety feedback presentation', () => {
  const none = { overall: null, driving: null, vehicle: null, conduct: null }
  it('no data: no score', () => {
    expect(safetyLabel(null).headline).toBe('Not enough safety feedback yet.')
    expect(safetyLabel({ count: 0, threshold: 5, published: false, ...none }).headline).toBe('Not enough safety feedback yet.')
  })
  it('below the threshold: count only, never a number', () => {
    const l = safetyLabel({ count: 3, threshold: 5, published: false, ...none })
    expect(l.headline).toBe('Not enough safety feedback yet.')
    expect(l.detail).toContain('3 of 5')
  })
  it('published: score with its source and sample size', () => {
    const l = safetyLabel({ count: 6, threshold: 5, published: true, overall: 4.5, driving: 4, vehicle: 5, conduct: 5 })
    expect(l.headline).toBe('4.5 / 5 safety')
    expect(l.detail).toBe('Passenger-reported, from 6 completed rides.')
  })
})
