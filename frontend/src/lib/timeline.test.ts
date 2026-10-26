import { describe, expect, it } from 'vitest'
import { buildTimelines, queueSeries, stateAt } from './timeline'
import type { SimEvent } from './types'

const ev = (t: number, sample: number, kind: SimEvent['kind'], at: string, extra: Partial<SimEvent> = {}): SimEvent => ({
  t, sample, kind, at, to: null, arm: null, batch: null, ...extra,
})

// One sample: input -(2s, arm a)-> s1 (10s) -(3s)-> output
const single: SimEvent[] = [
  ev(0, 1, 'released', 'input'),
  ev(0, 1, 'dest_reserved', 'input', { to: 's1' }),
  ev(1, 1, 'move_start', 'input', { to: 's1', arm: 'a' }),
  ev(3, 1, 'move_end', 's1', { arm: 'a' }),
  ev(3, 1, 'process_start', 's1', { batch: 1 }),
  ev(13, 1, 'process_end', 's1', { batch: 1 }),
  ev(15, 1, 'dest_reserved', 's1', { to: 'output' }),
  ev(15, 1, 'move_start', 's1', { to: 'output' }),
  ev(18, 1, 'move_end', 'output'),
  ev(18, 1, 'completed', 'output'),
]

describe('stateAt', () => {
  const tl = buildTimelines(single)
  const at = (t: number) => stateAt(tl, t)[0]

  it('waits for the arm before the first move', () => {
    expect(at(0.5)).toMatchObject({ status: 'waiting', at: 'input', reason: 'arm' })
  })
  it('interpolates progress while moving', () => {
    expect(at(2)).toMatchObject({ status: 'moving', at: 'input', to: 's1', arm: 'a', progress: 0.5 })
  })
  it('is processing at the station', () => {
    expect(at(3)).toMatchObject({ status: 'processing', at: 's1' })
  })
  it('is blocked between process end and pickup', () => {
    expect(at(14)).toMatchObject({ status: 'waiting', at: 's1', reason: 'blocked' })
  })
  it('is done after completion and forever after', () => {
    expect(at(18)).toMatchObject({ status: 'done', at: 'output' })
    expect(at(1e9)).toMatchObject({ status: 'done' })
  })
  it('is pending before release', () => {
    const late = buildTimelines(single.map((e) => ({ ...e, t: e.t + 100 })))
    expect(stateAt(late, 50)[0]).toMatchObject({ status: 'pending', at: 'input' })
  })
  it('returns samples in id order', () => {
    const two = buildTimelines([...single, ...single.map((e) => ({ ...e, sample: 2 }))].sort((a, b) => a.t - b.t))
    expect(stateAt(two, 5).map((s) => s.sample)).toEqual([1, 2])
  })
})

describe('queueSeries', () => {
  it('steps up on arrival and down on process start', () => {
    const events = [
      ev(0, 1, 'move_end', 's1'), ev(0, 2, 'move_end', 's1'),
      ev(0, 1, 'process_start', 's1'), ev(10, 2, 'process_start', 's1'),
    ]
    expect(queueSeries(events, 's1')).toEqual([
      [0, 1],
      [10, 0],
    ])
  })
})
