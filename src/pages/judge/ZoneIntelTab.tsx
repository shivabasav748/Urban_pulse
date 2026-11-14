import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowRight, Loader2, MoveRight, TrendingUp } from 'lucide-react'
import { MapCanvas, ZONE_STATE_COLOR } from '@/components/map/MapCanvas'
import { Empty, LoadError, SimBadge, Tag, friendly } from '@/components/ride/bits'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { rpc } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import type { ZoneState } from '@/lib/zones'
import { useDrivers, useSettings } from './data'

type Zone = { zone_id: number; name: string; lat: number; lng: number; predicted_now: number; predicted_next: number; pending: number; active_trips: number
  available: number; incoming: number; finishing: number; expected_supply: number; demand_30: number; shortage: number; ratio: number; state: ZoneState
  rising: boolean; peak: boolean; pickup_eta_min: number | null; by_category: { bike: number; auto: number; cab: number } }
type MoveRow = { id: string; driver: string; vehicle_category: string; from_zone: number; to_zone: number; source: 'system' | 'captain'; status: string
  reason: { text?: string }; km: number; eta_min: number; simulated: boolean; created_at: string; closed_reason: string | null }
type ZS = { sim_clock: string; settings: { dispatch_policy: string; w_zone: number; cooldown_min: number; max_km: number; peak_ratio: number }; zones: Zone[]; moves: MoveRow[] }

const STATE_TONE = { undersupplied: 'danger', balanced: 'info', oversupplied: 'success' } as const
const STATE_TEXT = { undersupplied: 'Undersupplied', balanced: 'Balanced', oversupplied: 'Oversupplied' }
const MOVE_TONE: Record<string, 'warning' | 'brand' | 'success' | 'muted' | 'danger'> = { recommended: 'warning', accepted: 'brand', arrived: 'success', declined: 'muted', expired: 'muted', cancelled: 'muted' }

