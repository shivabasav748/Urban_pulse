import { useQuery } from '@tanstack/react-query'
import { supabase, type RideStatus } from '@/lib/supabase'

export type Stop = { ride_id: string; type: 'pickup' | 'drop'; label: string; lat: number; lng: number }
export type Group = { id: string; driver_id: string | null; status: RideStatus; is_pool: boolean; category: string; stops: Stop[]; attempt_no: number; created_at: string }
export type RankRow = { driver_id: string; name: string; pickup_km: number; pickup_min: number; trips_today: number; idle_min: number; c_eta: number; c_workload: number; c_reliability: number; c_idle: number; score: number }
export type Offer = { id: string; group_id: string; driver_id: string; attempt_no: number; score: number; outcome: string; offered_at: string; responded_at: string | null; components: { chosen: RankRow; ranking: RankRow[]; weights: Record<string, number> } }
export type Ev = { id: number; group_id: string; ride_id: string; type: string; from_status: string | null; to_status: string | null; payload: Record<string, unknown>; at: string }
export type Settings = { w_eta: number; w_workload: number; w_reliability: number; w_idle: number; offer_timeout_s: number; fast_demo: boolean; auto_accept_s: number; surge_cap: number; sim_clock: string }
export type Driver = { user_id: string; lat: number; lng: number; online: boolean; vehicle_category: string; is_simulated: boolean; trips_today: number; profiles: { display_name: string } }

const q = async <T,>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>) => {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data as T
}

export const useGroups = () => useQuery({
  queryKey: ['j-groups'],
  queryFn: () => q<Group[]>(supabase.from('trip_groups').select('*').order('created_at', { ascending: false }).limit(40)),
})
export const useOffers = (groupId?: string) => useQuery({
  queryKey: ['j-offers', groupId], enabled: !!groupId,
  queryFn: () => q<Offer[]>(supabase.from('ride_offers').select('*').eq('group_id', groupId!).order('attempt_no')),
})
export const useEvents = (groupId?: string) => useQuery({
  queryKey: ['j-events', groupId ?? 'all'],
  queryFn: () => {
    let s = supabase.from('ride_events').select('*').order('id', { ascending: false }).limit(groupId ? 100 : 30)
    if (groupId) s = s.eq('group_id', groupId)
    return q<Ev[]>(s)
  },
})
export const useSettings = () => useQuery({ queryKey: ['j-settings'], queryFn: () => q<Settings>(supabase.from('settings').select('*').single()) })
export const useDrivers = () => useQuery({
  queryKey: ['j-drivers'],
  queryFn: () => q<Driver[]>(supabase.from('driver_profiles').select('user_id, lat, lng, online, vehicle_category, is_simulated, trips_today, profiles(display_name)')),
})
export const useActiveGroupIds = () => useQuery({
  queryKey: ['j-busy'],
  queryFn: async () => new Set((await q<{ driver_id: string }[]>(supabase.from('trip_groups').select('driver_id').in('status', ['accepted', 'arriving', 'ongoing']))).map((g) => g.driver_id)),
})

export const shortId = (id: string) => id.slice(0, 6)
export const fmtTime = (t: string) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
export const routeLabel = (g: Group) => `${g.stops[0]?.label ?? '?'} → ${g.stops[g.stops.length - 1]?.label ?? '?'}`
