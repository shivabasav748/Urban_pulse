import L from 'leaflet'
import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import { along, fractionOf, type LL } from '@/lib/road'

// Top-down vehicle drawn in SVG with a soft ground shadow, so it reads as a 3D-ish model (like delivery/ride apps)
// and turns with the road. Colours follow the category colours used elsewhere on the map.
const BODY: Record<string, [string, string]> = { cab: ['#14b8a6', '#0f766e'], auto: ['#facc15', '#a16207'], bike: ['#fb923c', '#c2410c'] }
const svg = (cat: string) => {
  const [hi, lo] = BODY[cat] ?? BODY.cab
  const g = `<defs><linearGradient id="vb-${cat}" x1="0" x2="1"><stop offset="0" stop-color="${lo}"/><stop offset=".5" stop-color="${hi}"/><stop offset="1" stop-color="${lo}"/></linearGradient></defs>`
  if (cat === 'bike') return `<svg viewBox="0 0 24 48" width="20" height="40">${g}
    <rect x="9" y="1" width="6" height="10" rx="3" fill="#1f2937"/><rect x="9" y="37" width="6" height="10" rx="3" fill="#1f2937"/>
    <rect x="6" y="9" width="12" height="30" rx="6" fill="url(#vb-${cat})"/><circle cx="12" cy="22" r="5" fill="#111827"/><circle cx="11" cy="20.5" r="1.6" fill="#fff" opacity=".5"/>
    <rect x="2" y="12" width="20" height="3" rx="1.5" fill="#374151"/></svg>`
  if (cat === 'auto') return `<svg viewBox="0 0 34 48" width="28" height="40">${g}
    <rect x="13" y="1" width="8" height="6" rx="2" fill="#1f2937"/><rect x="1" y="36" width="6" height="10" rx="2" fill="#1f2937"/><rect x="27" y="36" width="6" height="10" rx="2" fill="#1f2937"/>
    <path d="M17 3 C9 3 5 12 4 20 L4 44 Q4 46 6 46 L28 46 Q30 46 30 44 L30 20 C29 12 25 3 17 3Z" fill="url(#vb-${cat})"/>
    <path d="M8 18 Q17 12 26 18 L26 40 L8 40Z" fill="#15803d"/><path d="M10 13 Q17 8 24 13 L23 17 Q17 13 11 17Z" fill="#0f172a" opacity=".75"/></svg>`
  return `<svg viewBox="0 0 30 56" width="26" height="48">${g}
    <rect x="1" y="9" width="5" height="10" rx="2" fill="#1f2937"/><rect x="24" y="9" width="5" height="10" rx="2" fill="#1f2937"/>
    <rect x="1" y="38" width="5" height="10" rx="2" fill="#1f2937"/><rect x="24" y="38" width="5" height="10" rx="2" fill="#1f2937"/>
    <rect x="3" y="2" width="24" height="52" rx="9" fill="url(#vb-${cat})"/>
    <path d="M7 15 Q15 10 23 15 L22 22 Q15 19 8 22Z" fill="#0f172a" opacity=".8"/><rect x="8" y="23" width="14" height="16" rx="3" fill="${hi}" opacity=".85"/>
    <path d="M8 41 Q15 44 22 41 L23 47 Q15 50 7 47Z" fill="#0f172a" opacity=".7"/>
    <rect x="6" y="3" width="4" height="2" rx="1" fill="#fef9c3"/><rect x="20" y="3" width="4" height="2" rx="1" fill="#fef9c3"/></svg>`
}
const icon = (cat: string, label: string) => L.divIcon({
  className: 'up-veh', iconSize: [56, 56], iconAnchor: [28, 28],
  html: `<div class="up-veh-halo"></div><div class="up-veh-rot" role="img" aria-label="${label.replace(/"/g, '')}">${svg(cat)}</div>`,
})

/**
 * Moves the vehicle along `path`. Timed (start/end in ms): glides from start to end of the path, used for SIMULATED
 * captains whose stage advances on a server clock. Live (`live` position): snaps the real GPS position onto the road
 * and eases towards it. Imperative on purpose: no React re-render per frame.
 */
export function Vehicle({ path, category, label, start, end, live }: { path: LL[]; category: string; label: string; start?: number; end?: number; live?: LL }) {
  const map = useMap()
  const marker = useRef<L.Marker | null>(null)
  const shown = useRef<number | null>(null)
  const target = useRef(0)
  const timing = useRef({ start, end })
  timing.current = { start, end }
  useEffect(() => { if (live && path.length > 1) target.current = fractionOf(path, live) }, [live?.[0], live?.[1], path]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (path.length < 1) return
    const m = L.marker(path[0], { icon: icon(category, label), keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(map)
    marker.current = m
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0, lastHeading = 0
    const tick = () => {
      const { start: s, end: e } = timing.current
      let f = live ? target.current : s != null && e != null && e > s ? (Date.now() - s) / (e - s) : 0
      f = Math.max(0, Math.min(1, f))
      // ease towards the target so snapped GPS jumps glide instead of teleporting
      shown.current = shown.current == null || reduce ? f : shown.current + (f - shown.current) * 0.08
      const { p, heading } = along(path, shown.current)
      m.setLatLng(p)
      if (shown.current < 0.999) lastHeading = heading
      const el = m.getElement()?.querySelector<HTMLElement>('.up-veh-rot')
      if (el) el.style.transform = `rotate(${lastHeading}deg)`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); m.remove(); marker.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, path, category])
  return null
}
