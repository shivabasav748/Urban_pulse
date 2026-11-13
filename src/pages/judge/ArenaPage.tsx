import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { ArrowLeft, Play, RotateCcw, Swords } from 'lucide-react'
import { Footer, TopNav } from '@/components/layout/AppShell'
import { SimBadge, Tag } from '@/components/ride/bits'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import forecast from '@/sim/forecast.json'
import { ARENA_SCENARIOS, METRICS, runArena, scenarioChain, type ArenaRun, type MetricGroup, type MetricKey, type ScenarioId, type WorldResult } from '@/sim/arena'

const zoneName = (id: number) => forecast.zones.find((z) => z.id === id)?.name ?? String(id)
const fmt = (v: number | null, unit: string) => (v == null ? 'N/A' : unit === '%' ? `${Math.round(v * 100)}%` : `${v}${unit ? ` ${unit}` : ''}`)
const WORLDS = [
  { key: 'baseline', short: 'A · Nearest', title: 'A · Nearest driver', sub: 'Lowest pickup ETA wins. No fairness weights, no repositioning.', bar: 'bg-slate-500' },
  { key: 'urbanPulse', short: 'B · Urban Pulse', title: 'B · Urban Pulse (existing)', sub: 'ETA .45 + workload .25 + reliability .20 + idle .10; greedy 15-min forecast moves.', bar: 'bg-sky-600' },
  { key: 'zoneAware', short: 'C · Zone-aware', title: 'C · Zone-aware (new)', sub: '0.85 × B score + 0.15 × zone balance; live shortage planner (hysteresis, cooldown, 15-min move cap). Live default uses B scoring with this planner.', bar: 'bg-teal-600' },
] as const
type WKey = (typeof WORLDS)[number]['key']
const GROUPS: { id: MetricGroup; label: string }[] = [
  { id: 'passenger', label: 'Passengers' }, { id: 'fleet', label: 'Fleet' }, { id: 'zones', label: 'Zones and repositioning' },
  { id: 'reassignment', label: 'Reassignment' }, { id: 'fairness', label: 'Workload spread' }, { id: 'preference', label: 'Women-driver preference (evaluated separately)' },
]
const NOT_A_GOAL: MetricKey[] = ['moves', 'repoKm', 'prefViolations']

/** Which worlds have the best value for this metric (ties allowed). Moves/km are costs shown without a winner. */
function best(k: MetricKey, vals: (number | null)[]): Set<number> {
  const m = METRICS.find((x) => x.key === k)!
  const ok = vals.map((v, i) => [v, i] as const).filter(([v]) => v != null) as [number, number][]
  if (ok.length < 2 || NOT_A_GOAL.includes(k)) return new Set()
  const target = m.better === 'lower' ? Math.min(...ok.map(([v]) => v)) : Math.max(...ok.map(([v]) => v))
  const winners = ok.filter(([v]) => Math.abs(v - target) < 1e-9).map(([, i]) => i)
  return winners.length === ok.length ? new Set() : new Set(winners)
}

