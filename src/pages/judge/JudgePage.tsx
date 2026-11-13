import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Activity, BarChart3, Compass, FlaskConical, GitMerge, Layers, LineChart, Loader2, RotateCcw, Shield, ShieldAlert, Sliders, Swords } from 'lucide-react'
import { Footer, TopNav } from '@/components/layout/AppShell'
import { SimBadge, friendly } from '@/components/ride/bits'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useLive, useSweep } from '@/lib/hooks'
import { rpc } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import forecast from '@/sim/forecast.json'
import { useSettings } from './data'
import LiveTab from './LiveTab'
import AllocationTab from './AllocationTab'
import ChaosTab from './ChaosTab'
import ZonesTab from './ZonesTab'
import ZoneIntelTab from './ZoneIntelTab'
import PoolingTab from './PoolingTab'
import MetricsTab from './MetricsTab'
import SafetyTab from './SafetyTab'

const ALL = [['j-groups'], ['j-offers'], ['j-events'], ['j-drivers'], ['j-busy'], ['j-metrics'], ['j-zones'], ['j-zone-status'], ['j-audit']]
const TABS = [
  { id: 'zones', label: 'Zone intelligence', icon: Layers },
  { id: 'live', label: 'Live fleet', icon: Activity },
  { id: 'allocation', label: 'Allocation', icon: Compass },
  { id: 'chaos', label: 'Chaos Mode', icon: FlaskConical },
  { id: 'forecast', label: 'Forecast & what-if', icon: LineChart },
  { id: 'pooling', label: 'Pooling', icon: GitMerge },
  { id: 'safety', label: 'Safety', icon: ShieldAlert },
  { id: 'metrics', label: 'Metrics', icon: BarChart3 },
  { id: 'demo', label: 'Demo controls', icon: Sliders },
] as const
type TabId = (typeof TABS)[number]['id']
type M = { completion_rate: number | null; avg_match_wait_s: number | null; reassignment_success_rate: number | null }

