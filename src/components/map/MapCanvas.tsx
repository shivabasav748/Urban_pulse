import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { Circle, CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { useEffect } from 'react'
import { BLR_CENTER } from '@/lib/places'

export type MapDriver = { id: string; lat: number; lng: number; label: string; category: string; busy?: boolean; highlight?: boolean }
export type MapZone = { id: number; name: string; lat: number; lng: number; risk?: 'low' | 'medium' | 'high'; note?: string }
export type MapPin = { lat: number; lng: number; kind: 'pickup' | 'drop' | 'stop'; label: string; text?: string }

const CAT_COLOR: Record<string, string> = { bike: '#d97706', auto: '#7c3aed', cab: '#0f766e' }
const RISK_COLOR = { low: '#16a34a', medium: '#d97706', high: '#dc2626' }

const pinIcon = (p: MapPin) => L.divIcon({
  className: '',
  html: `<div class="up-pin" style="width:26px;height:26px;background:${p.kind === 'drop' ? '#111827' : p.kind === 'pickup' ? '#0f766e' : '#2563eb'}">${p.text ?? (p.kind === 'pickup' ? 'A' : p.kind === 'drop' ? 'B' : '')}</div>`,
  iconSize: [26, 26], iconAnchor: [13, 13],
})

function FitTo({ points }: { points: [number, number][] }) {
  const map = useMap()
  const sig = JSON.stringify(points)
  useEffect(() => {
    if (points.length >= 2) map.fitBounds(L.latLngBounds(points), { padding: [60, 60], maxZoom: 15 })
    else if (points.length === 1) map.setView(points[0], 14)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  return null
}

function ClickPicker({ onPick }: { onPick?: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick?.(e.latlng.lat, e.latlng.lng) })
  return null
}

export function MapCanvas({ drivers = [], zones = [], pins = [], route, fit, onPick, className }: {
  drivers?: MapDriver[]; zones?: MapZone[]; pins?: MapPin[]; route?: [number, number][]
  fit?: [number, number][]; onPick?: (lat: number, lng: number) => void; className?: string
}) {
  return (
    <MapContainer center={BLR_CENTER} zoom={12} className={className ?? 'h-full w-full'} zoomControl={false}
      attributionControl aria-label="Map of Bengaluru demo area">
      <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' />
      {zones.map((z) => (
        <Circle key={z.id} center={[z.lat, z.lng]} radius={1500}
          pathOptions={{ color: z.risk ? RISK_COLOR[z.risk] : '#64748b', weight: 1, fillOpacity: z.risk === 'high' ? 0.22 : 0.1 }}>
          <Tooltip>{z.name}{z.note ? ` · ${z.note}` : ''}</Tooltip>
        </Circle>
      ))}
      {route && <Polyline positions={route} pathOptions={{ color: '#0f766e', weight: 4, dashArray: '8 6' }} />}
      {drivers.map((d) => (
        <CircleMarker key={d.id} center={[d.lat, d.lng]} radius={d.highlight ? 9 : 6}
          pathOptions={{ color: 'white', weight: 2, fillColor: d.busy ? '#94a3b8' : CAT_COLOR[d.category] ?? '#0f766e', fillOpacity: 1 }}>
          <Tooltip>{d.label} · {d.category}{d.busy ? ' · busy' : ''}</Tooltip>
        </CircleMarker>
      ))}
      {pins.map((p, i) => (
        <Marker key={i} position={[p.lat, p.lng]} icon={pinIcon(p)} title={p.label} alt={p.label}>
          <Tooltip>{p.label}</Tooltip>
        </Marker>
      ))}
      {fit && <FitTo points={fit} />}
      <ClickPicker onPick={onPick} />
    </MapContainer>
  )
}
