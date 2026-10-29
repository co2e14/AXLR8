// Turns the engine's event log into per-item timelines that can be sampled at any time t.
import type { SimEvent } from './types'

export type Status = 'pending' | 'queued' | 'waiting' | 'moving' | 'processing' | 'dwelling' | 'done'

export interface Segment {
  start: number
  end: number
  status: Status
  route: string
  step: number // where the item is; for moves, the step it left
  to: number | null // destination step while moving
  device: string | null
  unit: number | null
  cobot: boolean
}

export interface ItemState extends Omit<Segment, 'start' | 'end'> {
  item: number
  progress: number
  released: number
}

export interface Timeline {
  route: string
  segments: Segment[]
}

export type Timelines = Map<number, Timeline>

const STATUS: Record<SimEvent['kind'], Status> = {
  released: 'queued',
  move_ready: 'waiting', // finished here, waiting to be picked up
  move_start: 'moving',
  move_end: 'queued', // waiting for a device unit (or a join partner)
  process_start: 'processing',
  process_end: 'dwelling', // zero length unless the step has a dwell
  dwell_end: 'waiting',
  completed: 'done',
  image_start: 'processing', // a stored plate being imaged again
  image_end: 'done',
}

export function buildTimelines(events: SimEvent[]): Timelines {
  const out: Timelines = new Map()
  for (const e of events) {
    let tl = out.get(e.item)
    if (!tl) out.set(e.item, (tl = { route: e.route, segments: [] }))
    const segs = tl.segments
    const prev = segs[segs.length - 1]
    if (prev) prev.end = e.t
    const moving = e.kind === 'move_start' || e.kind === 'move_ready'
    segs.push({
      start: e.t,
      end: Infinity,
      status: STATUS[e.kind],
      route: e.route,
      step: e.step,
      to: moving ? e.to : null,
      device: e.device,
      unit: e.unit,
      cobot: e.cobot,
    })
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

export function stateAt(timelines: Timelines, t: number): ItemState[] {
  const states: ItemState[] = []
  for (const [item, { route, segments }] of timelines) {
    const released = segments[0]?.start ?? 0
    const i = lastStartingBy(segments, t)
    if (i < 0) {
      states.push({
        item, route, released, status: 'pending', step: -1, to: null, device: null, unit: null, cobot: false, progress: 0,
      })
      continue
    }
    const { start, end, ...rest } = segments[i]
    const progress = end > start && end !== Infinity ? Math.min(1, (t - start) / (end - start)) : 1
    states.push({ item, released, ...rest, progress })
  }
  return states
}

/** Step series [time, items waiting] for one device, from arrival at a step to the start of processing.
 * Starts at time 0: on a follow-on day, items carried over from day 1 count from then. */
export function queueSeries(events: SimEvent[], deviceId: string): [number, number][] {
  const arrived = new Map<number, number>()
  const changes: [number, number][] = []
  for (const e of events) {
    if (e.kind === 'move_end') arrived.set(e.item, e.t)
    else if (e.kind === 'process_start' && e.device === deviceId) {
      changes.push([Math.max(0, arrived.get(e.item) ?? e.t), 1], [Math.max(0, e.t), -1])
    }
  }
  changes.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const series: [number, number][] = []
  let n = 0
  for (const [t, d] of changes) {
    n += d
    const last = series[series.length - 1]
    if (last && last[0] === t) last[1] = n
    else series.push([t, n])
  }
  return series
}
