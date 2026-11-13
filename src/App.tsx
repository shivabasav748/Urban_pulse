import { lazy, Suspense, type ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { AuthProvider, homeFor, useAuth, type Role } from '@/lib/auth'
import LoginPage from '@/pages/auth/LoginPage'

const RiderPage = lazy(() => import('@/pages/rider/RiderPage'))
const DriverPage = lazy(() => import('@/pages/driver/DriverPage'))
const JudgePage = lazy(() => import('@/pages/judge/JudgePage'))
const ArenaPage = lazy(() => import('@/pages/judge/ArenaPage'))

// Realtime pushes invalidate queries; the 5s poll is a fallback if a push is missed (venue Wi-Fi).
const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 2000, refetchInterval: 5000, refetchOnWindowFocus: false, retry: 1 } } })

const Spinner = () => <div className="grid h-dvh place-items-center" role="status"><Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading" /></div>

function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { session, profile, loading } = useAuth()
  if (loading) return <Spinner />
  if (!session || !profile) return <Navigate to="/login" replace />
  if (profile.role !== role) return <Navigate to={homeFor(profile.role)} replace />
  return <Suspense fallback={<Spinner />}>{children}</Suspense>
}

function Home() {
  const { session, profile, loading } = useAuth()
  if (loading) return <Spinner />
  return <Navigate to={session && profile ? homeFor(profile.role) : '/login'} replace />
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <HashRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/rider" element={<RequireRole role="rider"><RiderPage /></RequireRole>} />
            <Route path="/driver" element={<RequireRole role="driver"><DriverPage /></RequireRole>} />
            <Route path="/judge" element={<RequireRole role="admin"><JudgePage /></RequireRole>} />
            <Route path="/judge/arena" element={<RequireRole role="admin"><ArenaPage /></RequireRole>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </HashRouter>
        <Toaster position="top-center" />
      </AuthProvider>
    </QueryClientProvider>
  )
}
