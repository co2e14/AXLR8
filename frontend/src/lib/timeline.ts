// Turns the engine's event log into per-sample timelines that can be sampled at any time t.
import { INPUT, type SimEvent } from './types'

export type Status = 'pending' | 'queued' | 'waiting' | 'moving' | 'processing' | 'done'

export interface Segment {
  start: number
  end: number
  status: Status
  at: string
  to: string | null
  arm: string | null
  reason: 'arm' | 'blocked' | null
}

export interface SampleState extends Omit<Segment, 'start' | 'end'> {
  sample: number
  progress: number
}

export type Timelines = Map<number, Segment[]>

function segmentFor(e: SimEvent): Omit<Segment, 'end'> {
  const base = { start: e.t, at: e.at, to: null, arm: null, reason: null }
  switch (e.kind) {
    case 'released':
    case 'move_end':
      return { ...base, status: 'queued' }
    case 'dest_reserved':
      return { ...base, status: 'waiting', reason: 'arm', to: e.to }
    case 'move_start':
      return { ...base, status: 'moving', to: e.to, arm: e.arm }
    case 'process_start':
      return { ...base, status: 'processing' }
    case 'process_end':
      return { ...base, status: 'waiting', reason: 'blocked' }
    case 'completed':
      return { ...base, status: 'done' }
  }
}

export function buildTimelines(events: SimEvent[]): Timelines {
  const out: Timelines = new Map()
  for (const e of events) {
    let segs = out.get(e.sample)
    if (!segs) out.set(e.sample, (segs = []))
    const prev = segs[segs.length - 1]
    if (prev) prev.end = e.t
    segs.push({ ...segmentFor(e), end: Infinity })
  }
  return new Map([...out.entries()].sort((a, b) => a[0] - b[0]))
}

/** Index of the last segment starting at or before t, or -1. */
function lastStartingBy(segs: Segment[], t: number): number {
  let lo = 0
  let hi = segs.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segs[mid].start <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

export function stateAt(timelines: Timelines, t: number): SampleState[] {
  const states: SampleState[] = []
  for (const [sample, segs] of timelines) {
    const i = lastStartingBy(segs, t)
    if (i < 0) {
      states.push({ sample, status: 'pending', at: INPUT, to: null, arm: null, reason: null, progress: 0 })
      continue
    }
    const { start, end, ...rest } = segs[i]
    const progress = end > start && end !== Infinity ? Math.min(1, (t - start) / (end - start)) : 1
    states.push({ sample, ...rest, progress })
  }
  return states
}

/** Step series [time, samples waiting] for a station's queue. */
export function queueSeries(events: SimEvent[], stationId: string): [number, number][] {
  const series: [number, number][] = []
  let n = 0
  for (const e of events) {
    if (e.at !== stationId) continue
    if (e.kind === 'move_end') n += 1
    else if (e.kind === 'process_start') n -= 1
    else continue
    const last = series[series.length - 1]
    if (last && last[0] === e.t) last[1] = n
    else series.push([e.t, n])
  }
  return series
}
