import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowDownUp, History, Loader2, MapPin, RefreshCw, Users } from 'lucide-react'
import { MapCanvas, type MapPin as Pin } from '@/components/map/MapCanvas'
import { AppHeader, CAT_ICON, CAT_LABEL, FareBreakdown, SimBadge, StatusChip, StatusStepper, statusText } from '@/components/ride/bits'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/lib/auth'
import { useLive, useSweep } from '@/lib/hooks'
import { PLACES, type Place } from '@/lib/places'
import { rpc, supabase, type Ride } from '@/lib/supabase'
import { inr } from '@/lib/geo'
import { cn } from '@/lib/utils'

type Estimate = {
  distance_km: number; surge: number; zone?: { name: string; forecast: number; supply: number; raw: number; smoothed: number }
  categories: { category: 'bike' | 'auto' | 'cab'; trip_min: number; fare: Ride['fare']; drivers: number; pickup_eta_min: number | null }[]
}
const ACTIVE = ['requested', 'offered', 'accepted', 'arriving', 'ongoing']

function PlaceSelect({ id, label, value, onChange, exclude }: { id: string; label: string; value?: Place; onChange: (p: Place) => void; exclude?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-background px-2">
      <span className={cn('size-2.5 shrink-0 rounded-full', id === 'pickup' ? 'bg-primary' : 'bg-foreground')} aria-hidden />
      <label htmlFor={id} className="sr-only">{label}</label>
      <select id={id} className="h-10 w-full bg-transparent text-sm outline-none" value={value?.id ?? ''}
        onChange={(e) => { const p = PLACES.find((x) => x.id === e.target.value); if (p) onChange(p) }}>
        <option value="" disabled>{label}</option>
        {PLACES.filter((p) => p.id !== exclude).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.area}</option>)}
      </select>
    </div>
  )
}

