import { describe, expect, it } from 'vitest'
import { costPerKm, ENERGY_PRICE, PLATFORM, rideEconomics, VEHICLES } from './economics'
import { fare } from './geo'

describe('ride economics (simulated estimates)', () => {
  const f = fare('cab', 10)
  const base = { category: 'cab' as const, fareTotal: f.total, gst: f.gst, tripKm: 10, pickupKm: 2, tripMin: 25, pickupMin: 6 }

  it('the fare reconciles: driver gross + platform gross + GST = passenger fare', () => {
    const e = rideEconomics(base)
    expect(e.driverGross + e.platformGross + e.gst).toBeCloseTo(f.total, 2)
    expect(e.driverGross).toBeCloseTo((f.total - f.gst!) * PLATFORM.driverShare, 2)
  })
  it('GST is never counted as platform revenue', () => {
    const withGst = rideEconomics(base), noGst = rideEconomics({ ...base, gst: 0 })
    expect(withGst.platformGross).toBeLessThan(noGst.platformGross)
  })
  it('empty kilometres (pickup and repositioning) cost the driver money', () => {
    const near = rideEconomics({ ...base, pickupKm: 0.5 }), far = rideEconomics({ ...base, pickupKm: 5, repoKm: 3 })
    expect(far.driverNet).toBeLessThan(near.driverNet)
    expect(far.emptyKm).toBe(8)
  })
  it('the Karnataka welfare fee is 1% of payout, capped per payout', () => {
    expect(rideEconomics(base).welfareFee).toBe(PLATFORM.welfareCap.cab)       // 1% of ~Rs 195 > Rs 1 cap
    expect(rideEconomics({ ...base, category: 'bike', fareTotal: 20, gst: 0 }).welfareFee).toBe(0.16) // 1% of Rs 16
  })
  it('energy cost per km follows fuel price and real-world efficiency', () => {
    const c = costPerKm('cab_dzire_cng')
    expect(c.energy).toBeCloseTo(ENERGY_PRICE.cng / (VEHICLES.cab_dzire_cng.claimed * 0.72), 1)
    expect(costPerKm('cab_dzire_cng', 'high').total).toBeGreaterThan(costPerKm('cab_dzire_cng', 'low').total)
    expect(costPerKm('auto_treo_ev').energy).toBeLessThan(costPerKm('auto_bajaj_re_cng').energy)
  })
  it('net per hour is reported only when time is positive', () => {
    expect(rideEconomics({ ...base, tripMin: 0, pickupMin: 0 }).driverNetPerHour).toBeNull()
  })
})
