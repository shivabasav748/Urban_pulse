// Mirrors public.zone_balance() state/peak rules and captain_safety_summary() publishing rule (migration 0007).
export type ZoneState = 'undersupplied' | 'balanced' | 'oversupplied'

/** demand30 = next-bucket forecast + requests waiting now; expected = free + en-route + finishing captains. */
export function classifyZone(demand30: number, expected: number, predictedNow: number, predictedNext: number, peakRatio = 1.5) {
  const shortage = Math.round((demand30 - expected) * 100) / 100
  const ratio = Math.round((demand30 / Math.max(expected, 1)) * 100) / 100
  const state: ZoneState = shortage >= 1 ? 'undersupplied' : expected - demand30 >= 2 ? 'oversupplied' : 'balanced'
  return {
    shortage, ratio, state,
    rising: predictedNext >= predictedNow * 1.15 && predictedNext - predictedNow >= 0.5,
    peak: ratio >= peakRatio && demand30 >= 2,
  }
}

export type SafetySummary = { count: number; threshold: number; published: boolean; overall: number | null; driving: number | null; vehicle: number | null; conduct: number | null }

/** Never show a score the data cannot support: below the threshold there is no number, only a count. */
export function safetyLabel(s: SafetySummary | null | undefined): { headline: string; detail: string } {
  if (!s || s.count === 0) return { headline: 'Not enough safety feedback yet.', detail: 'No passenger safety feedback yet.' }
  if (!s.published || s.overall == null) {
    return { headline: 'Not enough safety feedback yet.', detail: `${s.count} of ${s.threshold} passenger reports needed before a score is shown.` }
  }
  return { headline: `${s.overall.toFixed(1)} / 5 safety`, detail: `Passenger-reported, from ${s.count} completed ride${s.count === 1 ? '' : 's'}.` }
}
