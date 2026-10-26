// Mirrors backend/src/axlr8/{model,kpis}.py. All times are in seconds.

export type TimeKind = 'fixed' | 'normal' | 'uniform' | 'triangular'
export type Timing = 'fixed' | 'project' | 'assumed'
export type DeviceKind = 'process' | 'storage' | 'manual' | 'waste'
export type Transport = 'cobot' | 'linked' | 'manual'
export type Scenario = 'run' | 'shutdown'

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
}

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

export interface Workflow {
  name: string
  devices: Device[]
  routes: Route[]
  move_time: TimeSpec
  cobots_by_phase: Record<string, number>
}

export interface RunSettings {
  scenario: Scenario
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
  | 'completed'

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
  devices: DeviceStats[]
  cobots: CobotStats
  routes: RouteStats[]
  stuck: Stuck[]
  ranking: Bottleneck[]
  bottleneck: Bottleneck | null
}

export interface SimResult {
  events: SimEvent[]
  kpis: Kpis
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
