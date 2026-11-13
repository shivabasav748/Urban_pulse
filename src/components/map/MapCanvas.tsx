import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { AttributionControl, Circle, CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, ZoomControl, useMap, useMapEvents } from 'react-leaflet'
import { useEffect, useState } from 'react'
import { MapPinOff, Route } from 'lucide-react'
import { CITY_CENTER, CITY_NAME } from '@/lib/places'
import { cn } from '@/lib/utils'
import { useRoad, type LL } from '@/lib/road'
import { Vehicle } from './Vehicle'

/** approx: privacy-snapped availability marker (a grid cell), not a person's position. n = captains in that cell. */
export type MapDriver = { id: string; lat: number; lng: number; label: string; category: string; busy?: boolean; highlight?: boolean; approx?: boolean; n?: number }
export type MapZone = { id: number; name: string; lat: number; lng: number; risk?: 'low' | 'medium' | 'high'; note?: string; color?: string; strong?: boolean; soft?: boolean }
export type MapPin = { lat: number; lng: number; kind: 'pickup' | 'drop' | 'stop'; label: string; text?: string }

const CAT_COLOR: Record<string, string> = { bike: '#b45309', auto: '#6d28d9', cab: '#0f766e' }
export const ZONE_STATE_COLOR = { undersupplied: '#e11d48', balanced: '#0284c7', oversupplied: '#059669' } as const
const RISK_COLOR = { low: '#15803d', medium: '#b45309', high: '#b91c1c' }
const PIN_BG = { pickup: '#059669', drop: '#e11d48', stop: '#0369a1' }

const pinIcon = (p: MapPin) => L.divIcon({
  className: '',
  html: `<div class="up-pin" style="width:28px;height:28px;background:${PIN_BG[p.kind]}">${p.text ?? (p.kind === 'pickup' ? 'A' : p.kind === 'drop' ? 'B' : '')}</div>`,
  iconSize: [28, 28], iconAnchor: [14, 14],
})

