import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Gauge, Map as MapIcon, RotateCcw, Swords } from 'lucide-react'
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

  return (
    <div className="flex min-h-dvh flex-col bg-muted/30">
      <AppHeader title="Judge console">
        <Badge variant="outline" className="hidden gap-1 lg:inline-flex" title="Map: OpenStreetMap tiles; routes are straight-line estimates × 1.35">
          <MapIcon className="size-3" aria-hidden /> Demo routing mode (OSM, estimated)
        </Badge>
        <SimBadge />
      </AppHeader>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b bg-background px-4 py-2 text-sm">
        <div className="flex items-center gap-2">
          <Switch id="fast" checked={!!settings.data?.fast_demo} onCheckedChange={(v) => set.mutate({ fast_demo: v })} />
          <Label htmlFor="fast">Fast demo (simulated captains respond after {settings.data?.auto_accept_s ?? '…'}s)</Label>
        </div>
        <label className="flex items-center gap-2">Offer timeout
          <select className="h-8 rounded-md border bg-background px-2" value={settings.data?.offer_timeout_s ?? 15}
            onChange={(e) => set.mutate({ offer_timeout_s: Number(e.target.value) })}>
            {[10, 15, 30, 60].map((s) => <option key={s} value={s}>{s}s</option>)}
          </select>
        </label>
        <div className="ml-auto flex gap-2">
          <Button asChild size="sm" variant="default"><Link to="/judge/arena"><Swords className="size-4" aria-hidden />Dispatch Arena</Link></Button>
          <Button size="sm" variant="outline" disabled={reset.isPending} onClick={() => reset.mutate()}><RotateCcw className="size-4" aria-hidden />Reset demo</Button>
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab} className="flex-1 p-4">
        <TabsList className="flex h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="live">Live</TabsTrigger>
          <TabsTrigger value="allocation">Allocation</TabsTrigger>
          <TabsTrigger value="chaos">Chaos Mode</TabsTrigger>
          <TabsTrigger value="zones">Zones &amp; forecast</TabsTrigger>
          <TabsTrigger value="pooling">Pooling</TabsTrigger>
          <TabsTrigger value="metrics"><Gauge className="size-4" aria-hidden />Metrics</TabsTrigger>
        </TabsList>
        <TabsContent value="live" className="mt-4"><LiveTab /></TabsContent>
        <TabsContent value="allocation" className="mt-4"><AllocationTab /></TabsContent>
        <TabsContent value="chaos" className="mt-4"><ChaosTab /></TabsContent>
        <TabsContent value="zones" className="mt-4"><ZonesTab /></TabsContent>
        <TabsContent value="pooling" className="mt-4"><PoolingTab /></TabsContent>
        <TabsContent value="metrics" className="mt-4"><MetricsTab /></TabsContent>
      </Tabs>
    </div>
  )
}
