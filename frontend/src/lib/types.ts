// Mirrors backend/src/axlr8/{model,kpis}.py. All times are in seconds.

export type TimeKind = 'fixed' | 'normal' | 'uniform' | 'triangular'
export type Timing = 'fixed' | 'project' | 'assumed'
export type DeviceKind = 'process' | 'storage' | 'manual' | 'waste'
export type Transport = 'cobot' | 'linked' | 'manual'
export type Scenario = 'run' | 'shutdown'
// A follow-on day is the second of two run days in a row: it starts with day 1's unfinished work.
export type DayType = Scenario | 'follow_on'

export const DAY_LABEL: Record<DayType, string> = { run: 'Run day', follow_on: 'Follow-on day', shutdown: 'Shutdown day' }

/** The routes a day type runs: a follow-on day is a run day. */
export const routeScenario = (d: DayType): Scenario => (d === 'follow_on' ? 'run' : d)

export interface TimeSpec {
  value: number
  kind: TimeKind
  spread: number
}

export interface Device {
  id: string
  name: string
  kind: DeviceKind
  unit_phases: number[] | null // phase each unit arrives in; null = unlimited
  time: TimeSpec
  timing: Timing
  note: string
  capacity: number[] | null // plates each unit stores (incubators); null = does not store plates
  stored_at_start?: number[] | null // plates already inside each unit when the day starts
  imager_units: number[] // units with an imaging add-on
}

export interface Spawn {
  route: string
  count: number
}

export interface Step {
  devices: string[]
  units: number[] | null
  time: TimeSpec | null
  dwell: TimeSpec | null
  timing: Timing | null
  label: string | null
  optional: boolean
  enabled: boolean
  transport: Transport
  join: string | null
  sync: string | null
  spawn: Spawn[]
  image: boolean // the device images the whole plate here (adds the plate imaging time)
  store: boolean // last step only: the plate stays in this unit and is imaged on schedule
}

export interface Imaging {
  wells_per_plate: number
  drops_per_well: number // imaged within the well's time
  seconds_per_well: number
  schedule_hours: number[] // hours after a plate is stored at which it is imaged again
}

export const DEFAULT_IMAGING: Imaging = { wells_per_plate: 96, drops_per_well: 3, seconds_per_well: 8, schedule_hours: [1, 2, 4, 8, 16, 32, 64, 128] }

/** How long a stored crystal plate grows before it can be soaked: normal, cut off at min and max (hours). */
export interface Growth {
  mean_hours: number
  sd_hours: number
  min_hours: number
  max_hours: number
}

export const DEFAULT_GROWTH: Growth = { mean_hours: 48, sd_hours: 24, min_hours: 2, max_hours: 168 }

export const plateImagingTime = (im: Imaging) => im.wells_per_plate * im.seconds_per_well

export interface Loop {
  start: number
  end: number
  times: number
}

export interface Route {
  id: string
  name: string
  group: string
  labware: string
  enabled: boolean
  scenarios: Scenario[]
  count: number
  interval: number
  offset: number
  steps: Step[]
  loop: Loop | null
}

export interface Placement {
  station: string // "<device id>" for unlimited devices, "<device id>:<unit>" otherwise
  x: number // metres along the rail to the station's pick point
  side: -1 | 1
}

export interface Layout {
  placements: Placement[]
  rail_speed: number // m/s
  handoff_time: number // s per pick or place
  min_separation: number // m between carriage centres
  return_home: boolean
}

export interface Workflow {
  name: string
  devices: Device[]
  routes: Route[]
  move_time: TimeSpec
  cobots_by_phase: Record<string, number>
  layout?: Layout | null // physical arrangement; absent = default arrangement
  imaging: Imaging
  growth: Growth
}

export interface RunSettings {
  scenario: DayType
  day_length: number // seconds from the start of one day to the start of the next
  days: number // run and shutdown days: consecutive days simulated
  time_variation: number // vary times that have no spread by up to this fraction
  runs: number // repeats with seeds seed, seed+1 ... for result ranges
  phase: number
  cobots: number | null
  single: boolean
  seed: number | null
}

export type EventKind =
  | 'released'
  | 'move_ready'
  | 'move_start'
  | 'move_end'
  | 'process_start'
  | 'process_end'
  | 'dwell_end'
  | 'completed' // device/unit set when the plate stays stored there
  | 'image_start' // a stored plate imaged again on schedule
  | 'image_end'

export interface SimEvent {
  t: number
  item: number
  route: string
  kind: EventKind
  step: number
  device: string | null
  unit: number | null
  to: number | null
  cobot: boolean
  arm?: number | null // which arm on the rail made a cobot move
  carried?: boolean // the item comes from the day before (follow-on days; its earlier events are at t < 0)
  due?: number | null // image_start: when the schedule wanted the image
  takes?: number | null // first step of a soak: the stored plate (item) it took out, if one grown in the run
}

