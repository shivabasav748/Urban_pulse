import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowRight, Brain, MoveRight } from 'lucide-react'
import { MapCanvas } from '@/components/map/MapCanvas'
import { SimBadge } from '@/components/ride/bits'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Slider } from '@/components/ui/slider'
import { Skeleton } from '@/components/ui/skeleton'
import { rpc } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import forecast from '@/sim/forecast.json'
import { useSettings } from './data'

type Zone = { zone_id: number; name: string; kind: string; lat: number; lng: number; forecast: number; base_forecast: number; actual: number | null; supply: number; gap: number; raw: number; raw_prev: number; smoothed: number; risk: 'low' | 'medium' | 'high' }
type ZI = { sim_clock: string; scenario: string; cap: number; alpha: number; formula: string; zones: Zone[]; moves: { driver_id: string; from_zone: number; to_zone: number; km: number; reason: string }[] }

export const SCENARIOS = [
  { id: 'base', label: 'Normal (model forecast)', how: 'model' },
  { id: 'heavy_rain', label: 'Heavy rain: Khade Bazar, Tilakwadi, Vadgaon (15:00–21:00)', how: 'model feature: rain' },
  { id: 'concert_end', label: 'Match ends at KSCA Stadium (22:00–23:00)', how: 'model feature: incident' },
  { id: 'airport_wave', label: 'Flight wave at Belagavi Airport (06:00–07:30)', how: 'model feature: incident' },
  { id: 'rush_hour', label: 'Rush hour: Nehru Nagar, Udyambag, VTU (17:30–19:30)', how: 'deterministic ×1.6 adjustment (not a model feature)' },
] as const
const RISK = { low: 'border-success/20 bg-success-soft text-success', medium: 'border-warning/25 bg-warning-soft text-warning', high: 'border-destructive/20 bg-danger-soft text-destructive' }
const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${h % 1 ? '30' : '00'}`

export default function ZonesTab() {
  const qc = useQueryClient()
  const settings = useSettings()
  const [scenario, setScenario] = useState<string>('base')
  const [focus, setFocus] = useState(3)
  const zi = useQuery({ queryKey: ['j-zones', scenario, settings.data?.sim_clock], queryFn: () => rpc<ZI>('zone_intelligence', { p_scenario: scenario }) })
  const base = useQuery({ queryKey: ['j-zones', 'base', settings.data?.sim_clock], enabled: scenario !== 'base', queryFn: () => rpc<ZI>('zone_intelligence', { p_scenario: 'base' }) })
  const clock = settings.data ? new Date(settings.data.sim_clock) : null
  const hour = clock ? (() => {
    const [h, m] = clock.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number)
    return h + (m >= 30 ? 0.5 : 0)
  })() : 18

  const setClock = useMutation({ mutationFn: (h: number) => rpc('update_settings', { p: { sim_clock: `2026-11-12T${hhmm(h)}:00+05:30` } }), onSuccess: () => qc.invalidateQueries(), onError: (e) => toast.error(e.message) })
  const apply = useMutation({
    mutationFn: () => rpc<unknown[]>('apply_repositioning', { p_scenario: scenario }),
    onSuccess: (m) => { qc.invalidateQueries(); toast.success(`Moved ${m.length} simulated captains`) }, onError: (e) => toast.error(e.message),
  })
  const zname = (id: number) => zi.data?.zones.find((z) => z.zone_id === id)?.name ?? id
  const sc = SCENARIOS.find((s) => s.id === scenario)!

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-6 p-4">
          <div className="min-w-[260px] flex-1 space-y-2">
            <div className="flex justify-between text-sm"><span>Simulated clock · Thu 12 Nov 2026 (test week)</span><b className="tabular-nums">{hhmm(hour)}</b></div>
            <Slider aria-label="Simulated time of day" min={0} max={23.5} step={0.5} value={[hour]} onValueCommit={([h]) => setClock.mutate(h)} />
          </div>
          <label className="w-full space-y-1 text-sm sm:w-auto">What-if scenario
            <select className="block h-10 w-full rounded-md border bg-background px-2 sm:w-[340px]" value={scenario} onChange={(e) => setScenario(e.target.value)}>
              {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <Badge variant="outline">{sc.how}</Badge><SimBadge />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1fr_440px]">
        <Card className="overflow-hidden p-0">
          <div className="h-[420px]">
            <MapCanvas zones={(zi.data?.zones ?? []).map((z) => ({ id: z.zone_id, name: z.name, lat: z.lat, lng: z.lng, risk: z.risk, note: `forecast ${Number(z.forecast).toFixed(1)} vs ${z.supply} free · ×${Number(z.smoothed).toFixed(2)}` }))}
              fit={zi.data?.zones.map((z) => [z.lat, z.lng] as [number, number])} />
          </div>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Brain className="size-4" aria-hidden />Demand model</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><b>HistGradientBoostingRegressor</b> (Poisson loss) predicts ride requests per zone <b>30 min ahead</b>.</p>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="rounded-md border p-2"><div className="text-lg font-semibold tabular-nums">{forecast.mae.toFixed(2)}</div><div className="text-xs text-muted-foreground">test MAE (model)</div></div>
              <div className="rounded-md border p-2"><div className="text-lg font-semibold tabular-nums">{forecast.baseline_mae.toFixed(2)}</div><div className="text-xs text-muted-foreground">MAE same-time-last-week</div></div>
            </div>
            <p className="text-xs text-muted-foreground">Features: {forecast.features.join(', ')}. Trained on 28 days, tested on the following 7 (chronological split). Synthetic data, seed 42, so accuracy says nothing about real cities.</p>
            <ForecastChart zoneId={focus} scenario={scenario} hour={hour} onZone={setFocus} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Zone supply vs demand at {hhmm(hour)}</CardTitle>
          <CardDescription className="font-mono text-xs">{zi.data?.formula} · cap {zi.data?.cap} · alpha {zi.data?.alpha}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {zi.isLoading ? <Skeleton className="h-40" /> : zi.error ? <p className="text-sm text-destructive">{zi.error.message}</p> : (
            <table className="rtable w-full min-w-[760px] text-sm">
              <thead><tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 font-medium">Zone</th><th className="font-medium">Forecast</th>{scenario !== 'base' && <th className="font-medium">Before event</th>}
                <th className="font-medium">Actual</th><th className="font-medium">Free captains</th><th className="font-medium">Gap</th><th className="font-medium">Surge raw</th><th className="font-medium">Smoothed</th><th className="font-medium">Risk</th>
              </tr></thead>
              <tbody>{zi.data!.zones.map((z) => {
                const b = base.data?.zones.find((x) => x.zone_id === z.zone_id)
                return (
                  <tr key={z.zone_id} className="cursor-pointer border-t hover:bg-muted/50" onClick={() => setFocus(z.zone_id)}>
                    <td className="py-1.5 font-medium">{z.name}</td>
                    <td data-label="Forecast" className="tabular-nums">{Number(z.forecast).toFixed(2)}</td>
                    {scenario !== 'base' && <td data-label="Before event" className="tabular-nums text-muted-foreground">{b ? `${Number(b.forecast).toFixed(2)} · ×${Number(b.smoothed).toFixed(2)}` : '…'}</td>}
                    <td data-label="Actual" className="tabular-nums">{scenario === 'base' ? z.actual ?? 'N/A' : 'N/A (what-if)'}</td>
                    <td data-label="Free captains" className="tabular-nums">{z.supply}</td>
                    <td data-label="Gap" className={cn('tabular-nums', z.gap > 0 && 'font-medium text-destructive')}>{Number(z.gap).toFixed(2)}</td>
                    <td data-label="Surge raw" className="tabular-nums">×{Number(z.raw).toFixed(3)}</td>
                    <td data-label="Smoothed" className="font-semibold tabular-nums">×{Number(z.smoothed).toFixed(3)}</td>
                    <td data-label="Risk"><Badge variant="outline" className={RISK[z.risk]}>{z.risk}</Badge></td>
                  </tr>
                )
              })}</tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><CardTitle className="text-sm">Proactive repositioning</CardTitle>
              <CardDescription>Greedy: largest gap first, nearest idle captain from a zone with surplus (supply − ⌈forecast⌉ &gt; 0).</CardDescription></div>
            <Button size="sm" className="shrink-0" disabled={!zi.data?.moves.length || apply.isPending} onClick={() => apply.mutate()}><MoveRight className="size-4" aria-hidden />Apply moves</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {!zi.data?.moves.length ? <p className="text-muted-foreground">No moves recommended: either no zone is short, or no zone has spare captains.</p>
            : zi.data.moves.map((m, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span>{zname(m.from_zone)}</span><ArrowRight className="size-3.5" aria-hidden /><b>{zname(m.to_zone)}</b>
                <span className="text-muted-foreground">· {Number(m.km).toFixed(1)} km · {m.reason}</span>
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  )
}

function ForecastChart({ zoneId, scenario, hour, onZone }: { zoneId: number; scenario: string; hour: number; onZone: (z: number) => void }) {
  const z = String(zoneId)
  const pred = (forecast.scenarios as Record<string, Record<string, number[]>>)['base'][z]
  const what = scenario !== 'base' ? (forecast.scenarios as Record<string, Record<string, number[]>>)[scenario][z] : null
  const act = (forecast.actual as Record<string, number[]>)[z]
  const max = Math.max(...pred, ...act, ...(what ?? [])) || 1
  const W = 400, H = 140, x = (i: number) => (i / 47) * W, y = (v: number) => H - (v / max) * (H - 10)
  const line = (a: number[]) => a.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  return (
    <figure className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs">Zone <select className="h-7 rounded border bg-background px-1 text-xs" value={zoneId} onChange={(e) => onZone(Number(e.target.value))}>
          {forecast.zones.map((zz) => <option key={zz.id} value={zz.id}>{zz.name}</option>)}</select></label>
        <figcaption className="flex gap-3 text-xs">
          <span className="flex items-center gap-1"><span className="h-0.5 w-4 bg-primary" />predicted</span>
          <span className="flex items-center gap-1"><span className="h-0.5 w-4 bg-zinc-500" />actual</span>
          {what && <span className="flex items-center gap-1"><span className="h-0.5 w-4 bg-red-600" />what-if</span>}
        </figcaption>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full" role="img" aria-label={`Predicted vs actual demand for zone ${zoneId}, 12 Nov`}>
        <line x1={x(hour * 2)} x2={x(hour * 2)} y1={0} y2={H} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="3 3" />
        <path d={line(act)} fill="none" stroke="#71717a" strokeWidth={1.5} />
        <path d={line(pred)} fill="none" stroke="var(--primary)" strokeWidth={2} />
        {what && <path d={line(what)} fill="none" stroke="#dc2626" strokeWidth={2} strokeDasharray="4 3" />}
        {[0, 6, 12, 18, 23].map((h) => <text key={h} x={x(h * 2)} y={H + 12} fontSize={9} textAnchor={h === 0 ? 'start' : h === 23 ? 'end' : 'middle'} fill="currentColor" opacity={0.6}>{h}:00</text>)}
      </svg>
    </figure>
  )
}
