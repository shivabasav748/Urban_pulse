import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Ban, Clock, PlusCircle, TimerOff, UserX } from 'lucide-react'
import { StatusChip } from '@/components/ride/bits'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PLACES } from '@/lib/places'
import { rpc, supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { fmtTime, routeLabel, useEvents, useGroups, useOffers, type Ev } from './data'

const EXC = new Set(['offer_rejected', 'offer_no_response', 'driver_cancelled', 'arrival_delayed'])
const KINDS = [
  { kind: 'reject', label: 'Captain rejects', icon: Ban, when: ['offered'] },
  { kind: 'no_response', label: 'Captain times out', icon: TimerOff, when: ['offered'] },
  { kind: 'driver_cancel', label: 'Captain cancels', icon: UserX, when: ['accepted', 'arriving'] },
  { kind: 'delay', label: 'Arrival delayed', icon: Clock, when: ['arriving'] },
] as const

/** Recovery = exception event -> next offer_accepted on the same group (from the append-only log). */
export function recoveries(events: Ev[]) {
  const asc = [...events].sort((a, b) => a.id - b.id)
  return asc.filter((e) => EXC.has(e.type)).map((e) => {
    const next = asc.find((x) => x.id > e.id && x.type === 'offer_accepted')
    const gaveUp = asc.find((x) => x.id > e.id && x.type === 'no_driver_found')
    return { at: e.at, type: e.type, excluded: (e.payload.driver_id as string) ?? null,
      seconds: next && (!gaveUp || next.id < gaveUp.id) ? (new Date(next.at).getTime() - new Date(e.at).getTime()) / 1000 : null,
      outcome: next && (!gaveUp || next.id < gaveUp.id) ? 'recovered' : gaveUp ? 'no_driver_found' : 'pending' }
  })
}

export default function ChaosTab() {
  const qc = useQueryClient()
  const groups = useGroups()
  const active = groups.data?.filter((g) => ['requested', 'offered', 'accepted', 'arriving', 'ongoing'].includes(g.status)) ?? []
  const [gid, setGid] = useState<string>()
  const sel = active.find((g) => g.id === gid) ?? active[0]
  const events = useEvents(sel?.id)
  const offers = useOffers(sel?.id)
  const riders = useQuery({ queryKey: ['riders'], queryFn: async () => (await supabase.from('profiles').select('id, display_name').eq('role', 'rider').order('display_name')).data ?? [] })

  const create = useMutation({
    mutationFn: async () => {
      const r = riders.data?.[Math.floor(Math.random() * (riders.data?.length || 1))]
      if (!r) throw new Error('No seeded riders')
      const [a, b] = [PLACES[0], PLACES[5]] // Forum Mall -> MG Road Metro: several cabs nearby
      return rpc<string>('demo_request', { p_rider: r.id, p_pickup_label: a.name, p_lat: a.lat, p_lng: a.lng, p_drop_label: b.name, d_lat: b.lat, d_lng: b.lng, p_category: 'cab', p_dispatch: true })
    },
    onSuccess: () => { setGid(undefined); qc.invalidateQueries(); toast.success('Demo ride created and dispatched') },
    onError: (e) => toast.error(e.message),
  })
  const inject = useMutation({
    mutationFn: (kind: string) => rpc<{ next_offer: { attempt_no: number } | null; status: string }>('chaos_inject', { p_group: sel!.id, p_kind: kind }),
    onSuccess: (r) => { qc.invalidateQueries(); toast(r.next_offer ? `Reassigned: attempt ${r.next_offer.attempt_no}` : `Status: ${r.status}`) },
    onError: (e) => toast.error(e.message),
  })
  const rec = recoveries(events.data ?? [])
  const nameOf = (id?: string | null) => offers.data?.find((o) => o.driver_id === id)?.components.chosen.name ?? id?.slice(0, 6) ?? '?'

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Live rides</CardTitle>
          <CardDescription>Exceptions run the same reassignment code as real events.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button className="w-full" variant="outline" disabled={create.isPending} onClick={() => create.mutate()}><PlusCircle className="size-4" aria-hidden />Create demo ride (cab)</Button>
          {!active.length && <p className="text-sm text-muted-foreground">No live rides.</p>}
          {active.map((g) => (
            <button key={g.id} onClick={() => setGid(g.id)} className={cn('flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted', sel?.id === g.id && 'bg-primary/10')}>
              <span className="min-w-0 truncate">{routeLabel(g)}</span><StatusChip status={g.status} />
            </button>
          ))}
        </CardContent>
      </Card>
      {sel ? (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">{routeLabel(sel)} <StatusChip status={sel.status} /><span className="text-sm font-normal text-muted-foreground">attempt {sel.attempt_no}</span></CardTitle>
              <CardDescription>Current captain: {sel.status === 'offered' ? `${nameOf(offers.data?.find((o) => o.outcome === 'pending')?.driver_id)} (offer pending)` : sel.driver_id ? nameOf(sel.driver_id) : 'none'}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {KINDS.map(({ kind, label, icon: Icon, when }) => (
                <Button key={kind} variant="outline" className="h-auto flex-col gap-1 py-3" disabled={inject.isPending || !(when as readonly string[]).includes(sel.status)}
                  onClick={() => inject.mutate(kind)} title={`Enabled when ride is ${when.join(' or ')}`}>
                  <Icon className="size-5" aria-hidden />{label}
                </Button>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Failure → recovery chain</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {rec.length ? rec.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{fmtTime(r.at)}</span>
                  <b>{r.type.replace('_', ' ')}</b><span>excluded {nameOf(r.excluded)}</span>
                  <span className={cn('ml-auto rounded px-2 py-0.5 text-xs font-medium', r.outcome === 'recovered' ? 'bg-emerald-50 text-emerald-800' : r.outcome === 'pending' ? 'bg-sky-50 text-sky-800' : 'bg-red-50 text-red-800')}>
                    {r.outcome === 'recovered' ? `recovered in ${r.seconds!.toFixed(1)}s` : r.outcome === 'pending' ? 'waiting for next captain…' : 'no driver found'}
                  </span>
                </div>
              )) : <p className="text-sm text-muted-foreground">No exceptions on this ride yet. Inject one above.</p>}
              <ol className="space-y-1 border-t pt-3 font-mono text-xs">
                {[...(events.data ?? [])].sort((a, b) => a.id - b.id).map((e) => (
                  <li key={e.id} className={cn(EXC.has(e.type) && 'text-red-700')}>
                    {fmtTime(e.at)} {e.type}{e.to_status ? ` → ${e.to_status}` : ''}{e.payload.attempt ? ` (attempt ${e.payload.attempt}${e.payload.driver ? `, ${e.payload.driver}` : ''})` : ''}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      ) : <p className="text-sm text-muted-foreground">Create a demo ride to start.</p>}
    </div>
  )
}
