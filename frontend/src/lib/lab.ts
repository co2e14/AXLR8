// Physical arrangement of the lab: one station per device unit, standing on either side of a
// linear cobot rail. Distances are in metres. Footprints are approximate (from vendor brochures
// where known) and only matter for drawing and for where the pick points fall along the rail.
import { unitsInPhase, type Device, type Layout, type Placement, type Workflow } from './types'

export interface Footprint {
  w: number // along the rail
  d: number // away from the rail
  h: number
  floor: boolean // floor-standing (else it sits on a bench)
}

export const BENCH_H = 0.9 // bench top
export const NEST_H = 0.95 // height of every pick point (plate nest / access hatch)
export const NEST_OFFSET = 0.45 // nest centre from the rail centre line, within the arm's 0.588 m reach
export const RAIL_MARGIN = 0.6 // rail beyond the first and last station
const GAP = 0.15 // between neighbouring stations on one side

const FOOTPRINTS: Record<string, Footprint> = {
  map_reagents: { w: 0.45, d: 0.4, h: 0.35, floor: false },
  map_plates: { w: 0.45, d: 0.4, h: 0.35, floor: false },
  map_pucks: { w: 0.45, d: 0.4, h: 0.35, floor: false },
  map_protein: { w: 0.45, d: 0.4, h: 0.35, floor: false },
  dfsa: { w: 1.0, d: 1.0, h: 1.9, floor: true },
  xl200_thaw: { w: 0.5, d: 0.5, h: 0.45, floor: false },
  xl200: { w: 1.4, d: 0.8, h: 0.9, floor: false },
  centrifuge: { w: 0.5, d: 0.6, h: 0.45, floor: false },
  peeler: { w: 0.3, d: 0.5, h: 0.4, floor: false },
  plateloc: { w: 0.35, d: 0.55, h: 0.45, floor: false },
  sealer: { w: 0.4, d: 0.55, h: 0.45, floor: false },
  spectroq: { w: 1.2, d: 1.0, h: 1.9, floor: true },
  benchcel: { w: 0.9, d: 0.6, h: 0.8, floor: false },
  labeller: { w: 0.5, d: 0.5, h: 0.45, floor: false },
  dc2sa: { w: 1.2, d: 1.0, h: 1.9, floor: true },
  echo: { w: 1.0, d: 0.75, h: 0.75, floor: false },
  mosquito_lcp: { w: 0.6, d: 0.55, h: 0.55, floor: false },
  mosquito_xtal3: { w: 0.6, d: 0.55, h: 0.55, floor: false },
  xact: { w: 0.8, d: 0.7, h: 0.7, floor: false },
  vitrification: { w: 0.6, d: 0.6, h: 0.6, floor: false },
  puck_storage: { w: 0.8, d: 0.8, h: 1.2, floor: true },
  ln2: { w: 0.6, d: 0.6, h: 0.9, floor: true },
  waste: { w: 0.4, d: 0.5, h: 0.6, floor: true },
}

const BY_KIND: Record<Device['kind'], Footprint> = {
  process: { w: 0.6, d: 0.6, h: 0.5, floor: false },
  storage: { w: 1.0, d: 0.9, h: 1.8, floor: true },
  manual: { w: 0.45, d: 0.4, h: 0.35, floor: false },
  waste: { w: 0.4, d: 0.5, h: 0.6, floor: true },
}

export const footprint = (d: Device): Footprint => FOOTPRINTS[d.id] ?? BY_KIND[d.kind]

// Default order along the rail: crystallisation setup at the start, soaking in the middle,
// harvesting and pins at the far end, so most moves are short.
const DEFAULT_ORDER = [
  'map_reagents', 'map_protein', 'map_plates', 'benchcel', 'labeller', 'ln2', 'dfsa', 'xl200_thaw',
  'xl200', 'mosquito_xtal3', 'mosquito_lcp', 'sealer', 'centrifuge', 'peeler', 'spectroq', 'echo', 'dc2sa',
  'plateloc', 'xact', 'vitrification', 'puck_storage', 'map_pucks', 'waste',
]

