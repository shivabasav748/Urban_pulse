import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { ArrowLeft, Play, RotateCcw, Zap } from 'lucide-react'
import { AppHeader, SimBadge } from '@/components/ride/bits'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import forecast from '@/sim/forecast.json'
import { ARENA_SCENARIOS, METRICS, runArena, scenarioChain, type ArenaRun, type MetricKey, type ScenarioId, type WorldResult } from '@/sim/arena'

const zoneName = (id: number) => forecast.zones.find((z) => z.id === id)?.name ?? String(id)
const fmt = (v: number | null, unit: string) => (v == null ? 'N/A' : unit === '%' ? `${Math.round(v * 100)}%` : `${v}${unit ? ` ${unit}` : ''}`)

function verdict(k: MetricKey, a: number | null, b: number | null): 'up' | 'base' | 'tie' | 'na' {
  if (a == null || b == null) return 'na'
  const m = METRICS.find((x) => x.key === k)!
  if (Math.abs(a - b) < 1e-9) return 'tie'
  return (m.better === 'lower' ? b < a : b > a) ? 'up' : 'base'
}

export default function ArenaPage() {
  const [seed, setSeed] = useState(42)
  const [scenario, setScenario] = useState<ScenarioId>('base')
  const [reposition, setReposition] = useState(true)
  const [run, setRun] = useState<ArenaRun | null>(null)
  const [normal, setNormal] = useState<ArenaRun | null>(null)
  const [frame, setFrame] = useState(0)

  const go = (s = scenario) => {
    const r = runArena(seed, s, reposition)
    setRun(r); setNormal(s === 'base' ? null : runArena(seed, 'base', reposition)); setFrame(0)
  }
  useEffect(() => { go() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const frames = run?.baseline.timeline.length ?? 0
  useEffect(() => {
    if (!run || frame >= frames - 1) return
    const t = setTimeout(() => setFrame((f) => f + 1), 160)
    return () => clearTimeout(t)
  }, [run, frame, frames])
  const chain = useMemo(() => (run && scenario !== 'base' ? scenarioChain(run.input) : null), [run, scenario])
  const done = frame >= frames - 1
  const wins = run ? METRICS.filter((m) => m.key !== 'repoKm').map((m) => verdict(m.key, run.baseline.metrics[m.key], run.urbanPulse.metrics[m.key])) : []

  return (
    <div className="min-h-dvh bg-muted/30">
      <AppHeader title="Dispatch Arena"><SimBadge /></AppHeader>
      <main className="mx-auto max-w-7xl space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Button asChild variant="ghost" size="sm" className="-ml-2"><Link to="/judge"><ArrowLeft className="size-4" aria-hidden />Judge console</Link></Button>
            <h1 className="text-lg font-semibold tracking-tight md:text-xl">Nearest driver vs Urban Pulse, same requests</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Same cloned fleet, same request stream, same captain responses and trip times. Only the dispatch policy differs; neither world can touch the other's state.
            </p>
          </div>
        </div>

        <Card>
          <CardContent className="flex flex-wrap items-end gap-4 p-4">
            <div className="space-y-1"><Label htmlFor="seed">Seed</Label><Input id="seed" type="number" className="w-28" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} /></div>
            <div className="space-y-1"><Label htmlFor="scn">What-If scenario</Label>
              <select id="scn" className="block h-9 w-[300px] max-w-full rounded-md border bg-background px-2 text-sm" value={scenario} onChange={(e) => setScenario(e.target.value as ScenarioId)}>
                {(Object.keys(ARENA_SCENARIOS) as ScenarioId[]).map((s) => <option key={s} value={s}>{ARENA_SCENARIOS[s].label}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2 pb-2"><Switch id="repo" checked={reposition} onCheckedChange={setReposition} /><Label htmlFor="repo">Urban Pulse proactive repositioning</Label></div>
            <div className="ml-auto flex gap-2">
              <Button onClick={() => go()}>{scenario === 'base' ? <Play className="size-4" aria-hidden /> : <Zap className="size-4" aria-hidden />}{scenario === 'base' ? 'Run' : 'Apply scenario & run'}</Button>
              <Button variant="outline" onClick={() => { setScenario('base'); go('base') }}><RotateCcw className="size-4" aria-hidden />Reset scenario</Button>
            </div>
          </CardContent>
          {run && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-t px-4 py-2 font-mono text-xs text-muted-foreground">
              <span>run {run.input.runId}</span><span>seed {run.input.seed}</span><span>{ARENA_SCENARIOS[run.input.scenario].label} ({ARENA_SCENARIOS[run.input.scenario].how})</span>
              <span>{run.input.fleet.length} cabs · {run.input.requests.length} requests · {run.input.horizonMin} min from {String(Math.floor(run.input.startHour)).padStart(2, '0')}:{run.input.startHour % 1 ? '30' : '00'}</span>
              <span>{run.input.algorithmVersion}</span><span>at {new Date(run.ranAt).toLocaleTimeString()}</span>
            </div>
          )}
        </Card>

        {chain && normal && run && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">What-If chain: event → forecast → supply gap → surge → repositioning → outcomes</CardTitle>
              <CardDescription>{ARENA_SCENARIOS[scenario].how}. Forecasts for the first 30 min of the run; surge uses the shared formula with the captains in each zone at the start.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 overflow-x-auto">
              <table className="rtable w-full min-w-[640px] text-sm">
                <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 font-medium">Zone</th><th className="font-medium">Forecast before → after</th><th className="font-medium">Captains</th><th className="font-medium">Gap</th><th className="font-medium">Surge before → after</th></tr></thead>
                <tbody>{chain.map((z) => (
                  <tr key={z.zone} className={cn('border-t', z.forecast > z.base + 0.05 && 'bg-warning-soft/60')}>
                    <td className="py-1">{zoneName(z.zone)}</td>
                    <td data-label="Forecast" className="tabular-nums">{z.base} → <b>{z.forecast}</b></td><td data-label="Captains" className="tabular-nums">{z.supply}</td>
                    <td data-label="Gap" className={cn('tabular-nums', z.gap > 0 && 'text-destructive')}>{z.gap}</td>
                    <td data-label="Surge" className="tabular-nums">×{z.surgeBefore.toFixed(2)} → <b>×{z.surgeAfter.toFixed(2)}</b></td>
                  </tr>
                ))}</tbody>
              </table>
              <div className="flex flex-wrap gap-3 text-sm">
                <Badge variant="outline">Requests: {normal.input.requests.length} normal → {run.input.requests.length} with event</Badge>
                <Badge variant="outline">Urban Pulse repositioning: {normal.urbanPulse.metrics.repoKm} → {run.urbanPulse.metrics.repoKm} km</Badge>
                <Badge variant="outline">Pickup wait (Urban Pulse): {fmt(normal.urbanPulse.metrics.pickupWaitAvg, 'min')} → {fmt(run.urbanPulse.metrics.pickupWaitAvg, 'min')}</Badge>
                <Badge variant="outline">Unserved (Urban Pulse): {normal.urbanPulse.counts.unserved} → {run.urbanPulse.counts.unserved}</Badge>
              </div>
            </CardContent>
          </Card>
        )}

        {run && (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <WorldCard title="Baseline: nearest driver" sub="Lowest pickup ETA wins. No fairness weights, no repositioning." w={run.baseline} frame={frame} />
              <WorldCard title="Urban Pulse" sub={`ETA .45 + workload .25 + reliability .20 + idle .10${reposition ? ' + proactive repositioning' : ''}`} w={run.urbanPulse} frame={frame} accent />
            </div>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Comparison {done ? '' : '(replaying…)'}</CardTitle>
                <CardDescription>Urban Pulse better on {wins.filter((v) => v === 'up').length}, nearest better on {wins.filter((v) => v === 'base').length}, tied on {wins.filter((v) => v === 'tie').length} metrics this run. Each verdict is per metric; there is no overall winner.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="rtable w-full min-w-[720px] text-sm">
                  <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 font-medium">Metric</th><th className="font-medium">Nearest</th><th className="font-medium">Urban Pulse</th><th className="font-medium">Better</th><th className="font-medium">Definition</th></tr></thead>
                  <tbody>{METRICS.map((m) => {
                    const a = run.baseline.metrics[m.key], b = run.urbanPulse.metrics[m.key], v = verdict(m.key, a, b)
                    return (
                      <tr key={m.key} className="border-t">
                        <td className="py-1.5 font-medium">{m.label}</td>
                        <td data-label="Nearest" className="tabular-nums">{fmt(a, m.unit)}</td><td data-label="Urban Pulse" className="tabular-nums">{fmt(b, m.unit)}</td>
                        <td data-label="Better">{m.key === 'repoKm' ? <span className="text-xs text-muted-foreground">cost of repositioning</span>
                          : <Badge variant="outline" className={cn(v === 'up' && 'border-success/25 bg-success-soft text-success', v === 'base' && 'border-warning/25 bg-warning-soft text-warning')}>
                            {v === 'up' ? 'Urban Pulse' : v === 'base' ? 'Nearest' : v === 'tie' ? 'Tie' : 'N/A'}</Badge>}</td>
                        <td className="text-xs text-muted-foreground max-md:!block max-md:!text-left">{m.def} ({m.better} is better)</td>
                      </tr>
                    )
                  })}</tbody>
                </table>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  )
}

function WorldCard({ title, sub, w, frame, accent }: { title: string; sub: string; w: WorldResult; frame: number; accent?: boolean }) {
  const snap = w.timeline[Math.min(frame, w.timeline.length - 1)]
  const max = Math.max(...w.perDriver.map((d) => d.assigned), 1)
  return (
    <Card className={cn(accent && 'border-primary/60')}>
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle><CardDescription>{sub}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-center" aria-live="off">
          <div className="rounded-md border p-2"><div className="text-xl font-semibold tabular-nums">{snap.t}</div><div className="text-xs text-muted-foreground">sim minute</div></div>
          <div className="rounded-md border p-2"><div className="text-xl font-semibold tabular-nums">{snap.served}</div><div className="text-xs text-muted-foreground">matched</div></div>
          <div className="rounded-md border p-2"><div className="text-xl font-semibold tabular-nums">{snap.waiting}</div><div className="text-xs text-muted-foreground">waiting now</div></div>
        </div>
        <div className="text-xs text-muted-foreground">
          {w.counts.completed} completed · {w.counts.inFlight} in flight at end · {w.counts.unserved} unserved (gave up after 10 min) · {w.counts.reassignments} reassignments
        </div>
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Trips per captain this run</div>
          <div className="flex h-16 items-end gap-0.5" role="img" aria-label={`Trips per captain: ${w.perDriver.map((d) => d.assigned).join(', ')}`}>
            {w.perDriver.map((d) => <div key={d.id} title={`${d.id}: ${d.assigned} trips, ${d.busyMin} busy min`} className={cn('flex-1 rounded-t', accent ? 'bg-primary' : 'bg-zinc-500')} style={{ height: `${(d.assigned / max) * 100}%`, minHeight: 2 }} />)}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
