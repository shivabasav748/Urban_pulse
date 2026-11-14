import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Award, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { usePhone } from '@/lib/hooks'
import { rpc } from '@/lib/supabase'
import { safetyLabel, type SafetySummary } from '@/lib/zones'
import { cn } from '@/lib/utils'

type Why = { score: number; policy: string; attempt: number; compared: number; trips_today: number; acceptance: number; vehicle_label: string; simulated: boolean
  chosen: { pickup_km: number; pickup_min: number; idle_min: number; c_eta: number; c_workload: number; c_reliability: number; c_idle: number; c_zone?: number }
  weights: { eta: number; workload: number; reliability: number; idle: number; zone: number }; safety: SafetySummary }

/** Deterministic made-up profile per captain (same captain, same numbers). Clearly labelled; not used by dispatch. */
function madeUp(id: string) {
  let h = 2166136261
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  const r = (n: number) => { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; return h % n }
  const langs = ['Kannada', 'Marathi', 'Hindi', 'English', 'Konkani', 'Urdu']
  return { years: 1 + r(9), rating: (4.3 + r(7) / 10).toFixed(1), trips: 300 + r(3700), since: 2016 + r(9),
    langs: [langs[0], ...langs.slice(1).filter(() => r(2) === 1).slice(0, 2)], vehicleYear: 2017 + r(8), compliments: ['Smooth driving', 'On time', 'Polite', 'Clean vehicle'][r(4)] }
}

const Bar = ({ label, value, weight }: { label: string; value: number; weight: number }) => (
  <div className="text-xs">
    <div className="flex justify-between"><span>{label}</span><span className="font-mono num text-slate-500">{Math.round(value * 100)}/100 × {weight.toFixed(2)}</span></div>
    <div className="mt-1 h-1.5 rounded-full bg-slate-100"><div className="h-full rounded-full bg-teal-600" style={{ width: `${Math.round(value * 100)}%` }} /></div>
  </div>
)

export function WhyCaptain({ rideId, driverId, name }: { rideId: string; driverId: string; name: string }) {
  const [open, setOpen] = useState(false)
  const phone = usePhone()
  const why = useQuery({ queryKey: ['why', rideId], enabled: open, staleTime: Infinity, refetchInterval: false, queryFn: () => rpc<Why | null>('why_my_captain', { p_ride: rideId }) })
  const m = madeUp(driverId), w = why.data, sl = safetyLabel(w?.safety ?? undefined)
  return (
    <>
      <Button variant="ghost" size="sm" className="w-full text-teal-800" onClick={() => setOpen(true)}><Info className="size-4" aria-hidden />Why {name}?</Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side={phone ? 'bottom' : 'right'} className={cn('overflow-y-auto', phone ? 'max-h-[85dvh] rounded-t-3xl' : 'w-full sm:max-w-md')}>
          <SheetHeader><SheetTitle>Why {name} was chosen</SheetTitle>
            <SheetDescription>Every request is matched automatically. Here is how this captain compared.</SheetDescription></SheetHeader>
          <div className="space-y-4 px-4 pb-6">
            <section className="rounded-2xl border bg-surface p-3">
              <h3 className="text-xs font-bold tracking-wide text-slate-500 uppercase">From the live match</h3>
              {why.isLoading ? <p className="mt-2 text-sm text-slate-500">Loading…</p> : !w ? <p className="mt-2 text-sm text-slate-500">Available once the captain accepts.</p> : <>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <div><dt className="text-[10px] text-slate-500">ETA to you</dt><dd className="font-mono text-sm font-bold num">{Math.ceil(w.chosen.pickup_min)} min</dd></div>
                  <div><dt className="text-[10px] text-slate-500">Distance</dt><dd className="font-mono text-sm font-bold num">{Number(w.chosen.pickup_km).toFixed(1)} km</dd></div>
                  <div><dt className="text-[10px] text-slate-500">Match score</dt><dd className="font-mono text-sm font-bold text-teal-800 num">{Math.round(w.score * 100)}/100</dd></div>
                </dl>
                <div className="mt-3 space-y-2">
                  <Bar label="Closest arrival" value={w.chosen.c_eta} weight={w.weights.eta} />
                  <Bar label="Fewer trips today (fair share)" value={w.chosen.c_workload} weight={w.weights.workload} />
                  <Bar label="Reliability (accepts requests)" value={w.chosen.c_reliability} weight={w.weights.reliability} />
                  <Bar label="Waiting longest for work" value={w.chosen.c_idle} weight={w.weights.idle} />
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  Compared with {w.compared || 'the'} nearby eligible captain{w.compared === 1 ? '' : 's'} · {w.trips_today} trips today · {Math.round(w.acceptance * 100)}% acceptance ·
                  safety: {sl.headline}{w.attempt > 1 ? ` · found on try ${w.attempt}` : ''}.
                </p>
              </>}
            </section>
            <section className="rounded-2xl border border-amber-200 bg-amber-50/60 p-3">
              <div className="flex items-center justify-between"><h3 className="text-xs font-bold tracking-wide text-slate-500 uppercase">Captain profile</h3>
                <span className="rounded border border-amber-300 bg-amber-100 px-1 font-mono text-[10px] font-bold text-amber-800">MADE-UP DEMO DATA</span></div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                <div><dt className="text-[11px] text-slate-500">Experience</dt><dd className="font-semibold">{m.years} year{m.years === 1 ? '' : 's'} (since {m.since})</dd></div>
                <div><dt className="text-[11px] text-slate-500">Rider rating</dt><dd className="font-semibold">★ {m.rating} / 5</dd></div>
                <div><dt className="text-[11px] text-slate-500">Trips completed</dt><dd className="font-semibold num">{m.trips.toLocaleString('en-IN')}</dd></div>
                <div><dt className="text-[11px] text-slate-500">Vehicle</dt><dd className="font-semibold">{w?.vehicle_label ?? '…'}, {m.vehicleYear}</dd></div>
                <div><dt className="text-[11px] text-slate-500">Languages</dt><dd className="font-semibold">{m.langs.join(', ')}</dd></div>
                <div><dt className="text-[11px] text-slate-500">Top compliment</dt><dd className="flex items-center gap-1 font-semibold"><Award className="size-3.5 text-amber-600" aria-hidden />{m.compliments}</dd></div>
              </dl>
              <p className="mt-2 text-[11px] text-slate-500">Illustrative only: these profile numbers are invented for the demo and play no part in matching.</p>
            </section>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