export default function ArenaPage() {
  const [seed, setSeed] = useState(42)
  const [scenario, setScenario] = useState<ScenarioId>('evening_peak')
  const [reposition, setReposition] = useState(true)
  const [run, setRun] = useState<ArenaRun | null>(null)
  const [frame, setFrame] = useState(0)
  const go = (s = scenario) => { setRun(runArena(seed, s, reposition)); setFrame(0) }
  useEffect(() => { go() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const frames = run?.baseline.timeline.length ?? 0
  useEffect(() => {
    if (!run || frame >= frames - 1) return
    const t = setTimeout(() => setFrame((f) => f + 1), 140)
    return () => clearTimeout(t)
  }, [run, frame, frames])
  const chain = useMemo(() => (run && ARENA_SCENARIOS[run.input.scenario].fc !== 'base' ? scenarioChain(run.input) : null), [run])
  const def = run ? ARENA_SCENARIOS[run.input.scenario] : null
  const rows = run ? METRICS.filter((m) => (m.group !== 'preference' || run.baseline.counts.prefRequests > 0)) : []
  const score = run ? WORLDS.map((_, i) => rows.filter((m) => best(m.key, WORLDS.map((w) => run[w.key].metrics[m.key])).has(i)).length) : []
  const cLoses = run ? rows.filter((m) => { const b = best(m.key, WORLDS.map((w) => run[w.key].metrics[m.key])); return b.size > 0 && !b.has(2) }) : []
  const groups = ['efficiency', 'reassignment', 'safety'] as const

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <TopNav />
      <main className="mx-auto w-full max-w-7xl flex-1 space-y-4 px-2 py-3 sm:px-4">
        <section className="rounded-2xl border bg-white p-4 shadow-md shadow-slate-900/5 sm:p-5">
          <Button asChild variant="ghost" size="sm" className="-ml-2"><Link to="/judge"><ArrowLeft className="size-4" aria-hidden />Control room</Link></Button>
          <div className="mt-1 flex items-center gap-2"><Swords className="size-5 text-teal-700" aria-hidden /><h1 className="text-lg font-bold tracking-tight md:text-xl">Dispatch Arena: three policies, identical requests</h1><SimBadge /></div>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            The same cloned fleet, request stream, captain responses and trip times run through three isolated worlds. Only the dispatch policy and repositioning differ.
            Results are per metric; there is no overall winner, and losses are shown.
          </p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="space-y-1"><Label htmlFor="seed">Seed</Label><Input id="seed" type="number" className="h-11 w-28 rounded-xl" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} /></div>
            <div className="min-w-[260px] flex-1 space-y-1"><Label htmlFor="scn">Scenario</Label>
              <select id="scn" className="block h-11 w-full rounded-xl border bg-white px-2 text-sm" value={scenario} onChange={(e) => setScenario(e.target.value as ScenarioId)}>
                {groups.map((g) => (
                  <optgroup key={g} label={g === 'efficiency' ? 'Demand and supply' : g === 'reassignment' ? 'Reassignment' : 'Safety preference'}>
                    {(Object.keys(ARENA_SCENARIOS) as ScenarioId[]).filter((s) => ARENA_SCENARIOS[s].group === g).map((s) => <option key={s} value={s}>{ARENA_SCENARIOS[s].label}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="flex h-11 items-center gap-2"><Switch id="repo" checked={reposition} onCheckedChange={setReposition} /><Label htmlFor="repo">Repositioning on (B and C)</Label></div>
            <div className="flex gap-2">
              <Button size="lg" onClick={() => go()}><Play className="size-4" aria-hidden />Run</Button>
              <Button size="lg" variant="outline" onClick={() => { setScenario('base'); go('base') }}><RotateCcw className="size-4" aria-hidden />Normal day</Button>
            </div>
          </div>
          {run && def && (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 font-mono text-[11px] text-slate-500">
              <span>{run.input.runId}</span><span>{def.label} ({def.how})</span>
              <span>{run.input.fleet.length} cabs · {run.input.requests.length} requests{run.baseline.counts.prefRequests ? ` · ${run.baseline.counts.prefRequests} ask for a woman driver` : ''} · {run.input.horizonMin} min from {String(Math.floor(run.input.startHour)).padStart(2, '0')}:{run.input.startHour % 1 ? '30' : '00'}</span>
              <span>{run.input.algorithmVersion}</span>
            </div>
          )}
        </section>

        {run && (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              {WORLDS.map((w, i) => <WorldCard key={w.key} title={w.title} sub={w.sub} bar={w.bar} r={run[w.key as WKey]} frame={frame} best={score[i]} accent={w.key === 'zoneAware'} />)}
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-bold">Per-metric comparison {frame < frames - 1 && <span className="font-normal text-slate-500">(replaying…)</span>}</CardTitle>
                <CardDescription className="text-xs">
                  Best value per row is marked. Best on most rows this run: A {score[0]}, B {score[1]}, C {score[2]}.
                  {cLoses.length > 0 ? <> C is <b>not</b> best on: {cLoses.map((m) => m.label.toLowerCase()).join(', ')}.</> : ' C is best or tied on every scored metric this run; try other seeds.'}
                  {' '}Repositioning moves and distance are costs, shown without a winner.
                </CardDescription>
              </CardHeader>
              <CardContent className="min-w-0">
                {/* relative: the sr-only "(best)" labels are absolutely positioned and must not escape this scroller */}
                <div className="relative max-w-[calc(100vw-3rem)] overflow-x-auto md:max-w-none">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead><tr className="border-b text-[10px] font-bold tracking-wider text-slate-500 uppercase">
                    <th className="py-2 pr-2">Metric</th>{WORLDS.map((w) => <th key={w.key} className="px-2">{w.short}</th>)}<th className="px-2">Definition</th>
                  </tr></thead>
                  {GROUPS.map((g) => {
                    const ms = rows.filter((m) => m.group === g.id)
                    if (!ms.length) return null
                    return (
                      <tbody key={g.id} className="divide-y">
                        <tr className="bg-slate-50"><th colSpan={5} className="py-1.5 pl-1 text-[11px] font-bold text-slate-600">{g.label}</th></tr>
                        {ms.map((m) => {
                          const vals = WORLDS.map((w) => run[w.key as WKey].metrics[m.key])
                          const b = best(m.key, vals)
                          return (
                            <tr key={m.key}>
                              <td className="py-2 pr-2 font-semibold">{m.label}</td>
                              {vals.map((v, i) => (
                                <td key={i} className={cn('px-2 font-mono num', b.has(i) && 'font-bold text-teal-800')}>
                                  {fmt(v, m.unit)}{b.has(i) && <span className="sr-only"> (best)</span>}{b.has(i) && <span aria-hidden className="ml-1 text-[10px]">●</span>}
                                </td>
                              ))}
                              <td className="px-2 text-xs text-slate-500">{m.def} ({m.better} is better)</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    )
                  })}
                </table>
                </div>
              </CardContent>
            </Card>

            {chain && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-bold">What-if chain: event → forecast → supply gap → surge</CardTitle>
                  <CardDescription className="text-xs">{def?.how}. First 30 minutes of the run; surge uses the shared formula with the captains in each zone at the start.</CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <table className="rtable w-full min-w-[640px] text-sm">
                    <thead><tr className="text-left text-xs text-slate-500"><th className="py-1 font-medium">Zone</th><th className="font-medium">Forecast normal → event</th><th className="font-medium">Captains</th><th className="font-medium">Gap</th><th className="font-medium">Surge before → after</th></tr></thead>
                    <tbody>{chain.map((z) => (
                      <tr key={z.zone} className={cn('border-t', z.forecast > z.base + 0.05 && 'bg-amber-50')}>
                        <td className="py-1">{zoneName(z.zone)}</td>
                        <td data-label="Forecast" className="num">{z.base} → <b>{z.forecast}</b></td><td data-label="Captains" className="num">{z.supply}</td>
                        <td data-label="Gap" className={cn('num', z.gap > 0 && 'text-rose-700')}>{z.gap}</td>
                        <td data-label="Surge" className="num">×{z.surgeBefore.toFixed(2)} → <b>×{z.surgeAfter.toFixed(2)}</b></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </main>
      <Footer />
    </div>
  )
}

function WorldCard({ title, sub, r, frame, bar, best, accent }: { title: string; sub: string; r: WorldResult; frame: number; bar: string; best: number; accent?: boolean }) {
  const snap = r.timeline[Math.min(frame, r.timeline.length - 1)]
  const max = Math.max(...r.perDriver.map((d) => d.assigned), 1)
  return (
    <Card className={cn(accent && 'border-teal-600 ring-2 ring-teal-600/15')}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2"><CardTitle className="text-base font-bold">{title}</CardTitle><Tag tone={accent ? 'brand' : 'muted'}>best on {best}</Tag></div>
        <CardDescription className="text-xs">{sub}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-center" aria-live="off">
          {[['sim minute', snap.t], ['matched', snap.served], ['waiting', snap.waiting]].map(([k, v]) => (
            <div key={k} className="rounded-xl border bg-surface p-2"><div className="font-mono text-lg font-bold num">{v}</div><div className="text-[11px] text-slate-500">{k}</div></div>
          ))}
        </div>
        <p className="text-xs text-slate-500">{r.counts.completed} completed · {r.counts.inFlight} in flight · {r.counts.unserved} gave up after 10 min · {r.counts.reassignments} reassignments · {r.metrics.moves} moves</p>
        <div>
          <div className="mb-1 text-[11px] text-slate-500">Trips per captain</div>
          <div className="flex h-14 items-end gap-0.5" role="img" aria-label={`Trips per captain: ${r.perDriver.map((d) => d.assigned).join(', ')}`}>
            {r.perDriver.map((d) => <div key={d.id} title={`${d.id}: ${d.assigned} trips, ${d.busyMin} busy min`} className={cn('flex-1 rounded-t', bar)} style={{ height: `${(d.assigned / max) * 100}%`, minHeight: 2 }} />)}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