export interface DayStats {
  day: number
  start: number
  released: number
  completed: number
  last_finish: number | null // last of the day's items finished this long after the day started
  stored_end: number // plates in all incubators at the end of the day
  soaks_grown: number
  soaks_stock: number
  images: number
  imaging_hours: number
  growth_delay: number
  cobot_moves: number
}

export interface Spread {
  min: number
  low: number // 10th percentile
  median: number
  high: number // 90th percentile
  max: number
}

export interface Ranges {
  runs: number
  seeds: number[]
  makespan: Spread
  completed: Spread
  cobot_utilisation: Spread | null
  devices: Record<string, Spread>
  routes: Record<string, { avg_cycle: Spread | null; keeps_up: number }>
  growth_delay: Spread
  bottleneck: Record<string, number>
}

export interface OptimiseScore {
  cost: number
  makespan: number
  move_time: number // summed over all cobot moves
  blocked: number // summed time moves waited for the rail
  blocked_moves: number
}

export interface OptimiseResult {
  layout: Layout
  before: OptimiseScore
  after: OptimiseScore
  evaluations: number
  seconds: number
  improved: boolean
}

export interface IncubatorStats {
  id: string
  name: string
  unit: number
  capacity: number | null
  imager: boolean
  stored_start: number // plates inside at time 0 (there at the start of the day, or stored the day before)
  stored_end: number
  stored_today: number // put in for storage from time 0
  taken_out: number // stored plates taken out (grown plates retrieved for a soak)
  images: number // plates imaged from time 0 (going in, for a soak, or on the growth schedule)
  imaging_time: number
  imaging_share: number // of the day (24 h)
  scheduled: number // growth images on schedule
  avg_delay: number // due -> started
  max_delay: number
}

export interface DeviceStats {
  id: string
  name: string
  units: number | null
  uses: number
  utilisation: number | null
  blocked_fraction: number
  avg_wait: number
  max_wait: number
  max_queue: number
  unit_utilisation: Record<string, number>
}

export interface CobotStats {
  count: number
  utilisation: number | null
  moves: number
  avg_wait: number
}

export interface RouteStats {
  id: string
  name: string
  released: number
  completed: number
  avg_cycle_time: number | null
  min_cycle_time: number | null
  max_cycle_time: number | null
  throughput_per_hour: number | null
  keeps_up: boolean | null
}

export interface Stuck {
  item: number
  route: string
  step: number
  since: number
}

export interface Bottleneck {
  id: string
  name: string
  kind: 'device' | 'cobot'
  utilisation: number
}

export interface Kpis {
  makespan: number
  skipped: { route: string; reason: string }[]
  warnings: string[]
  released: number
  completed: number
  carried_over: number // items still in the system from the day before
  carried_completed: number
  devices: DeviceStats[]
  incubators: IncubatorStats[]
  days: DayStats[] // empty for a one-day run
  cobots: CobotStats
  routes: RouteStats[]
  stuck: Stuck[]
  ranking: Bottleneck[]
  bottleneck: Bottleneck | null
}

export type RailKey = [t: number, x: number, side: -1 | 1, reach: number]

export interface RailMove {
  item: number
  arm: number
  start: number
  end: number // arm free again
  pick: number // plate leaves the source nest
  place: number // plate is in the destination nest
  source: string // station keys
  target: string
  need: number // seconds of arm motion
  blocked: number // seconds waited because the rail was in the way while an arm was free
}

export interface RailResult {
  start: number // rail extent, metres
  end: number
  homes: number[]
  tracks: RailKey[][]
  moves: RailMove[]
}

export interface SimResult {
  events: SimEvent[]
  kpis: Kpis
  rail?: RailResult | null // arm motion, when the workflow has a layout and cobots
  ranges?: Ranges | null // when the run was repeated over several seeds
}

export const PHASES: { value: number; label: string }[] = [
  { value: 2, label: 'Phase 2 (codify experiment)' },
  { value: 3, label: 'Phase 3 (plate handling and transport)' },
  { value: 4, label: 'Phase 4 (duplicate workflow, scale)' },
]

export function unitsInPhase(d: Device, phase: number): number[] | null {
  if (d.unit_phases === null) return null
  return d.unit_phases.flatMap((p, i) => (p <= phase ? [i + 1] : []))
}

// ---------- lab metadata database (db/schema.sql, browsed through the API)

export interface DbColumn {
  name: string
  type: string
}

export interface DbTable {
  name: string
  kind: 'table' | 'view'
  section: string
  rows: number
  columns: DbColumn[]
}

export interface DbStatus {
  built: boolean
  source: string | null
  tables: DbTable[]
}

export interface DbRows {
  name: string
  columns: DbColumn[]
  rows: unknown[][]
  total: number
  offset: number
}
