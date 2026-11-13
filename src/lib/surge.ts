// Mirrors zone_intelligence() in SQL. SIMULATED pricing, not a commercial fare engine.
export const SURGE = { k: 0.15, cap: 2.0, alpha: 0.5 }

export function surgeRaw(forecast: number, supply: number, cap = SURGE.cap): number {
  const v = 1 + SURGE.k * Math.max(0, forecast / Math.max(supply, 1) - 1)
  return Math.round(Math.min(Math.max(v, 1), cap) * 1000) / 1000
}

export function surgeSmoothed(raw: number, prevRaw: number, alpha = SURGE.alpha): number {
  return Math.round((alpha * raw + (1 - alpha) * prevRaw) * 1000) / 1000
}
