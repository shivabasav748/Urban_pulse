import { useEffect, useState, type ReactNode } from 'react'
import { Bike, Car, CarTaxiFront, Check, CircleAlert, LogOut, WifiOff } from 'lucide-react'
import { Link } from 'react-router'
import type { Ride, RideStatus } from '@/lib/supabase'
import { inr } from '@/lib/geo'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export const CAT_ICON = { bike: Bike, auto: CarTaxiFront, cab: Car } as const
export const CAT_LABEL = { bike: 'Bike', auto: 'Auto', cab: 'Cab' } as const

/** Outlined amber SIMULATED tag (design system). Text, not colour alone, carries the meaning. */
export function SimBadge({ className, label = 'Simulated' }: { className?: string; label?: string }) {
  return (
    <span title="Captains, demand, weather, routes and surge are simulated for this prototype"
      className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded border border-amber-300 bg-amber-50 px-1.5 font-mono text-[10px] font-semibold tracking-wider text-amber-800 uppercase', className)}>
      <span aria-hidden className="size-1.5 rounded-full bg-amber-500 motion-safe:animate-pulse" />{label}
    </span>
  )
}

const STATUS_TEXT: Record<RideStatus, string> = {
  requested: 'Finding your captain', offered: 'Waiting for acceptance', accepted: 'Booking confirmed',
  arriving: 'Your captain is on the way', ongoing: 'On trip', completed: 'Trip completed', cancelled: 'Cancelled',
  no_driver_found: 'No captain found',
}
export const STATUS_SHORT: Record<RideStatus, string> = {
  requested: 'Matching', offered: 'Offered', accepted: 'Assigned', arriving: 'Arriving', ongoing: 'On trip',
  completed: 'Completed', cancelled: 'Cancelled', no_driver_found: 'No captain',
}
export const TONE = {
  info: 'border-sky-200 bg-sky-50 text-sky-800', brand: 'border-teal-200 bg-teal-50 text-teal-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800', muted: 'border-slate-200 bg-slate-50 text-slate-600',
  danger: 'border-rose-200 bg-rose-50 text-rose-800', warning: 'border-amber-200 bg-amber-50 text-amber-800',
} as const
const STATUS_TONE: Record<RideStatus, keyof typeof TONE> = {
  requested: 'info', offered: 'info', accepted: 'brand', arriving: 'brand', ongoing: 'brand',
  completed: 'success', cancelled: 'muted', no_driver_found: 'danger',
}
export const statusText = (s: RideStatus) => STATUS_TEXT[s]

/** Small rounded tag used for statuses, zone states and risk levels. */
export function Tag({ tone = 'muted', children, className }: { tone?: keyof typeof TONE; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-semibold whitespace-nowrap', TONE[tone], className)}>{children}</span>
}

export function StatusChip({ status, short }: { status: RideStatus; short?: boolean }) {
  return <Tag tone={STATUS_TONE[status]}>{short ? STATUS_SHORT[status] : STATUS_TEXT[status]}</Tag>
}

const STEPS: { key: RideStatus; label: string }[] = [
  { key: 'requested', label: 'Matching' }, { key: 'accepted', label: 'Assigned' },
  { key: 'arriving', label: 'Arriving' }, { key: 'ongoing', label: 'On trip' }, { key: 'completed', label: 'Arrived' },
]
const ORDER: Record<string, number> = { requested: 0, offered: 0, accepted: 1, arriving: 2, ongoing: 3, completed: 4 }

/** Design stepper: connected circles, done = filled teal with a tick, current = ringed. */
export function StatusStepper({ status }: { status: RideStatus }) {
  const at = ORDER[status] ?? -1
  return (
    <ol className="relative grid grid-cols-5" aria-label={`Ride status: ${STATUS_TEXT[status]}`}>
      <span aria-hidden className="absolute top-3 right-[10%] left-[10%] h-0.5 bg-slate-200" />
      <span aria-hidden className="absolute top-3 left-[10%] h-0.5 bg-primary motion-safe:transition-[width] motion-safe:duration-500" style={{ width: `${Math.max(at, 0) * 20}%` }} />
      {STEPS.map((s, i) => {
        const done = i < at || (i === at && at === 4), cur = i === at && at < 4
        return (
          <li key={s.key} aria-current={cur ? 'step' : undefined} className="relative flex flex-col items-center gap-1.5">
            <span aria-hidden className={cn('grid size-6 place-items-center rounded-full border text-white',
              done ? 'border-primary bg-primary' : cur ? 'border-primary bg-primary ring-4 ring-primary/20' : 'border-slate-300 bg-white')}>
              {done && <Check className="size-3.5" strokeWidth={3} />}
            </span>
            <span className={cn('text-[11px]', cur ? 'font-bold text-teal-800' : i < at ? 'font-medium text-slate-700' : 'text-slate-500')}>{s.label}</span>
          </li>
        )
      })}
    </ol>
  )
}

const TARIFF_NOTE: Record<string, string> = {
  'karnataka-aggregator-cab-band1-2024': 'Karnataka app-cab tariff, vehicles up to ₹10 lakh (state order of Feb 2024, as reported). Tolls extra.',
  'illustrative-not-notified': 'Illustrative demo tariff: the Belagavi auto tariff could not be verified.',
  'illustrative-simulated-service': 'Illustrative demo tariff for a simulated service: bike taxis need RTA permits in Karnataka.',
}

export function FareBreakdown({ fare }: { fare: Ride['fare'] }) {
  const rows: [string, string][] = [
    [fare.included_km ? `Minimum fare (first ${fare.included_km} km)` : 'Base fare', inr(fare.base)],
    [fare.per_km ? `Distance (₹${fare.per_km}/km after that)` : 'Distance', inr(fare.distance)],
  ]
  if (fare.per_min && Number(fare.time)) rows.push([`Time (₹${fare.per_min}/min)`, inr(fare.time)]) // older bookings only
  if (Number(fare.night)) rows.push(['Night charge (00:00–06:00, 10%)', inr(fare.night!)])
  if (Number(fare.surge_mult) !== 1) rows.push(['Surge (simulated, capped at 2×)', `×${Number(fare.surge_mult).toFixed(2)}`])
  if (Number(fare.gst)) rows.push(['GST (5%)', inr(fare.gst!)])
  if (fare.pool_discount) rows.push(['Pool discount', `−${fare.pool_discount * 100}%`])
  return (
    <dl className="space-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4"><dt className="text-slate-500">{k}</dt><dd className="num font-medium">{v}</dd></div>
      ))}
      <div className="flex items-baseline justify-between gap-4 border-t pt-2">
        <dt className="font-semibold">Estimated total</dt><dd className="num text-base font-extrabold">{inr(fare.total)}</dd>
      </div>
      {fare.tariff && TARIFF_NOTE[fare.tariff] && <p className="pt-1 text-[11px] leading-snug text-slate-500">{TARIFF_NOTE[fare.tariff]}</p>}
    </dl>
  )
}