export default function ZoneIntelTab() {
  const qc = useQueryClient()
  const settings = useSettings()
  const drivers = useDrivers()
  const zs = useQuery({ queryKey: ['j-zone-status'], queryFn: () => rpc<ZS>('zone_status'), refetchInterval: 4000 })
  const run = useMutation({
    mutationFn: () => rpc<{ recommended: number; arrived: number; expired: number }>('admin_reposition_now'),
    onSuccess: (r) => { toast.success(`Repositioning pass: ${r.recommended} new suggestion${r.recommended === 1 ? '' : 's'}, ${r.arrived} arrival${r.arrived === 1 ? '' : 's'}`); qc.invalidateQueries({ queryKey: ['j-zone-status'] }) },
    onError: (e) => toast.error(friendly(e.message)),
  })
  const set = useMutation({ mutationFn: (p: Record<string, unknown>) => rpc('update_settings', { p }), onSuccess: () => qc.invalidateQueries(), onError: (e) => toast.error(friendly(e.message)) })
  if (zs.isLoading) return <div className="grid gap-4 lg:grid-cols-12"><Skeleton className="h-[440px] rounded-2xl lg:col-span-5" /><Skeleton className="h-[440px] rounded-2xl lg:col-span-7" /></div>
  if (zs.error || !zs.data) return <LoadError what="zone intelligence" error={zs.error} retry={() => zs.refetch()} />
  const d = zs.data
  const zname = (id: number) => d.zones.find((z) => z.zone_id === id)?.name ?? `Zone ${id}`
  const short = d.zones.filter((z) => z.state === 'undersupplied'), peaks = d.zones.filter((z) => z.peak)
  const open = d.moves.filter((m) => m.status === 'recommended' || m.status === 'accepted')
  const clock = new Date(d.sim_clock).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit' })
  const policy = settings.data?.dispatch_policy ?? d.settings.dispatch_policy

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[
          ['Areas needing captains', `${short.length} of ${d.zones.length}`, short.length ? 'text-rose-700' : 'text-emerald-700'],
          ['Busiest right now', peaks.length ? `${peaks.length} area${peaks.length === 1 ? '' : 's'}` : 'none', peaks.length ? 'text-amber-700' : 'text-slate-900'],
          ['Captains being moved', String(open.length), 'text-teal-800'],
          ['Demo time', clock, 'text-slate-900'],
        ].map(([k, v, tone]) => (
          <div key={k} className="rounded-2xl border bg-white p-3 shadow-xs">
            <div className="text-[10px] font-bold tracking-wide text-slate-500 uppercase">{k}</div>
            <div className={cn('mt-0.5 font-mono text-lg font-bold num', tone)}>{v}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="overflow-hidden p-0 lg:col-span-5">
          <div className="flex items-center justify-between px-4 pt-3"><span className="text-xs font-bold tracking-wider uppercase">Zone state map</span><SimBadge /></div>
          <div className="m-3 h-[380px] overflow-hidden rounded-xl border">
            <MapCanvas zones={d.zones.map((z) => ({ id: z.zone_id, name: z.name, lat: z.lat, lng: z.lng, color: ZONE_STATE_COLOR[z.state], strong: z.peak,
                note: `${STATE_TEXT[z.state]} · ~${Math.round(z.demand_30)} requests vs ${z.expected_supply} captains${z.peak ? ' · PEAK' : ''}` }))}
              drivers={(drivers.data ?? []).filter((x) => x.online).map((x) => ({ id: x.user_id, lat: x.lat, lng: x.lng, label: x.profiles.display_name, category: x.vehicle_category }))}
              fit={d.zones.map((z) => [z.lat, z.lng] as [number, number])} />
          </div>
          <div className="flex flex-wrap gap-3 border-t px-4 py-2.5 text-xs text-slate-600">
            {(['undersupplied', 'balanced', 'oversupplied'] as const).map((s) => <span key={s} className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: ZONE_STATE_COLOR[s] }} />{STATE_TEXT[s]}</span>)}
            <span>Thick ring = peak</span>
          </div>
        </Card>

        <Card className="lg:col-span-7">
          <CardHeader className="pb-1">
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-sm font-bold">Which areas need captains in the next 30 minutes</CardTitle>
                <CardDescription className="text-xs">Expected riders (forecast + people waiting now) compared with captains who will be there.</CardDescription>
              </div>
              <SimBadge />
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <ul className="divide-y rounded-xl border">
              {[...d.zones].sort((a, b) => Number(b.shortage) - Number(a.shortage)).map((z) => {
                const gap = Math.round(Number(z.shortage))
                return (
                  <li key={z.zone_id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: ZONE_STATE_COLOR[z.state] }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-semibold">{z.name}</span>
                    <span className="hidden text-xs text-slate-500 sm:inline num">~{Math.round(Number(z.demand_30))} riders · {z.expected_supply} captain{z.expected_supply === 1 ? "" : "s"}</span>
                    <span className={cn('shrink-0 text-xs font-semibold', z.state === 'undersupplied' ? 'text-rose-700' : z.state === 'oversupplied' ? 'text-emerald-700' : 'text-sky-700')}>
                      {z.state === 'undersupplied' ? `Needs ${Math.max(1, gap)} more` : z.state === 'oversupplied' ? `${Math.max(1, -gap)} spare` : 'Balanced'}{z.peak ? ' · busy' : ''}
                    </span>
                  </li>
                )
              })}
            </ul>
            <details className="mt-3 group">
              <summary className="cursor-pointer text-xs font-semibold text-teal-800">Show all numbers</summary>
            <table className="rtable mt-2 w-full min-w-[820px] text-left text-xs">
              <thead><tr className="border-b bg-slate-50/60 text-[10px] font-bold tracking-wider text-slate-500 uppercase">
                <th className="px-2 py-2.5">Zone</th><th className="px-2">Demand 30 min</th><th className="px-2">Waiting</th><th className="px-2">Free</th><th className="px-2">En route</th>
                <th className="px-2">Expected supply</th><th className="px-2">Gap</th><th className="px-2">State</th><th className="px-2">Nearest pickup</th><th className="px-2 whitespace-nowrap">Bike · Auto · Cab</th>
              </tr></thead>
              <tbody className="divide-y">
                {d.zones.map((z) => (
                  <tr key={z.zone_id} className="hover:bg-slate-50/80">
                    <td className="px-2 py-2.5 font-semibold">{z.name}</td>
                    <td data-label="Demand 30 min" className="px-2 font-mono num">{Number(z.demand_30).toFixed(1)}{z.rising && <TrendingUp className="ml-1 inline size-3 text-amber-600" aria-label="rising" />}</td>
                    <td data-label="Waiting" className="px-2 font-mono num">{z.pending}</td>
                    <td data-label="Free" className="px-2 font-mono num">{z.available}</td>
                    <td data-label="En route" className="px-2 font-mono num">{z.incoming}{z.finishing ? ` +${z.finishing}` : ''}</td>
                    <td data-label="Expected supply" className="px-2 font-mono num">{z.expected_supply}</td>
                    <td data-label="Gap" className={cn('px-2 font-mono font-semibold num', Number(z.shortage) > 0 ? 'text-rose-700' : 'text-emerald-700')}>{Number(z.shortage) > 0 ? '+' : ''}{Number(z.shortage).toFixed(1)}</td>
                    <td data-label="State" className="px-2"><span className="inline-flex gap-1"><Tag tone={STATE_TONE[z.state]}>{STATE_TEXT[z.state]}</Tag>{z.peak && <Tag tone="warning">Peak</Tag>}</span></td>
                    <td data-label="Nearest pickup" className="px-2 font-mono num">{z.pickup_eta_min == null ? 'none free' : `${Math.ceil(z.pickup_eta_min)} min`}</td>
                    <td data-label="Bike · Auto · Cab" className="px-2 font-mono whitespace-nowrap num">{z.by_category.bike} · {z.by_category.auto} · {z.by_category.cab}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[11px] text-slate-500">
              Undersupplied: gap ≥ 1. Oversupplied: ≥ 2 spare captains. Peak: demand ÷ supply ≥ {d.settings.peak_ratio} with at least 2 requests, worked out from data, not clock hours. Rising: next bucket ≥ 15% above now.
              The forecast is trained on synthetic history (seed 42), not real Belagavi traffic.
            </p>
            </details>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-7">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <CardTitle className="text-sm font-bold">Repositioning feed</CardTitle>
                <CardDescription className="text-xs">Largest shortage first; nearest idle captain from a zone that keeps at least one spare; {d.settings.cooldown_min}-min cooldown; at most {Number(d.settings.max_km)} km straight-line. A move counts only when the captain is seen arriving.</CardDescription>
              </div>
              <Button size="sm" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <MoveRight className="size-4" aria-hidden />}Run repositioning now</Button>
            </div>
          </CardHeader>
          <CardContent>
            {!d.moves.length ? (
              <Empty>No moves yet. When a zone is short and another has spare captains, suggestions appear here (the sweep plans every 10 s). At the 18:00 demo clock every zone is busy, so there may be nothing to move: that is correct, not a bug.</Empty>
            ) : (
              <ol className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                {d.moves.map((m) => (
                  <li key={m.id} className="rounded-xl border bg-surface p-2.5 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold">{m.driver}</span>
                      <span className="text-slate-500">{zname(m.from_zone)}</span><ArrowRight className="size-3 text-slate-400" aria-hidden /><span className="font-semibold">{zname(m.to_zone)}</span>
                      <Tag tone={MOVE_TONE[m.status] ?? 'muted'}>{m.status}</Tag>
                      {m.source === 'captain' && <Tag tone="info">captain's choice</Tag>}
                      {m.simulated && <Tag tone="warning">simulated driver</Tag>}
                    </div>
                    <p className="mt-1 text-slate-600">{m.reason.text}{m.closed_reason && ` · ${m.closed_reason.replaceAll('_', ' ')}`}</p>
                    <p className="font-mono text-slate-500 num">{Number(m.km).toFixed(1)} km · {Math.ceil(m.eta_min)} min · {new Date(m.created_at).toLocaleTimeString()}</p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-5">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-bold">Dispatch policy (live)</CardTitle>
            <CardDescription className="text-xs">Every new request is allocated automatically with this policy. Compare policies on identical requests in the Dispatch Arena.</CardDescription></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-sm text-slate-700">Each request goes to the captain with the best mix of <b>closest arrival</b>, <b>fewest trips today</b>, <b>reliability</b> and <b>longest wait for work</b>.</p>
            <details><summary className="cursor-pointer text-xs font-semibold text-teal-800">Policy details and switch</summary><div className="mt-2 space-y-3">
            <div role="radiogroup" aria-label="Dispatch policy" className="grid grid-cols-2 gap-1 rounded-xl border bg-slate-100 p-1">
              {([['zone_aware', 'Zone-aware'], ['urban_pulse', 'Score only']] as const).map(([v, l]) => (
                <button key={v} role="radio" aria-checked={policy === v} onClick={() => set.mutate({ dispatch_policy: v })}
                  className={cn('h-10 rounded-lg text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring', policy === v ? 'bg-primary text-white' : 'text-slate-600 hover:bg-slate-200')}>{l}</button>
              ))}
            </div>
            <p className="text-xs leading-relaxed text-slate-600">
              <b>Score only:</b> 0.45·ETA + 0.25·workload + 0.20·reliability + 0.10·idle time.<br />
              <b>Zone-aware:</b> (1 − w)·that score + w·zone balance, where zone balance prefers captains from zones with spare supply so a short zone is not drained.
            </p>
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Evidence (Dispatch Arena, 20 scenarios × 10 seeds, simulated): the zone term added about 0.3 min of pickup wait without improving completion,
              so <b>score only</b> is the default. Zone intelligence still drives the repositioning planner below.
            </p>
            <label className="flex items-center justify-between gap-2 text-sm">Zone weight w
              <select className="h-10 rounded-xl border bg-white px-2" value={settings.data?.w_zone ?? d.settings.w_zone} disabled={policy !== 'zone_aware'} onChange={(e) => set.mutate({ w_zone: Number(e.target.value) })}>
                {[0.05, 0.1, 0.15, 0.2, 0.3].map((w) => <option key={w} value={w}>{w.toFixed(2)}</option>)}
              </select>
            </label>
            </div></details>
            <p className="text-[11px] text-slate-500">Hard filters before any score: vehicle type, online, fresh location, within the rider's 2/3/5 km radius, not busy, not already tried, and the women-driver preference when the rider asked for it.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
