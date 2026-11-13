import { describe, expect, it } from 'vitest'
import { fare, km } from './geo'
import { scoreDrivers } from './allocation'
import { planPool } from './pooling'
import { surgeRaw, surgeSmoothed } from './surge'

describe('surge', () => {
  it('matches the playbook worked example (forecast 10, supply 5)', () => {
    expect(surgeRaw(10, 5)).toBe(1.15)
    expect(surgeSmoothed(1.15, 1.0)).toBe(1.075)
  })
  it('is capped and never below 1', () => {
    expect(surgeRaw(100, 1)).toBe(2)
    expect(surgeRaw(1, 10)).toBe(1)
  })
})

describe('geo/fare', () => {
  it('road distance is great-circle x 1.35', () => {
    expect(km({ lat: 12.9352, lng: 77.6245 }, { lat: 12.9733, lng: 77.617 })).toBeCloseTo(5.8, 0)
  })
  it('fare total = (base + distance + time) x surge', () => {
    // cab: Rs 55 incl. 2 km + 17 x 8 km + 1.5 x 20 min = 221, x 1.5 surge = 331.5 -> 332
    expect(fare('cab', 10, 20, 1.5)).toEqual({ base: 55, included_km: 2, per_km: 17, per_min: 1.5, distance: 136, time: 30, surge_mult: 1.5, total: 332 })
  })
  it('short trips pay only base + time, and bike < auto < cab at every distance', () => {
    expect(fare('auto', 1.2, 3).total).toBe(33)
    for (let km = 0.3; km <= 25; km += 0.1) expect(fare('bike', km, km * 2).total).toBeLessThan(fare('auto', km, km * 2).total)
    for (let km = 0.3; km <= 25; km += 0.1) expect(fare('auto', km, km * 2).total).toBeLessThan(fare('cab', km, km * 2).total)
  })
})

describe('allocation', () => {
  const base = { offersAccepted: 9, offersReceived: 10 }
  const near = { id: 'near', pickupMin: 3, tripsToday: 8, idleMin: 1, ...base }
  const fair = { id: 'fair', pickupMin: 3.5, tripsToday: 1, idleMin: 25, ...base }
  const far = { id: 'far', pickupMin: 10, tripsToday: 4, idleMin: 10, ...base }
  it('nearest policy picks the closest driver', () => {
    expect(scoreDrivers([near, fair, far], 'nearest')[0].id).toBe('near')
  })
  it('urban pulse trades a little ETA for workload + idle fairness', () => {
    expect(scoreDrivers([near, fair, far])[0].id).toBe('fair')
  })
  it('result flips back when that driver is the busiest and least idle', () => {
    expect(scoreDrivers([near, { ...fair, tripsToday: 9, idleMin: 0 }, far])[0].id).toBe('near')
  })
})

describe('pooling', () => {
  const a = { id: 'a', pickup: { lat: 12.9346, lng: 77.6113, label: 'Forum' }, drop: { lat: 12.9755, lng: 77.6068, label: 'MG Rd' } }
  const b = { id: 'b', pickup: { lat: 12.9352, lng: 77.6245, label: 'Kora' }, drop: { lat: 12.9726, lng: 77.6197, label: 'Trinity' } }
  it('pools compatible rides with valid order and bounded detour', () => {
    const p = planPool(a, b, 12)
    expect(p.compatible).toBe(true)
    for (const id of ['a', 'b']) {
      const i = p.stops!.findIndex((s) => s.ride_id === id && s.type === 'pickup')
      const j = p.stops!.findIndex((s) => s.ride_id === id && s.type === 'drop')
      expect(i).toBeLessThan(j)
    }
    expect(p.perRider!.every((r) => r.detourPct <= 40)).toBe(true)
  })
  it('the judge-console Belagavi demo pair is poolable', () => {
    const r = (id: string, p: [number, number], d: [number, number]) => ({ id, pickup: { lat: p[0], lng: p[1], label: id }, drop: { lat: d[0], lng: d[1], label: id } })
    const plan = planPool(r('rcc', [15.86723, 74.51172], [15.83686, 74.50193]), r('kb', [15.86112, 74.51492], [15.83368, 74.50645]), 12)
    expect(plan.compatible).toBe(true)
  })
  it('rejects distant pickups', () => {
    const far = { ...b, pickup: { lat: 12.8452, lng: 77.6602, label: 'E-City' } }
    expect(planPool(a, far, 12).compatible).toBe(false)
  })
})
