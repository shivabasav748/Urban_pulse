import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { Car, Loader2, Monitor, Shield, Smartphone, User } from 'lucide-react'
import { toast } from 'sonner'
import { Brand, SignOutButton, SimBadge } from '@/components/ride/bits'
import { homeFor, useAuth, type Role } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'

const ROLES: { role: Role; label: string; icon: typeof User; demo: string }[] = [
  { role: 'rider', label: 'Passenger', icon: User, demo: 'rider@demo.up' },
  { role: 'driver', label: 'Captain', icon: Car, demo: 'captain1@demo.up' },
  { role: 'admin', label: 'Judge', icon: Shield, demo: 'admin@demo.up' },
]

/** Design top bar: brand + SIMULATED, role switcher, signed-in user. Role tabs switch seeded demo accounts in dev only;
    in a build they show the signed-in role and nothing else (no fake controls). */
export function TopNav({ children }: { children?: ReactNode }) {
  const { profile, session } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<Role | null>(null)
  const switchTo = async (r: (typeof ROLES)[number]) => {
    if (r.role === profile?.role) return
    setBusy(r.role)
    await supabase.auth.signOut()
    const { error } = await supabase.auth.signInWithPassword({ email: r.demo, password: 'demo1234' })
    setBusy(null)
    if (error) { toast.error(`Couldn't switch to the ${r.label.toLowerCase()} demo: ${error.message}`); navigate('/login'); return }
    navigate(homeFor(r.role))
  }
  const roles = import.meta.env.DEV ? ROLES : ROLES.filter((r) => r.role === profile?.role)
  return (
    <header className="sticky top-0 z-[1100] w-full border-b bg-white/90 pt-[env(safe-area-inset-top)] shadow-xs backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-2 px-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Brand compact />
          <SimBadge className="max-[400px]:hidden" />
        </div>
        <nav aria-label="Switch demo role" className="flex items-center rounded-xl border bg-slate-100 p-1">
          {roles.map((r) => {
            const on = r.role === profile?.role, Icon = r.icon
            return (
              <button key={r.role} type="button" onClick={() => switchTo(r)} aria-current={on ? 'page' : undefined} disabled={!!busy}
                title={on ? `Signed in as ${r.label.toLowerCase()}` : `Switch to the ${r.label.toLowerCase()} demo account`}
                className={cn('flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3.5 sm:text-sm',
                  on ? 'bg-primary text-white shadow-sm' : 'text-slate-600 hover:bg-slate-200/70 hover:text-slate-900')}>
                {busy === r.role ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Icon className="size-3.5" aria-hidden />}
                <span className={cn(!on && 'max-sm:sr-only')}>{r.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="flex items-center gap-2">
          {children}
          <div className="hidden text-right md:block">
            <div className="max-w-40 truncate text-xs font-semibold">{profile?.display_name}</div>
            <div className="max-w-40 truncate font-mono text-[10px] text-slate-500">{session?.user.email}</div>
          </div>
          <SignOutButton />
        </div>
      </div>
    </header>
  )
}

export function Footer() {
  return (
    <footer className="border-t bg-white py-3 text-xs text-slate-500">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-1 px-4 sm:flex-row">
        <span>UrbanPulse · Belagavi demo. Captains, demand and prices are simulated.</span>
        <span className="text-[11px] text-slate-400">Map © OpenStreetMap contributors · straight-line route estimates</span>
      </div>
    </footer>
  )
}

/** Design layout for the rider and captain apps: map card on top, options directly below, same column on every width. */
const FRAME_KEY = 'up.phoneFrame'
const readFrame = () => { try { return localStorage.getItem(FRAME_KEY) === '1' } catch { return false } }

/** Desktop helper: preview the rider/captain app inside a phone shell, or use the normal responsive column. */
function ViewToggle({ phone, onChange }: { phone: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="mx-auto hidden w-full max-w-xl items-center justify-between gap-3 px-4 pt-3 text-xs text-slate-500 sm:flex">
      <span>View: <b className="font-semibold text-teal-800">{phone ? 'Phone preview' : 'Responsive'}</b></span>
      <div role="radiogroup" aria-label="Preview size" className="flex rounded-xl border bg-white p-0.5 shadow-xs">
        {([[false, 'Responsive', Monitor], [true, 'Phone', Smartphone]] as const).map(([v, label, Icon]) => (
          <button key={label} type="button" role="radio" aria-checked={phone === v} onClick={() => onChange(v)}
            className={cn('flex h-8 items-center gap-1.5 rounded-lg px-2.5 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring',
              phone === v ? 'bg-primary text-white' : 'text-slate-600 hover:bg-slate-100')}>
            <Icon className="size-3.5" aria-hidden />{label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function MapFirstLayout({ map, mapLabel, children, footer }: { map: ReactNode; mapLabel: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const [phone, setPhoneRaw] = useState(readFrame)
  const setPhone = (v: boolean) => { setPhoneRaw(v); try { localStorage.setItem(FRAME_KEY, v ? '1' : '0') } catch { /* private mode */ } }
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <TopNav />
      <ViewToggle phone={phone} onChange={setPhone} />
      <main className={cn('mx-auto flex w-full flex-1 flex-col gap-3 px-2 pt-3 pb-4 sm:px-4',
        phone ? 'sm:my-3 sm:max-h-[860px] sm:max-w-[420px] sm:flex-none sm:overflow-y-auto sm:rounded-[2.75rem] sm:border-[10px] sm:border-slate-800 sm:bg-background sm:px-3 sm:shadow-2xl' : 'max-w-xl')}>
        <div className="relative isolate h-[300px] shrink-0 overflow-hidden rounded-2xl border bg-slate-200 shadow-sm sm:h-[380px] sm:rounded-3xl">
          {map}
          <div className="pointer-events-none absolute top-2.5 left-2.5 z-[500] flex items-center gap-1.5 rounded-full border bg-white/90 px-2.5 py-1 text-[11px] font-semibold text-slate-700 shadow-xs backdrop-blur">
            {mapLabel}
          </div>
        </div>
        {children}
      </main>
      {footer}
      <Footer />
    </div>
  )
}

/** Primary action bar: sits at the end of the panel, pinned to the bottom edge on phones so it stays in thumb reach. */
export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-[800] -mx-4 mt-4 border-t bg-white/95 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),12px)] backdrop-blur sm:-mx-5 sm:px-5 sm:static sm:bg-transparent sm:pb-0 sm:backdrop-blur-none">
      {children}
    </div>
  )
}
