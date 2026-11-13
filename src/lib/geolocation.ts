import { useCallback, useEffect, useRef, useState } from 'react'

export type Fix = { lat: number; lng: number; accuracy: number; at: number }
export type GeoStatus = 'idle' | 'locating' | 'ok' | 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'insecure'

export const GOOD_ACCURACY_M = 100 // same threshold the server uses for dispatch eligibility
export const STALE_MS = 2 * 60_000

const toStatus = (e: GeolocationPositionError): GeoStatus =>
  e.code === e.PERMISSION_DENIED ? 'denied' : e.code === e.TIMEOUT ? 'timeout' : 'unavailable'
const toFix = (p: GeolocationPosition): Fix => ({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), at: p.timestamp })

function precheck(): GeoStatus | null {
  if (!('geolocation' in navigator)) return 'unsupported'
  if (!window.isSecureContext) return 'insecure' // browsers only allow geolocation on HTTPS or localhost
  return null
}

/** One-shot location, only when the user asks for it (never on page load). */
export function useCurrentPosition() {
  const [status, setStatus] = useState<GeoStatus>('idle')
  const [fix, setFix] = useState<Fix | null>(null)
  const request = useCallback(() => new Promise<Fix | null>((resolve) => {
    const bad = precheck()
    if (bad) { setStatus(bad); resolve(null); return }
    setStatus('locating')
    navigator.geolocation.getCurrentPosition(
      (p) => { const f = toFix(p); setFix(f); setStatus('ok'); resolve(f) },
      (e) => { setStatus(toStatus(e)); resolve(null) },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    )
  }), [])
  return { status, fix, request }
}

/**
 * Continuous tracking while `active`. Calls `onFix` at most every `minIntervalMs`, or sooner if the device moved
 * more than `minMoveM`. Stops (clearWatch) the moment `active` turns false or the component unmounts.
 */
export function useWatchPosition(active: boolean, onFix: (f: Fix) => void, minIntervalMs = 10_000, minMoveM = 30) {
  const [status, setStatus] = useState<GeoStatus>('idle')
  const [last, setLast] = useState<Fix | null>(null)
  const sent = useRef<Fix | null>(null)
  const cb = useRef(onFix)
  cb.current = onFix
  useEffect(() => {
    if (!active) { setStatus('idle'); return }
    const bad = precheck()
    if (bad) { setStatus(bad); return }
    setStatus('locating')
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const f = toFix(p); setLast(f); setStatus('ok')
        const prev = sent.current
        const moved = prev ? Math.hypot((f.lat - prev.lat) * 111_000, (f.lng - prev.lng) * 111_000 * Math.cos((f.lat * Math.PI) / 180)) : Infinity
        if (!prev || f.at - prev.at >= minIntervalMs || moved >= minMoveM) { sent.current = f; cb.current(f) }
      },
      (e) => setStatus(toStatus(e)),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 5_000 },
    )
    return () => { navigator.geolocation.clearWatch(id); sent.current = null }
  }, [active, minIntervalMs, minMoveM])
  return { status, last }
}

export const GEO_MESSAGE: Record<GeoStatus, string> = {
  idle: '', locating: 'Finding your location…', ok: '',
  denied: 'Location permission is off. Allow it in your browser settings, or choose a place below.',
  unavailable: "Your device couldn't get a location fix. Try again, or choose a place below.",
  timeout: 'Getting a location took too long. Try again, or choose a place below.',
  unsupported: "This browser doesn't support location. Choose a place below.",
  insecure: 'Location needs a secure (HTTPS) connection. Choose a place below.',
}
