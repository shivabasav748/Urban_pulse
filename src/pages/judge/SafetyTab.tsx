import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Empty, LoadError, Tag, friendly } from '@/components/ride/bits'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { rpc, supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { useSettings } from './data'

type Report = { id: string; ride_id: string; category: string; description: string; status: 'open' | 'under_review' | 'resolved' | 'dismissed'
  created_at: string; reviewed_at: string | null; resolution_note: string | null; driver: { display_name: string } | null }
type AuditRow = { id: number; report_id: string; from_status: string | null; to_status: string; note: string | null; at: string }
type Fb = { driver_id: string; overall: number; driver: { display_name: string } | null }
const STATUS_TONE = { open: 'danger', under_review: 'warning', resolved: 'success', dismissed: 'muted' } as const
const CAT = { unsafe_driving: 'Unsafe driving', harassment: 'Harassment', vehicle_condition: 'Vehicle condition', route_deviation: 'Unexpected route', other: 'Other' } as Record<string, string>

export default function SafetyTab() {
  const qc = useQueryClient()
  const settings = useSettings()
  const [notes, setNotes] = useState<Record<string, string>>({})
  const reports = useQuery({
    queryKey: ['j-reports'],
    queryFn: async () => {
      const { data, error } = await supabase.from('safety_reports').select('id, ride_id, category, description, status, created_at, reviewed_at, resolution_note, driver:profiles!safety_reports_driver_id_fkey(display_name)').order('created_at', { ascending: false }).limit(50)
      if (error) throw error
      return data as unknown as Report[]
    },
  })
  const audit = useQuery({ queryKey: ['j-report-audit'], queryFn: async () => ((await supabase.from('safety_report_audit').select('*').order('id', { ascending: false }).limit(200)).data ?? []) as AuditRow[] })
  const fb = useQuery({
    queryKey: ['j-feedback'],
    queryFn: async () => ((await supabase.from('safety_feedback').select('driver_id, overall, driver:profiles!safety_feedback_driver_id_fkey(display_name)')).data ?? []) as unknown as Fb[],
  })
  const optins = useQuery({ queryKey: ['j-optins'], queryFn: async () => ((await supabase.from('captain_preferences').select('women_riders_optin, simulated')).data ?? []) as { women_riders_optin: boolean; simulated: boolean }[] })
  const review = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => rpc('review_safety_report', { p_report: id, p_status: status, p_note: notes[id] || null }),
    onSuccess: () => { toast.success('Review recorded in the audit trail'); qc.invalidateQueries({ queryKey: ['j-reports'] }); qc.invalidateQueries({ queryKey: ['j-report-audit'] }) },
    onError: (e) => toast.error(friendly(e.message)),
  })
  const th = settings.data?.safety_min_feedback ?? 5
  const byDriver = Object.values((fb.data ?? []).reduce<Record<string, { name: string; n: number; sum: number }>>((acc, f) => {
    const a = acc[f.driver_id] ??= { name: f.driver?.display_name ?? f.driver_id.slice(0, 6), n: 0, sum: 0 }
    a.n++; a.sum += f.overall; return acc
  }, {})).sort((a, b) => b.n - a.n)
  const opted = optins.data?.filter((o) => o.women_riders_optin) ?? []

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="lg:col-span-7">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-bold">Safety reports (review queue)</CardTitle>
          <CardDescription className="text-xs">Separate from ratings. Reports never change dispatch or suspend anyone automatically; a reviewer decides. The captain cannot see reports or who filed them.</CardDescription>
        </CardHeader>
        <CardContent>
          {reports.isLoading ? <Skeleton className="h-40" /> : reports.error ? <LoadError what="safety reports" error={reports.error} retry={() => reports.refetch()} />
            : !reports.data?.length ? <Empty>No safety reports. Riders can report a concern from an active or completed trip.</Empty> : (
            <ul className="space-y-3">
              {reports.data.map((r) => {
                const trail = (audit.data ?? []).filter((a) => a.report_id === r.id).reverse()
                const closed = r.status === 'resolved' || r.status === 'dismissed'
                return (
                  <li key={r.id} className="rounded-2xl border bg-surface p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Tag tone={STATUS_TONE[r.status]}>{r.status.replace('_', ' ')}</Tag>
                      <span className="font-semibold">{CAT[r.category] ?? r.category}</span>
                      <span className="text-xs text-slate-500">· captain {r.driver?.display_name ?? 'unknown'} · ride {r.ride_id.slice(0, 6)} · {new Date(r.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-slate-700">{r.description}</p>
                    {trail.length > 0 && (
                      <ol className="mt-2 space-y-0.5 border-l-2 pl-2 text-[11px] text-slate-500">
                        {trail.map((a) => <li key={a.id}>{new Date(a.at).toLocaleTimeString()}: {a.from_status ?? 'new'} → {a.to_status}{a.note && ` · “${a.note}”`}</li>)}
                      </ol>
                    )}
                    {!closed && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} placeholder="Review note (optional)" aria-label="Review note"
                          className="h-9 min-w-0 flex-1 rounded-lg border bg-white px-2 text-xs outline-none focus:border-teal-500" />
                        {r.status === 'open' && <Button size="sm" variant="outline" disabled={review.isPending} onClick={() => review.mutate({ id: r.id, status: 'under_review' })}>Start review</Button>}
                        <Button size="sm" disabled={review.isPending} onClick={() => review.mutate({ id: r.id, status: 'resolved' })}>{review.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}Resolve</Button>
                        <Button size="sm" variant="ghost" disabled={review.isPending} onClick={() => review.mutate({ id: r.id, status: 'dismissed' })}>Dismiss</Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4 lg:col-span-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">Passenger safety feedback</CardTitle>
            <CardDescription className="text-xs">One entry per completed trip, by the rider who took it. A captain's average is shown only from {th} entries; below that, only the count.</CardDescription>
          </CardHeader>
          <CardContent>
            {fb.isLoading ? <Skeleton className="h-24" /> : !byDriver.length ? <Empty>No safety feedback yet. Ratings are never seeded for real accounts.</Empty> : (
              <ul className="divide-y text-sm">
                {byDriver.map((d) => (
                  <li key={d.name} className="flex items-center justify-between py-2">
                    <span className="font-semibold">{d.name}</span>
                    <span className={cn('font-mono text-xs num', d.n >= th ? 'font-bold' : 'text-slate-500')}>{d.n >= th ? `${(d.sum / d.n).toFixed(1)} / 5 from ${d.n}` : `${d.n} of ${th} needed`}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">Women-driver preference supply</CardTitle>
            <CardDescription className="text-xs">Counts only. Opt-ins are restricted personal information: captains manage their own; riders never see them.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2 text-center">
            <div className="rounded-xl border bg-surface p-2"><div className="font-mono text-xl font-bold num">{opted.filter((o) => !o.simulated).length}</div><div className="text-[11px] text-slate-500">self-declared captains</div></div>
            <div className="rounded-xl border bg-surface p-2"><div className="font-mono text-xl font-bold num">{opted.filter((o) => o.simulated).length}</div><div className="text-[11px] text-slate-500">simulated demo flags</div></div>
            <p className="col-span-2 text-left text-[11px] text-slate-500">Self-declared, not identity-verified. A production launch needs a verification process and legal review (see docs/WOMEN_DRIVER_PREFERENCE_AND_SAFETY.md).</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
