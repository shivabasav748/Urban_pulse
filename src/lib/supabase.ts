import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string
if (!url || !key) throw new Error('Missing VITE_SUPABASE_URL / key: copy .env.example to .env.local')

export const supabase = createClient(url, key)

/** rpc wrapper that throws a readable Error (server raises e.g. "invalid_transition: ..."). */
export async function rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

export type RideStatus = 'requested' | 'offered' | 'accepted' | 'arriving' | 'ongoing' | 'completed' | 'cancelled' | 'no_driver_found'

export type Ride = {
  id: string; rider_id: string; driver_id: string | null; status: RideStatus; attempt_no: number
  pickup_label: string; drop_label: string; pickup_lat: number; pickup_lng: number; drop_lat: number; drop_lng: number
  category: 'bike' | 'auto' | 'cab'; est_distance_km: number; est_trip_min: number; est_pickup_min: number | null
  fare: { base: number; distance: number; time: number; surge_mult: number; total: number; pool_discount?: number }
  surge: number; requested_at: string; accepted_at: string | null; arriving_at: string | null
  started_at: string | null; completed_at: string | null; cancelled_at: string | null
}
