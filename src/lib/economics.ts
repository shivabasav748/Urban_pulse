// Driver and platform unit economics (SIMULATED estimates). Every number is an assumption with a source or a label;
// see docs/FARE_ECONOMICS_AND_MARKET_BENCHMARK.md. Used by the captain earnings view and the Dispatch Arena.
import type { Category } from './geo'

export type Scenario = 'low' | 'base' | 'high' // cost scenario: low = optimistic costs, high = pessimistic costs

/** Belagavi retail prices, 13 Nov 2026 (goodreturns.in / cardekho.com; diesel varies Rs 98.67-100.10 by source).
 *  Electricity: Karnataka public-charger retail ~Rs 7-8.3/kWh (BESCOM listings, undated); no Belagavi rate found. */
export const ENERGY_PRICE = { petrol: 110.71, diesel: 98.67, cng: 105, electricity: 7.5 } as const
type Fuel = keyof typeof ENERGY_PRICE

/** Representative vehicles. claimed = manufacturer/ARAI figure (km per litre/kg, or km per kWh for EVs).
 *  realWorld = share of the claimed figure achieved in city stop-go use: low/base/high scenario (the 0.65-0.8 range is
 *  an assumption; no rigorous published study was found). price = ex-showroom (Rs), CarDekho/BikeDekho, Nov 2026. */
export const VEHICLES = {
  cab_dzire_cng: { category: 'cab', label: 'Maruti Dzire S-CNG', fuel: 'cng', claimed: 35.63, price: 818_000, lifeKm: 250_000, residual: 0.25,
    maint: { low: 0.6, base: 0.9, high: 1.2 }, source: 'cardekho.com Dzire overview (35.63 km/kg, VXI CNG Rs 8.18 lakh)' },
  cab_dzire_petrol: { category: 'cab', label: 'Maruti Dzire petrol', fuel: 'petrol', claimed: 25.15, price: 680_000, lifeKm: 250_000, residual: 0.25,
    maint: { low: 0.6, base: 0.9, high: 1.2 }, source: 'cardekho.com Dzire overview (25.15 kmpl MT)' },
  cab_aura_cng: { category: 'cab', label: 'Hyundai Aura CNG', fuel: 'cng', claimed: 22, price: 690_000, lifeKm: 250_000, residual: 0.25,
    maint: { low: 0.6, base: 0.9, high: 1.2 }, source: 'cardekho.com Aura overview (22 km/kg)' },
  auto_bajaj_re_cng: { category: 'auto', label: 'Bajaj RE CNG', fuel: 'cng', claimed: 37.5, price: 235_000, lifeKm: 150_000, residual: 0.2,
    maint: { low: 0.3, base: 0.5, high: 0.8 }, source: '91trucks.com listing (35-40 km/kg claimed, aggregator data, low confidence)' },
  auto_treo_ev: { category: 'auto', label: 'Mahindra Treo (EV)', fuel: 'electricity', claimed: 141 / 7.37, price: 300_000, lifeKm: 150_000, residual: 0.15,
    maint: { low: 0.2, base: 0.35, high: 0.55 }, source: 'mahindralastmilemobility.com (7.37 kWh, 141 km ARAI)' },
  bike_splendor: { category: 'bike', label: 'Hero Splendor Plus', fuel: 'petrol', claimed: 70, price: 78_000, lifeKm: 100_000, residual: 0.2,
    maint: { low: 0.2, base: 0.3, high: 0.45 }, source: 'bikedekho.com (70 kmpl claimed)' },
  bike_activa: { category: 'bike', label: 'Honda Activa 6G', fuel: 'petrol', claimed: 59.5, price: 80_000, lifeKm: 100_000, residual: 0.2,
    maint: { low: 0.2, base: 0.3, high: 0.45 }, source: 'bikedekho.com (59.5 kmpl ARAI)' },
} as const satisfies Record<string, { category: Category; label: string; fuel: Fuel; claimed: number; price: number; lifeKm: number; residual: number
  maint: Record<Scenario, number>; source: string }>
export type VehicleId = keyof typeof VEHICLES
export const DEFAULT_VEHICLE: Record<Category, VehicleId> = { cab: 'cab_dzire_cng', auto: 'auto_bajaj_re_cng', bike: 'bike_splendor' }
const REAL_WORLD: Record<Scenario, number> = { low: 0.8, base: 0.72, high: 0.65 }

/** Platform rules. driverShare: >= 80% for driver-owned vehicles (MoRTH Aggregator Guidelines 2025, as reported).
 *  welfare: Karnataka gig-worker welfare fee 1% of payout, capped per payout (notified Feb 2026, as reported).
 *  paymentPct and supportPerRide are ILLUSTRATIVE assumptions (not sourced). */
export const PLATFORM = {
  driverShare: 0.8, welfarePct: 1, welfareCap: { bike: 0.5, auto: 0.75, cab: 1.0 } as Record<Category, number>,
  paymentPct: 2, supportPerRide: 3,
} as const

export function costPerKm(v: VehicleId, s: Scenario = 'base') {
  const veh = VEHICLES[v]
  const energy = ENERGY_PRICE[veh.fuel] / (veh.claimed * REAL_WORLD[s])
  const depreciation = (veh.price * (1 - veh.residual)) / veh.lifeKm
  return { energy: r2(energy), maintenance: veh.maint[s], depreciation: r2(depreciation), total: r2(energy + veh.maint[s] + depreciation) }
}

export type RideInput = { category: Category; fareTotal: number; gst?: number; tripKm: number; pickupKm: number; repoKm?: number
  tripMin: number; pickupMin: number; vehicle?: VehicleId; scenario?: Scenario }

/** One ride, both sides of the ledger. GST is collected for the government and is not platform revenue. */
export function rideEconomics(r: RideInput) {
  const s = r.scenario ?? 'base', v = r.vehicle ?? DEFAULT_VEHICLE[r.category]
  const gst = r.gst ?? 0
  const fareExTax = r.fareTotal - gst
  const driverGross = r2(fareExTax * PLATFORM.driverShare)
  const platformGross = r2(fareExTax - driverGross)
  const welfareFee = r2(Math.min(driverGross * PLATFORM.welfarePct / 100, PLATFORM.welfareCap[r.category]))
  const paymentCost = r2(r.fareTotal * PLATFORM.paymentPct / 100)
  const platformContribution = r2(platformGross - welfareFee - paymentCost - PLATFORM.supportPerRide)
  const km = r.tripKm + r.pickupKm + (r.repoKm ?? 0)
  const c = costPerKm(v, s)
  const vehicleCost = r2(km * c.total)
  const driverNet = r2(driverGross - vehicleCost)
  const hours = (r.tripMin + r.pickupMin) / 60
  return { fareTotal: r.fareTotal, gst, fareExTax, driverGross, platformGross, welfareFee, paymentCost, platformContribution,
    paidKm: r2(r.tripKm), emptyKm: r2(r.pickupKm + (r.repoKm ?? 0)), energyCost: r2(km * c.energy), maintenanceCost: r2(km * c.maintenance),
    depreciationCost: r2(km * c.depreciation), vehicleCost, driverNet, driverNetPerHour: hours > 0 ? r2(driverNet / hours) : null }
}

function r2(n: number) { return Math.round(n * 100) / 100 }