export default function JudgePage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<TabId>('zones')
  useSweep()
  useLive('trip_groups', ALL)
  useLive('ride_events', [['j-events'], ['j-metrics']])
  useLive('ride_offers', [['j-offers'], ['j-audit']])
  useLive('driver_profiles', [['j-drivers'], ['j-zones'], ['j-zone-status']])
  useLive('reposition_moves', [['j-zone-status']])
  const settings = useSettings()
  const m = useQuery({ queryKey: ['j-metrics', 'head'], queryFn: () => rpc<M>('admin_metrics') })

  const set = useMutation({ mutationFn: (p: Record<string, unknown>) => rpc('update_settings', { p }), onSuccess: () => qc.invalidateQueries(), onError: (e) => toast.error(friendly(e.message)) })
  const reset = useMutation({
    mutationFn: () => rpc('demo_reset'),
    onSuccess: () => { qc.invalidateQueries(); toast.success('Demo reset: rides cleared, simulated captains back home') },
    onError: (e) => toast.error(friendly(e.message)),
  })
  const chip = (label: string, value: string, tone: string) => (
    <div className="min-w-0 rounded-xl border bg-surface px-3 py-1.5">
      <div className="truncate text-[10px] font-bold tracking-wide text-slate-500 uppercase">{label}</div>
      <div className={cn('font-mono text-sm font-bold num', tone)}>{value}</div>
    </div>
  )

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <TopNav />
      <main className="mx-auto w-full max-w-7xl flex-1 space-y-4 px-2 py-3 sm:px-4">
        <section className="flex flex-col justify-between gap-4 rounded-2xl border bg-white p-4 shadow-md shadow-slate-900/5 sm:p-5 md:flex-row md:items-center">
          <div className="flex items-center gap-2.5">
            <span className="rounded-xl border border-teal-200 bg-teal-50 p-2 text-teal-800"><Shield className="size-5" aria-hidden /></span>
            <div>
              <div className="flex items-center gap-2"><h1 className="text-lg font-bold tracking-tight">Judge control room</h1><SimBadge /></div>
              <p className="text-xs text-slate-500">Zone intelligence, explainable allocation and the live dispatch log</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="grid grid-cols-3 gap-2 max-sm:w-full">
              {chip('Completion', m.data?.completion_rate == null ? 'N/A' : `${Math.round(m.data.completion_rate * 100)}%`, 'text-emerald-700')}
              {chip('Match wait', m.data?.avg_match_wait_s == null ? 'N/A' : `${m.data.avg_match_wait_s}s`, 'text-sky-700')}
              {chip('Forecast MAE', `${forecast.mae.toFixed(2)} vs ${forecast.baseline_mae.toFixed(2)}`, 'text-teal-800')}
            </div>
            <Button asChild className="max-sm:w-full"><Link to="/judge/arena"><Swords className="size-4" aria-hidden />Dispatch Arena</Link></Button>
          </div>
        </section>

        <div role="tablist" aria-label="Judge console" className="no-scrollbar flex items-center gap-1.5 overflow-x-auto rounded-2xl border bg-white p-1.5 shadow-xs">
          {TABS.map((t) => {
            const on = tab === t.id, Icon = t.icon, demo = t.id === 'demo'
            return (
              <button key={t.id} role="tab" aria-selected={on} aria-controls={`panel-${t.id}`} id={`tab-${t.id}`} onClick={() => setTab(t.id)}
                className={cn('flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm',
                  on ? (demo ? 'bg-amber-600 text-white shadow-xs' : 'bg-primary text-white shadow-xs') : demo ? 'text-amber-800 hover:bg-amber-50' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')}>
                <Icon className="size-3.5" aria-hidden />{t.label}
              </button>
            )
          })}
        </div>

        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'zones' && <ZoneIntelTab />}
          {tab === 'live' && <LiveTab />}
          {tab === 'allocation' && <AllocationTab />}
          {tab === 'chaos' && <ChaosTab />}
          {tab === 'forecast' && <ZonesTab />}
          {tab === 'pooling' && <PoolingTab />}
          {tab === 'safety' && <SafetyTab />}
          {tab === 'metrics' && <MetricsTab />}
          {tab === 'demo' && (
            <section className="space-y-4 rounded-2xl border bg-white p-4 shadow-sm sm:p-5">
              <div><h2 className="text-base font-bold">Demo controls</h2><p className="text-xs text-slate-500">Affect the live demo only. Simulated captains are server-driven.</p></div>
              <div className="flex items-center gap-3">
                <Switch id="fast" checked={!!settings.data?.fast_demo} onCheckedChange={(v) => set.mutate({ fast_demo: v })} />
                <Label htmlFor="fast">Fast demo: simulated captains reply after {settings.data?.auto_accept_s ?? '…'}s and drive themselves</Label>
              </div>
              <div className="flex items-start gap-3">
                <Switch id="surge" checked={!!settings.data?.surge_enabled} onCheckedChange={(v) => set.mutate({ surge_enabled: v })} />
                <Label htmlFor="surge" className="block leading-snug">Charge surge to riders (simulated)
                  <span className="block text-xs font-normal text-slate-500">Off by default: Karnataka's app-cab fare order bars extra charges and the state has restricted surge before. When on, surge is capped at 2× (MoRTH 2025 guideline). Zone surge numbers are always computed as a demand-pressure index.</span>
                </Label>
              </div>
              <label className="flex flex-wrap items-center gap-2 text-sm">Offer timeout
                <select className="h-10 rounded-xl border bg-white px-2" value={settings.data?.offer_timeout_s ?? 15} onChange={(e) => set.mutate({ offer_timeout_s: Number(e.target.value) })}>
                  {[10, 15, 30, 60].map((s) => <option key={s} value={s}>{s}s</option>)}
                </select>
              </label>
              <Button variant="outline" className="h-auto min-h-11 whitespace-normal py-2 text-left" disabled={reset.isPending} onClick={() => reset.mutate()}>
                {reset.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCcw className="size-4" aria-hidden />}Reset demo (clears rides, moves and safety data)
              </Button>
            </section>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
