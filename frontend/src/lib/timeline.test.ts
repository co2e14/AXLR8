import { describe, expect, it } from 'vitest'
import { buildTimelines, queueSeries, stateAt } from './timeline'
import type { SimEvent } from './types'

const ev = (t: number, item: number, kind: SimEvent['kind'], step: number, extra: Partial<SimEvent> = {}): SimEvent => ({
  t, item, route: 'r', kind, step, device: null, unit: null, to: null, cobot: false, ...extra,
})

// input -> step 0 (cobot 2 s, waits 1 s for a cobot) -> step 0 processes 10 s, dwells 20 s -> step 1 -> done
const events: SimEvent[] = [
  ev(0, 1, 'released', -1),
  ev(0, 1, 'move_ready', -1, { to: 0 }),
  ev(1, 1, 'move_start', -1, { to: 0, cobot: true }),
  ev(3, 1, 'move_end', 0, { cobot: true }),
  ev(4, 1, 'process_start', 0, { device: 'a', unit: 1 }),
  ev(14, 1, 'process_end', 0, { device: 'a', unit: 1 }),
  ev(34, 1, 'dwell_end', 0),
  ev(34, 1, 'move_ready', 0, { to: 1 }),
  ev(34, 1, 'move_start', 0, { to: 1 }),
  ev(34, 1, 'move_end', 1),
  ev(34, 1, 'process_start', 1, { device: 'b', unit: 2 }),
  ev(40, 1, 'process_end', 1, { device: 'b', unit: 2 }),
  ev(40, 1, 'completed', 1),
]

describe('stateAt', () => {
  const tl = buildTimelines(events)
  const at = (t: number) => stateAt(tl, t)[0]

  it('waits for a cobot before moving', () => expect(at(0.5)).toMatchObject({ status: 'waiting', step: -1, route: 'r' }))
  it('moves with progress', () => expect(at(2)).toMatchObject({ status: 'moving', step: -1, to: 0, progress: 0.5, cobot: true }))
  it('queues on arrival', () => expect(at(3.5)).toMatchObject({ status: 'queued', step: 0 }))
  it('processes on a unit', () => expect(at(5)).toMatchObject({ status: 'processing', step: 0, device: 'a', unit: 1 }))
  it('dwells after processing', () => expect(at(20)).toMatchObject({ status: 'dwelling', step: 0 }))
  it('is done at the end', () => expect(at(99)).toMatchObject({ status: 'done', step: 1 }))
  it('is pending before release', () => {
    const late = buildTimelines(events.map((e) => ({ ...e, t: e.t + 100 })))
    expect(stateAt(late, 5)[0]).toMatchObject({ status: 'pending', step: -1 })
  })
})

describe('queueSeries', () => {
  it('counts items waiting for a device', () => {
    const evs = [
      ev(0, 1, 'move_end', 0), ev(0, 2, 'move_end', 0),
      ev(0, 1, 'process_start', 0, { device: 'a' }), ev(10, 2, 'process_start', 0, { device: 'a' }),
    ]
    expect(queueSeries(evs, 'a')).toEqual([[0, 1], [10, 0]])
  })
})