export default function RiderPage() {
  const { session } = useAuth()
  const uid = session!.user.id
  const qc = useQueryClient()
  const [pickup, setPickup] = useState<Place>()
  const [drop, setDrop] = useState<Place>()
  const [cat, setCat] = useState<'bike' | 'auto' | 'cab'>('bike')
  useSweep()
  useLive('rides', [['rides', uid]], `rider_id=eq.${uid}`)
  useLive('driver_profiles', [['drivers']])

  const rides = useQuery({
    queryKey: ['rides', uid],
    queryFn: async () => {
      const { data, error } = await supabase.from('rides').select('*').eq('rider_id', uid).order('requested_at', { ascending: false }).limit(30)
      if (error) throw error
      return data as Ride[]
    },
  })
  const active = rides.data?.find((r) => ACTIVE.includes(r.status))
  const latest = rides.data?.[0]
  const showTracker = active ?? (latest && Date.now() - new Date(latest.requested_at).getTime() < 10 * 60e3 && !dismissed(latest.id) ? latest : undefined)

  const drivers = useQuery({
    queryKey: ['drivers'],
    queryFn: async () => {
      const { data, error } = await supabase.from('driver_profiles').select('user_id, lat, lng, vehicle_category, online, vehicle_label, plate, profiles(display_name)').eq('online', true)
      if (error) throw error
      return data as unknown as { user_id: string; lat: number; lng: number; vehicle_category: string; vehicle_label: string; plate: string; profiles: { display_name: string } }[]
    },
  })

  const estimate = useQuery({
    queryKey: ['estimate', pickup?.id, drop?.id],
    enabled: !!pickup && !!drop && !active,
    queryFn: () => rpc<Estimate>('estimate_ride', { p_lat: pickup!.lat, p_lng: pickup!.lng, d_lat: drop!.lat, d_lng: drop!.lng }),
  })

  const request = useMutation({
    mutationFn: () => rpc('request_ride', { p_pickup_label: pickup!.name, p_lat: pickup!.lat, p_lng: pickup!.lng, p_drop_label: drop!.name, d_lat: drop!.lat, d_lng: drop!.lng, p_category: cat }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rides', uid] }); toast.success('Ride requested') },
    onError: (e) => toast.error(e.message),
  })
  const cancel = useMutation({
    mutationFn: (id: string) => rpc('cancel_ride', { p_ride: id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rides', uid] }),
    onError: (e) => toast.error(e.message),
  })

  const assigned = drivers.data?.find((d) => d.user_id === showTracker?.driver_id)
  const pins: Pin[] = showTracker
    ? [{ lat: showTracker.pickup_lat, lng: showTracker.pickup_lng, kind: 'pickup', label: showTracker.pickup_label },
       { lat: showTracker.drop_lat, lng: showTracker.drop_lng, kind: 'drop', label: showTracker.drop_label }]
    : [pickup && { ...pickup, kind: 'pickup' as const, label: pickup.name }, drop && { ...drop, kind: 'drop' as const, label: drop.name }].filter(Boolean) as Pin[]
  const route = pins.length === 2 ? pins.map((p) => [p.lat, p.lng] as [number, number]) : undefined
  const mapDrivers = useMemo(() => (drivers.data ?? []).map((d) => ({
    id: d.user_id, lat: d.lat, lng: d.lng, label: d.profiles?.display_name ?? 'Driver', category: d.vehicle_category,
    highlight: d.user_id === showTracker?.driver_id,
  })), [drivers.data, showTracker?.driver_id])
  const fit = assigned && showTracker && ['accepted', 'arriving'].includes(showTracker.status)
    ? [[assigned.lat, assigned.lng], [showTracker.pickup_lat, showTracker.pickup_lng]] as [number, number][]
    : route

  return (
    <div className="flex h-dvh flex-col">
      <AppHeader title="Ride"><SimBadge className="hidden sm:inline-flex" /></AppHeader>
      <div className="relative flex min-h-0 flex-1 flex-col-reverse md:flex-row">
        <aside className="z-[500] max-h-[62dvh] w-full shrink-0 overflow-y-auto border-t bg-background md:max-h-none md:w-[400px] md:border-r md:border-t-0">
          <Tabs defaultValue="book" className="p-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="book">{showTracker ? 'Your ride' : 'Book'}</TabsTrigger>
              <TabsTrigger value="history"><History className="size-4" aria-hidden />History</TabsTrigger>
            </TabsList>

            <TabsContent value="book" className="mt-4 space-y-4">
              {rides.isLoading ? <Skeleton className="h-40 w-full" /> : showTracker ? (
                <Tracker ride={showTracker} driver={assigned} onCancel={() => cancel.mutate(showTracker.id)} cancelling={cancel.isPending}
                  onDone={() => { dismiss(showTracker.id); qc.invalidateQueries({ queryKey: ['rides', uid] }) }} />
              ) : (
                <>
                  <div className="relative space-y-2">
                    <PlaceSelect id="pickup" label="Pickup location" value={pickup} onChange={setPickup} exclude={drop?.id} />
                    <PlaceSelect id="drop" label="Where to?" value={drop} onChange={setDrop} exclude={pickup?.id} />
                    <Button type="button" variant="outline" size="icon" className="absolute top-1/2 right-[-6px] size-7 -translate-y-1/2 rounded-full bg-background"
                      aria-label="Swap pickup and destination" onClick={() => { setPickup(drop); setDrop(pickup) }} disabled={!pickup && !drop}>
                      <ArrowDownUp className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                  {!pickup || !drop ? (
                    <p className="flex items-center gap-2 rounded-md bg-muted p-3 text-sm text-muted-foreground">
                      <MapPin className="size-4 shrink-0" aria-hidden /> Choose pickup and destination from the demo places to see prices.
                    </p>
                  ) : estimate.isLoading ? (
                    <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
                  ) : estimate.error ? (
                    <Alert variant="destructive"><AlertDescription>Couldn't estimate: {estimate.error.message}</AlertDescription></Alert>
                  ) : estimate.data && (
                    <>
                      <div className="flex items-baseline justify-between text-sm">
                        <span className="text-muted-foreground">{estimate.data.distance_km} km · estimated route</span>
                        {estimate.data.surge > 1 && <span className="font-medium text-amber-700">×{estimate.data.surge.toFixed(2)} surge</span>}
                      </div>
                      <div role="radiogroup" aria-label="Ride type" className="space-y-2">
                        {estimate.data.categories.map((c) => {
                          const Icon = CAT_ICON[c.category]
                          const none = c.drivers === 0
                          return (
                            <button key={c.category} role="radio" aria-checked={cat === c.category} disabled={none}
                              onClick={() => setCat(c.category)}
                              className={cn('flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors disabled:opacity-50',
                                cat === c.category ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted')}>
                              <Icon className="size-6 text-muted-foreground" aria-hidden />
                              <div className="min-w-0 flex-1">
                                <div className="font-medium">{CAT_LABEL[c.category]}</div>
                                <div className="text-xs text-muted-foreground">
                                  {none ? 'No drivers nearby' : <>Pickup in {Math.ceil(c.pickup_eta_min ?? 0)} min · <Users className="inline size-3" aria-hidden /> {c.drivers} nearby · {Math.round(c.trip_min)} min trip</>}
                                </div>
                              </div>
                              <div className="text-right font-semibold tabular-nums">{inr(c.fare.total)}</div>
                            </button>
                          )
                        })}
                      </div>
                      {estimate.data.zone && estimate.data.surge > 1 && (
                        <p className="text-xs text-muted-foreground">
                          Surge in {estimate.data.zone.name}: forecast {Number(estimate.data.zone.forecast).toFixed(1)} rides vs {estimate.data.zone.supply} free drivers next 30 min (simulated).
                        </p>
                      )}
                      <Button className="h-11 w-full" disabled={request.isPending} onClick={() => request.mutate()}>
                        {request.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}Request {CAT_LABEL[cat]}
                      </Button>
                    </>
                  )}
                </>
              )}
            </TabsContent>

            <TabsContent value="history" className="mt-4 space-y-2">
              {rides.isLoading ? <Skeleton className="h-24 w-full" /> : !rides.data?.length ? (
                <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">No rides yet. Your completed and cancelled trips will show here.</p>
              ) : rides.data.map((r) => (
                <details key={r.id} className="rounded-lg border p-3">
                  <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">{r.pickup_label} → {r.drop_label}</span>
                    <span className="shrink-0 font-medium tabular-nums">{inr(r.fare.total)}</span>
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{new Date(r.requested_at).toLocaleString()}</span><StatusChip status={r.status} />
                    </div>
                    <FareBreakdown fare={r.fare} />
                  </div>
                </details>
              ))}
            </TabsContent>
          </Tabs>
        </aside>
        <div className="relative min-h-[38dvh] flex-1">
          <MapCanvas drivers={mapDrivers} pins={pins} route={route} fit={fit}
            onPick={showTracker ? undefined : (lat, lng) => {
              const near = PLACES.reduce((a, b) => (Math.hypot(a.lat - lat, a.lng - lng) < Math.hypot(b.lat - lat, b.lng - lng) ? a : b))
              if (!pickup) setPickup(near); else if (!drop && near.id !== pickup.id) setDrop(near)
            }} />
          <div className="pointer-events-none absolute top-3 left-3 z-[400] sm:hidden"><SimBadge className="bg-amber-50/95" /></div>
        </div>
      </div>
    </div>
  )
}

function Tracker({ ride, driver, onCancel, cancelling, onDone }: {
  ride: Ride; driver?: { vehicle_label: string; plate: string; profiles: { display_name: string } }
  onCancel: () => void; cancelling: boolean; onDone: () => void
}) {
  const finished = !ACTIVE.includes(ride.status)
  return (
    <div className="space-y-4" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{statusText(ride.status)}</h2>
        <StatusChip status={ride.status} />
      </div>
      {ride.status !== 'cancelled' && ride.status !== 'no_driver_found' && <StatusStepper status={ride.status} />}
      {ride.attempt_no > 1 && ACTIVE.includes(ride.status) && (
        <Alert><RefreshCw className="size-4" aria-hidden /><AlertDescription>Reassigned automatically: attempt {ride.attempt_no}. The previous driver didn't respond or declined.</AlertDescription></Alert>
      )}
      {ride.status === 'no_driver_found' && (
        <Alert variant="destructive"><AlertDescription>No driver accepted after {ride.attempt_no} attempts. Try another ride type or try again shortly.</AlertDescription></Alert>
      )}
      <Card><CardContent className="space-y-1 p-3 text-sm">
        <div className="flex gap-2"><span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden /><span>{ride.pickup_label}</span></div>
        <div className="flex gap-2"><span className="mt-1.5 size-2 shrink-0 rounded-full bg-foreground" aria-hidden /><span>{ride.drop_label}</span></div>
      </CardContent></Card>
      {driver && ['accepted', 'arriving', 'ongoing', 'completed'].includes(ride.status) && (
        <Card><CardContent className="flex items-center gap-3 p-3">
          <div className="grid size-10 place-items-center rounded-full bg-muted font-semibold" aria-hidden>{driver.profiles.display_name.replace('Captain ', '')[0]}</div>
          <div className="min-w-0 flex-1">
            <div className="font-medium">{driver.profiles.display_name}</div>
            <div className="text-xs text-muted-foreground">{driver.vehicle_label} · <span className="font-mono">{driver.plate}</span></div>
          </div>
          {ride.est_pickup_min != null && ['accepted', 'arriving'].includes(ride.status) && (
            <div className="text-right"><div className="text-lg font-semibold tabular-nums">{Math.ceil(ride.est_pickup_min)} min</div><div className="text-xs text-muted-foreground">to pickup (est.)</div></div>
          )}
        </CardContent></Card>
      )}
      <FareBreakdown fare={ride.fare} />
      {finished ? (
        <Button className="w-full" onClick={onDone}>Book another ride</Button>
      ) : ['requested', 'offered', 'accepted', 'arriving'].includes(ride.status) && (
        <Button variant="outline" className="w-full" onClick={onCancel} disabled={cancelling}>Cancel ride</Button>
      )}
    </div>
  )
}

const KEY = 'up.dismissed'
function dismissed(id: string) { try { return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]).includes(id) } catch { return false } }
function dismiss(id: string) { try { localStorage.setItem(KEY, JSON.stringify([id])) } catch { /* private mode */ } }
