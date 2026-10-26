// Mirrors backend/src/axlr8/{model,kpis}.py. All times are in seconds.

export type TimeKind = 'fixed' | 'normal' | 'uniform' | 'triangular'

export interface TimeSpec {
  value: number
  kind: TimeKind
  spread: number
}

export interface Station {
  id: string
  name: string
  process_time: TimeSpec
  capacity: number
  batch_size: number
  buffer_size: number | null
}

export interface Arm {
  id: string
  name: string
}

export interface Transfer {
  from_id: string
  to_id: string
  time: TimeSpec
  arm: string | null
}

export interface LabConfig {
  name: string
  stations: Station[]
  arms: Arm[]
  transfers: Transfer[]
}

export interface RunSettings {
  num_samples: number
  arrival_interval: number
  seed: number | null
}

export type EventKind =
  | 'released'
  | 'dest_reserved'
  | 'move_start'
  | 'move_end'
  | 'process_start'
  | 'process_end'
  | 'completed'

export interface SimEvent {
  t: number
  sample: number
  kind: EventKind
  at: string
  to: string | null
  arm: string | null
  batch: number | null
}

export interface StationStats {
  id: string
  name: string
  utilisation: number
  blocked_fraction: number
  avg_wait: number
  max_wait: number
  avg_queue: number
  max_queue: number
  batches: number
}

export interface ArmStats {
  id: string
  name: string
  utilisation: number
  moves: number
  avg_wait: number
}

export interface Bottleneck {
  id: string
  kind: 'station' | 'arm'
  utilisation: number
}

export interface Kpis {
  num_samples: number
  makespan: number
  throughput_per_hour: number | null
  avg_cycle_time: number
  min_cycle_time: number
  max_cycle_time: number
  stations: StationStats[]
  arms: ArmStats[]
  bottleneck: Bottleneck | null
}

export interface SimResult {
  events: SimEvent[]
  kpis: Kpis
}

export const INPUT = 'input'
export const OUTPUT = 'output'
