import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { AttributionControl, Circle, CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, ZoomControl, useMap, useMapEvents } from 'react-leaflet'
import { useEffect, useState } from 'react'
import { MapPinOff, Route } from 'lucide-react'
import { BLR_CENTER } from '@/lib/places'
import { cn } from '@/lib/utils'

/** approx: privacy-snapped availability marker (a grid cell), not a person's position. n = captains in that cell. */
export type MapDriver = { id: string; lat: number; lng: number; label: string; category: string; busy?: boolean; highlight?: boolean; approx?: boolean; n?: number }
export type MapZone = { id: number; name: string; lat: number; lng: number; risk?: 'low' | 'medium' | 'high'; note?: string }
export type MapPin = { lat: number; lng: number; kind: 'pickup' | 'drop' | 'stop'; label: string; text?: string }

const CAT_COLOR: Record<string, string> = { bike: '#b45309', auto: '#6d28d9', cab: '#0f766e' }
const RISK_COLOR = { low: '#15803d', medium: '#b45309', high: '#b91c1c' }
const PIN_BG = { pickup: '#0f766e', drop: '#18181b', stop: '#1d4ed8' }

const pinIcon = (p: MapPin) => L.divIcon({
  className: '',
  html: `<div class="up-pin" style="width:28px;height:28px;background:${PIN_BG[p.kind]}">${p.text ?? (p.kind === 'pickup' ? 'A' : p.kind === 'drop' ? 'B' : '')}</div>`,
  iconSize: [28, 28], iconAnchor: [14, 14],
})

/** Fit to points, leaving room for whatever panel covers the map (bottom sheet on phones, left card on desktop). */
function FitTo({ points, panel }: { points: [number, number][]; panel: boolean }) {
  const map = useMap()
  const sig = JSON.stringify(points)
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

export function MapCanvas({ drivers = [], zones = [], pins = [], route, routeLabel = 'Estimated route', fit, onPick, panel = false, className }: {
  drivers?: MapDriver[]; zones?: MapZone[]; pins?: MapPin[]; route?: [number, number][]; routeLabel?: string
  fit?: [number, number][]; onPick?: (lat: number, lng: number) => void
  /** true when a floating panel/sheet covers part of the map (MapShell) */
  panel?: boolean; className?: string
}) {
  const [tilesDown, setTilesDown] = useState(false)
  return (
    <div className={cn('relative isolate', panel && 'up-map-panel', className ?? 'h-full w-full')}>
      <MapContainer center={BLR_CENTER} zoom={12} className="h-full w-full" zoomControl={false} attributionControl={false}
        aria-label="Map of the Bengaluru demo area">
        <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19}
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          eventHandlers={{ tileerror: () => setTilesDown(true), tileload: () => setTilesDown(false) }} />
        <AttributionControl position={panel ? 'topright' : 'bottomright'} prefix={false} />
        <ZoomControl position="bottomright" />
        {zones.map((z) => (
          <Circle key={z.id} center={[z.lat, z.lng]} radius={1500}
            pathOptions={{ color: z.risk ? RISK_COLOR[z.risk] : '#64748b', weight: 1.5, fillOpacity: z.risk === 'high' ? 0.24 : 0.12 }}>
            <Tooltip>{z.name}{z.note ? ` · ${z.note}` : ''}</Tooltip>
          </Circle>
        ))}
        {route && <Polyline positions={route} pathOptions={{ color: '#0f766e', weight: 4, opacity: 0.9, dashArray: '2 8', lineCap: 'round' }} />}
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
        {fit && <FitTo points={fit} panel={panel} />}
        <ClickPicker onPick={onPick} />
      </MapContainer>
      {(route || tilesDown) && (
        <div className={cn('pointer-events-none absolute z-[500] flex flex-col items-start gap-1.5',
          panel ? 'top-[calc(env(safe-area-inset-top)+86px)] left-3 md:top-auto md:bottom-4 md:left-[432px]' : 'top-3 left-3')}>
          {route && <MapChip><Route className="size-3.5" aria-hidden />{routeLabel}<span className="hidden xl:inline"> · straight-line, not road</span></MapChip>}
          {tilesDown && <MapChip><MapPinOff className="size-3.5" aria-hidden />Map tiles unavailable · positions still shown</MapChip>}
        </div>
      )}
    </div>
  )
}

const MapChip = ({ children }: { children: React.ReactNode }) => (
  <span className="flex items-center gap-1.5 rounded-full bg-background/95 px-2.5 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-foreground/10">{children}</span>
)