export function Brand({ compact }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="UrbanPulse home">
      <span className="grid size-9 place-items-center rounded-lg bg-primary text-base font-black text-white shadow-md shadow-teal-700/20" aria-hidden>UP</span>
      <span className={cn('leading-tight', compact && 'max-sm:sr-only')}>
        <span className="block text-lg font-bold tracking-tight">UrbanPulse</span>
        <span className="hidden text-[11px] text-slate-500 lg:block">Smart rides. Smarter city.</span>
      </span>
    </Link>
  )
}

export function SignOutButton({ className }: { className?: string }) {
  const { signOut } = useAuth()
  return <Button variant="outline" size="icon" className={cn('size-10 rounded-lg', className)} onClick={signOut} aria-label="Sign out" title="Sign out"><LogOut className="size-4" aria-hidden /></Button>
}

/** White card used for every panel (design: rounded, slate border, soft shadow). */
export function Panel({ children, className, as: As = 'section', ...rest }: { children: ReactNode; className?: string; as?: 'section' | 'div'; 'aria-label'?: string; 'aria-labelledby'?: string }) {
  return <As {...rest} className={cn('rounded-3xl border bg-card p-4 shadow-lg shadow-slate-900/5 sm:p-5', className)}>{children}</As>
}

/** Uppercase micro-label used above groups of controls. */
export const Eyebrow = ({ children, className }: { children: ReactNode; className?: string }) => (
  <p className={cn('text-[11px] font-bold tracking-wider text-slate-500 uppercase', className)}>{children}</p>
)

/** One empty-state style for the whole app: says what is missing and what to do next. */
export function Empty({ children, className, icon }: { children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-2xl border border-dashed bg-surface px-4 py-3.5 text-sm text-slate-600', className)}>
      {icon}<div className="min-w-0">{children}</div>
    </div>
  )
}

/** Turns server errors into words a person can act on. Never shows SQL or concurrency internals. */
export function friendly(msg: string): string {
  const m = msg.replace(/^(validation|conflict|invalid_transition):\s*/, '')
  if (/forbidden|permission denied|row-level security/i.test(msg)) return "You don't have access to that."
  if (/deadlock|could not serialize|duplicate key|violates|syntax|relation|function .* does not exist/i.test(msg)) return 'Something went wrong on our side. Please try again.'
  return m.charAt(0).toUpperCase() + m.slice(1)
}

/** Inline query failure with a way to recover. */
export function LoadError({ what, error, retry }: { what: string; error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : (error as { message?: string } | null)?.message ?? String(error)
  const offline = /fetch|network/i.test(msg)
  return (
    <div role="alert" className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">Couldn't load {what}</div>
        <div className="break-words opacity-90">{offline ? 'The server is unreachable. Check the connection and that the local database is running.' : friendly(msg)}</div>
      </div>
      {retry && <Button size="sm" variant="outline" className="shrink-0 bg-white" onClick={retry}>Retry</Button>}
    </div>
  )
}

/** Shown app-wide while the browser reports no network. Realtime and polling resume on their own. */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  if (online) return null
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-[2000] flex items-center justify-center gap-2 bg-slate-900 px-3 pt-[calc(env(safe-area-inset-top)+6px)] pb-1.5 text-sm text-white">
      <WifiOff className="size-4" aria-hidden /> You're offline. Ride updates resume when the connection returns.
    </div>
  )
}
