import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { ChevronDown, Loader2, Map as MapIcon, RotateCcw, Settings2, Swords } from 'lucide-react'
import { AppHeader, SimBadge } from '@/components/ride/bits'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useLive, useSweep } from '@/lib/hooks'
import { rpc } from '@/lib/supabase'
import { useSettings } from './data'
import LiveTab from './LiveTab'
import AllocationTab from './AllocationTab'
import ChaosTab from './ChaosTab'
import ZonesTab from './ZonesTab'
import PoolingTab from './PoolingTab'
import MetricsTab from './MetricsTab'

const ALL = [['j-groups'], ['j-offers'], ['j-events'], ['j-drivers'], ['j-busy'], ['j-metrics'], ['j-zones']]

export default function JudgePage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState('live')
  useSweep()
  useLive('trip_groups', ALL)
  useLive('ride_events', [['j-events'], ['j-metrics']])
  useLive('ride_offers', [['j-offers']])
  useLive('driver_profiles', [['j-drivers'], ['j-zones']])
  const settings = useSettings()

  const set = useMutation({
    mutationFn: (p: Record<string, unknown>) => rpc('update_settings', { p }),
    onSuccess: () => qc.invalidateQueries(), onError: (e) => toast.error(e.message),
  })
  const reset = useMutation({
    mutationFn: () => rpc('demo_reset'),
    onSuccess: () => { qc.invalidateQueries(); toast.success('Demo reset: rides cleared, simulated drivers back home') },
    onError: (e) => toast.error(e.message),
  })

  const tabs = [['live', 'Live'], ['allocation', 'Allocation'], ['chaos', 'Chaos Mode'], ['zones', 'Zones & forecast'], ['pooling', 'Pooling'], ['metrics', 'Metrics']] as const
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <AppHeader title="Judge console">
        <Badge variant="outline" className="hidden gap-1 font-normal text-muted-foreground xl:inline-flex" title="OpenStreetMap tiles; routes are straight-line estimates × 1.35">
          <MapIcon className="size-3" aria-hidden /> OSM · estimated routes
        </Badge>
        <SimBadge className="hidden sm:inline-flex" />
        <Button asChild size="sm"><Link to="/judge/arena"><Swords className="size-4" aria-hidden />Arena</Link></Button>
      </AppHeader>
      <Tabs value={tab} onValueChange={setTab} className="flex-1 gap-0">
        <div className="sticky top-14 z-[900] border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <TabsList variant="line" className="no-scrollbar h-11 w-full justify-start overflow-x-auto px-2 md:px-4">
            {tabs.map(([v, l]) => <TabsTrigger key={v} value={v} className="flex-none px-3">{l}</TabsTrigger>)}
          </TabsList>
        </div>
        <details className="group border-b bg-background md:open:bg-background">
          <summary className="flex h-10 cursor-pointer list-none items-center gap-2 px-4 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Settings2 className="size-4" aria-hidden />Demo controls
            <span className="truncate text-xs">· fast demo {settings.data?.fast_demo ? 'on' : 'off'} · timeout {settings.data?.offer_timeout_s ?? '…'}s</span>
            <ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 pb-3 text-sm">
            <div className="flex items-center gap-2">
              <Switch id="fast" checked={!!settings.data?.fast_demo} onCheckedChange={(v) => set.mutate({ fast_demo: v })} />
              <Label htmlFor="fast">Fast demo: simulated captains reply after {settings.data?.auto_accept_s ?? '…'}s</Label>
            </div>
            <label className="flex items-center gap-2">Offer timeout
              <select className="h-9 rounded-md border bg-background px-2" value={settings.data?.offer_timeout_s ?? 15}
                onChange={(e) => set.mutate({ offer_timeout_s: Number(e.target.value) })}>
                {[10, 15, 30, 60].map((s) => <option key={s} value={s}>{s}s</option>)}
              </select>
            </label>
            <Button size="sm" variant="outline" className="sm:ml-auto" disabled={reset.isPending} onClick={() => reset.mutate()}>
              {reset.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCcw className="size-4" aria-hidden />}Reset demo
            </Button>
          </div>
        </details>
        <div className="mx-auto w-full max-w-[1400px] p-3 md:p-4">
          <TabsContent value="live"><LiveTab /></TabsContent>
          <TabsContent value="allocation"><AllocationTab /></TabsContent>
          <TabsContent value="chaos"><ChaosTab /></TabsContent>
          <TabsContent value="zones"><ZonesTab /></TabsContent>
          <TabsContent value="pooling"><PoolingTab /></TabsContent>
          <TabsContent value="metrics"><MetricsTab /></TabsContent>
        </div>
      </Tabs>
    </div>
  )
}