export interface Station {
  key: string
  device: Device
  unit: number | null // null = a device with unlimited units, drawn as one station
  phase: number | null // purchase phase of this unit
  name: string
  fp: Footprint
}

export const stationKey = (device: string, unit: number | null) => (unit === null ? device : `${device}:${unit}`)

/** Every station the workflow could have (all units of every phase), in default rail order. */
export function stations(wf: Workflow): Station[] {
  const rank = (d: Device) => {
    const i = DEFAULT_ORDER.indexOf(d.id)
    return i < 0 ? DEFAULT_ORDER.length : i
  }
  const sorted = wf.devices.map((d, i) => [d, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
  const out: Station[] = []
  for (const [d] of sorted) {
    const fp = footprint(d)
    if (d.unit_phases === null) {
      out.push({ key: d.id, device: d, unit: null, phase: null, name: d.name, fp })
      continue
    }
    d.unit_phases.forEach((phase, i) => {
      const unit = i + 1
      const name = d.unit_phases!.length > 1 ? `${d.name} ${unit}` : d.name
      out.push({ key: stationKey(d.id, unit), device: d, unit, phase, name, fp })
    })
  }
  return out
}

export const DEFAULT_PARAMS: Omit<Layout, 'placements'> = {
  rail_speed: 0.8,
  handoff_time: 4,
  min_separation: 0.9,
  return_home: true,
}

/** Packs stations along both sides of the rail, each going to the side that is shorter so far. */
export function autoPlacements(list: Station[]): Placement[] {
  const cursor = { [1]: RAIL_MARGIN, [-1]: RAIL_MARGIN } as Record<-1 | 1, number>
  return list.map((s) => {
    const side: -1 | 1 = cursor[1] <= cursor[-1] ? 1 : -1
    const x = cursor[side] + s.fp.w / 2
    cursor[side] += s.fp.w + GAP
    return { station: s.key, x: round(x), side }
  })
}

const round = (x: number) => Math.round(x * 100) / 100

export interface ResolvedLayout extends Layout {
  stations: Station[]
  at: Map<string, Placement>
  length: number
}

/** The workflow's layout, with any station it does not place yet added after the others. */
export function resolveLayout(wf: Workflow): ResolvedLayout {
  const list = stations(wf)
  const saved = wf.layout ?? null
  const known = new Set(list.map((s) => s.key))
  const placements = (saved?.placements ?? []).filter((p) => known.has(p.station))
  const placed = new Set(placements.map((p) => p.station))
  const missing = list.filter((s) => !placed.has(s.key))
  if (missing.length > 0) {
    const end = placements.length === 0 ? 0 : Math.max(...placements.map((p) => p.x)) + 0.5
    for (const p of autoPlacements(missing)) placements.push({ ...p, x: round(p.x + end) })
  }
  const at = new Map(placements.map((p) => [p.station, p]))
  const length = Math.max(...list.map((s) => (at.get(s.key)?.x ?? 0) + s.fp.w / 2)) + RAIL_MARGIN
  return { ...DEFAULT_PARAMS, ...(saved ?? {}), placements, stations: list, at, length }
}

/** The layout as saved and sent to the engine: every station placed. */
export const toLayout = ({ stations: _s, at: _a, length: _l, ...layout }: ResolvedLayout): Layout => layout

/** Pairs of stations on the same side whose footprints overlap. */
export function overlaps(layout: ResolvedLayout): [Station, Station][] {
  const out: [Station, Station][] = []
  const list = layout.stations
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = layout.at.get(list[i].key)!
      const b = layout.at.get(list[j].key)!
      if (a.side === b.side && Math.abs(a.x - b.x) < (list[i].fp.w + list[j].fp.w) / 2 - 0.01) out.push([list[i], list[j]])
    }
  }
  return out
}

/** Whether a station's unit is bought by `phase`. */
export const inPhase = (s: Station, phase: number) => s.unit === null || (unitsInPhase(s.device, phase) ?? []).includes(s.unit)