/** Fit to points, leaving room for whatever panel covers the map (bottom sheet on phones, left card on desktop). */
// Refits only when fitKey changes (a new trip stage), never on every position update: refitting each poll made the map jerk.
function FitTo({ points, panel, fitKey }: { points: [number, number][]; panel: boolean; fitKey?: string }) {
  const map = useMap()
  const sig = fitKey ?? JSON.stringify(points.map(([a, b]) => [a.toFixed(3), b.toFixed(3)]))
  useEffect(() => {
    if (!points.length) return
    const phone = window.innerWidth < 768
    const tl: [number, number] = panel ? (phone ? [32, 88] : [456, 48]) : [48, 48]
    const br: [number, number] = panel ? (phone ? [32, Math.round(window.innerHeight * 0.64)] : [48, 48]) : [48, 48]
    if (points.length >= 2) map.fitBounds(L.latLngBounds(points), { paddingTopLeft: tl, paddingBottomRight: br, maxZoom: 15 })
    else map.setView(points[0], 14)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  return null
}

function ClickPicker({ onPick }: { onPick?: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick?.(e.latlng.lat, e.latlng.lng) })
  return null
}

export type MapVehicle = { from: LL; to: LL; category: string; label: string; start?: number; end?: number; live?: LL }

export function MapCanvas({ drivers = [], zones = [], pins = [], route, routeLabel = 'Route', fit, fitKey, vehicle, onPick, panel = false, className, legend }: {
  drivers?: MapDriver[]; zones?: MapZone[]; pins?: MapPin[]; route?: [number, number][]; routeLabel?: string
  fit?: [number, number][]; fitKey?: string
  /** a captain driving along the road from `from` to `to` (approach to pickup, or the trip itself) */
  vehicle?: MapVehicle
  onPick?: (lat: number, lng: number) => void
  /** true when a floating panel/sheet covers part of the map (MapShell) */
  panel?: boolean; className?: string
  /** small key shown on the map, e.g. the traffic colours */
  legend?: React.ReactNode
}) {
  const [tilesDown, setTilesDown] = useState(false)
  const two = route?.length === 2
  const road = useRoad(two ? route![0] : null, two ? route![1] : null)
  const approach = useRoad(vehicle?.from, vehicle?.to)
  const routePath = two ? road.data?.path ?? route : route
  const isRoad = two ? !!road.data?.road : false
  const vPath = approach.data?.path
  return (
    <div className={cn('relative isolate', panel && 'up-map-panel', className ?? 'h-full w-full')}>
      <MapContainer center={CITY_CENTER} zoom={13} className="h-full w-full" zoomControl={false} attributionControl={false}
        aria-label={`Map of the ${CITY_NAME} demo area`}>
        <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19}
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          eventHandlers={{ tileerror: () => setTilesDown(true), tileload: () => setTilesDown(false) }} />
        <AttributionControl position={panel ? 'topright' : 'bottomright'} prefix={false} />
        <ZoomControl position="bottomright" />
        {zones.map((z) => (
          <Circle key={z.id} center={[z.lat, z.lng]} radius={1500}
            pathOptions={{ color: z.color ?? (z.risk ? RISK_COLOR[z.risk] : '#64748b'), weight: z.soft ? 1 : z.strong ? 2.5 : 1.5, opacity: z.soft ? 0.5 : 1,
              fillOpacity: z.soft ? 0.16 : z.strong || z.risk === 'high' ? 0.24 : 0.12 }}>
            <Tooltip>{z.name}{z.note ? ` · ${z.note}` : ''}</Tooltip>
          </Circle>
        ))}
        {routePath && <Polyline key={isRoad ? 'road' : 'line'} positions={routePath} pathOptions={isRoad ? { color: '#0f766e', weight: 5, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }
          : { color: '#0f766e', weight: 4, opacity: 0.9, dashArray: '2 8', lineCap: 'round' }} />}
        {vPath && vehicle && vehicle.to !== route?.[1] && <Polyline positions={vPath} pathOptions={{ color: '#0f172a', weight: 4, opacity: 0.55, lineCap: 'round', lineJoin: 'round' }} />}
        {vPath && vehicle && <Vehicle path={vPath} category={vehicle.category} label={vehicle.label} start={vehicle.start} end={vehicle.end} live={vehicle.live} />}
        {drivers.map((d) => d.approx ? (
          <CircleMarker key={d.id} center={[d.lat, d.lng]} radius={9 + Math.min(d.n ?? 1, 4) * 2}
            pathOptions={{ stroke: false, fillColor: CAT_COLOR[d.category] ?? '#0f766e', fillOpacity: 0.28 }}>
            <Tooltip>About {d.n ?? 1} {d.category}{(d.n ?? 1) > 1 ? 's' : ''} in this area (approximate)</Tooltip>
          </CircleMarker>
        ) : (
          <CircleMarker key={d.id} center={[d.lat, d.lng]} radius={d.highlight ? 9 : 6}
            pathOptions={{ color: 'white', weight: 2, fillColor: d.busy ? '#94a3b8' : CAT_COLOR[d.category] ?? '#0f766e', fillOpacity: 1 }}>
            <Tooltip>{d.label} · {d.category}{d.busy ? ' · on a trip' : ''}</Tooltip>
          </CircleMarker>
        ))}
        {pins.map((p, i) => (
          <Marker key={i} position={[p.lat, p.lng]} icon={pinIcon(p)} title={p.label} alt={p.label} keyboard={false}>
            <Tooltip>{p.label}</Tooltip>
          </Marker>
        ))}
        {fit && <FitTo points={fit} panel={panel} fitKey={fitKey} />}
        <ClickPicker onPick={onPick} />
      </MapContainer>
      {(route || tilesDown || legend) && (
        <div className={cn('pointer-events-none absolute z-[500] flex flex-col items-start gap-1.5',
          panel ? 'top-[calc(env(safe-area-inset-top)+86px)] left-3 md:top-auto md:bottom-4 md:left-[432px]' : 'bottom-2.5 left-2.5')}>
          {route && <MapChip><Route className="size-3.5" aria-hidden />{isRoad ? `${routeLabel} · by road (OSM)` : `${routeLabel} · straight-line estimate`}</MapChip>}
          {legend && <MapChip>{legend}</MapChip>}
          {tilesDown && <MapChip><MapPinOff className="size-3.5" aria-hidden />Map tiles unavailable · positions still shown</MapChip>}
        </div>
      )}
    </div>
  )
}

const MapChip = ({ children }: { children: React.ReactNode }) => (
  <span className="flex items-center gap-1.5 rounded-full border bg-white/95 px-2.5 py-1 text-xs font-medium text-slate-600 shadow-sm">{children}</span>
)

/** Key for the traffic/density circles (see src/lib/traffic.ts). */
export const TrafficLegend = () => (
  <span className="flex items-center gap-2" aria-label="Map colours: red busy, yellow moderate, green quiet">
    {([['#dc2626', 'Busy'], ['#eab308', 'Moderate'], ['#16a34a', 'Quiet']] as const).map(([c, l]) => (
      <span key={l} className="flex items-center gap-1"><span className="size-2 rounded-full" style={{ background: c }} aria-hidden />{l}</span>
    ))}
  </span>
)
