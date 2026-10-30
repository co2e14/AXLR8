import { describe, expect, it } from 'vitest'
import { autoPlacements, overlaps, resolveLayout, stations } from './lab'
import { findClashes, incubatorLevels, levelAt, replay, sample, spotAt, type Key } from './physical'
import { armPose, PF400 } from './pf400'
import { DEFAULT_GROWTH, DEFAULT_IMAGING, type Device, type RailResult, type SimEvent, type Workflow } from './types'

const dev = (id: string, units: number[] | null = [1]): Device => ({
  id, name: id.toUpperCase(), kind: 'process', unit_phases: units, time: { value: 10, kind: 'fixed', spread: 0 }, timing: 'fixed', note: '', capacity: null, imager_units: [],
})

const wf = (devices: Device[], placements: Workflow['layout'] = null): Workflow => ({
  name: 'w', devices, routes: [], move_time: { value: 30, kind: 'fixed', spread: 0 }, cobots_by_phase: {}, layout: placements, imaging: DEFAULT_IMAGING, growth: DEFAULT_GROWTH,
})

const ev = (t: number, item: number, kind: SimEvent['kind'], step: number, extra: Partial<SimEvent> = {}): SimEvent => ({
  t, item, route: 'r', kind, step, device: null, unit: null, to: null, cobot: false, ...extra,
})

const params = { rail_speed: 1, handoff_time: 2, min_separation: 0.9, return_home: false }

describe('layout', () => {
  it('has one station per unit, and one for an unlimited device', () => {
    const keys = stations(wf([dev('a', [1, 3]), dev('b', null)])).map((s) => s.key)
    expect(keys).toEqual(['a:1', 'a:2', 'b'])
  })

  it('packs stations on both sides without overlaps', () => {
    const w = wf([dev('a'), dev('b'), dev('c'), dev('d')])
    const sides = autoPlacements(stations(w)).map((p) => p.side)
    expect(new Set(sides)).toEqual(new Set([1, -1]))
    expect(overlaps(resolveLayout(w))).toEqual([])
  })

  it('keeps saved placements and adds new stations after them', () => {
    const w = wf([dev('a'), dev('b')], { ...params, placements: [{ station: 'a:1', x: 5, side: -1 }, { station: 'gone', x: 1, side: 1 }] })
    const l = resolveLayout(w)
    expect(l.at.get('a:1')).toEqual({ station: 'a:1', x: 5, side: -1 })
    expect(l.at.has('gone')).toBe(false)
    expect(l.at.get('b:1')!.x).toBeGreaterThan(5)
    expect(l.length).toBeGreaterThan(l.at.get('b:1')!.x)
  })

  it('reports stations placed on top of each other', () => {
    const w = wf([dev('a'), dev('b')], { ...params, placements: [{ station: 'a:1', x: 2, side: 1 }, { station: 'b:1', x: 2.1, side: 1 }] })
    expect(overlaps(resolveLayout(w)).map(([p, q]) => [p.key, q.key])).toEqual([['a:1', 'b:1']])
  })
})

describe('arm pose', () => {
  it('keeps both links at their lengths and the plate where asked', () => {
    for (const side of [1, -1] as const) {
      for (const reach of [0, 0.5, 1]) {
        const p = armPose(2, side, reach)
        const d = (u: [number, number], v: [number, number]) => Math.hypot(u[0] - v[0], u[1] - v[1])
        expect(d(p.shoulder, p.elbow)).toBeCloseTo(PF400.inner, 6)
        expect(d(p.elbow, p.wrist)).toBeCloseTo(PF400.outer, 6)
        expect(Math.sign(p.plate[1])).toBe(side)
      }
    }
  })
})

// Plate 1: a:1 -> (cobot, 10 s window) -> b:1. a sits at x 1, b at x 5.
const twoStations = () =>
  resolveLayout(wf([dev('a'), dev('b')], { ...params, placements: [{ station: 'a:1', x: 1, side: 1 }, { station: 'b:1', x: 5, side: -1 }] }))

const oneMove = (window: number): SimEvent[] => [
  ev(0, 1, 'released', -1),
  ev(0, 1, 'move_start', -1, { to: 0 }),
  ev(0, 1, 'move_end', 0),
  ev(0, 1, 'process_start', 0, { device: 'a', unit: 1 }),
  ev(10, 1, 'process_end', 0, { device: 'a', unit: 1 }),
  ev(10, 1, 'move_ready', 0, { to: 1 }),
  ev(10, 1, 'move_start', 0, { to: 1, cobot: true }),
  ev(10 + window, 1, 'move_end', 1, { cobot: true }),
  ev(10 + window, 1, 'process_start', 1, { device: 'b', unit: 1 }),
  ev(20 + window, 1, 'process_end', 1, { device: 'b', unit: 1 }),
  ev(20 + window, 1, 'completed', 1),
]

// The engine's rail result for oneMove: arm 0 carries plate 1 from a:1 (x 1) to b:1 (x 5).
const railFor = (window: number): RailResult => ({
  start: 0,
  end: 6,
  homes: [3],
  tracks: [[[0, 3, 1, 0], [12, 1, 1, 0], [13, 1, 1, 1], [14, 1, 1, 0], [18, 5, -1, 0], [19, 5, -1, 1], [20, 5, -1, 0]]],
  moves: [{ item: 1, arm: 0, start: 10, end: 10 + window, pick: 13, place: 19, source: 'a:1', target: 'b:1', need: 10, blocked: 0 }],
})

describe('replay', () => {
  it('puts the plate on the arm between pick and place', () => {
    const events = oneMove(30).map((e) => (e.kind === 'move_start' && e.cobot ? { ...e, arm: 0 } : e))
    const r = replay(events, twoStations(), railFor(30))
    expect(sample(r.arms[0], 13)).toMatchObject({ x: 1, side: 1, reach: 1 })
    expect(sample(r.arms[0], 19)).toMatchObject({ x: 5, side: -1, reach: 1 })
    const plate = r.plates.get(1)!.stays
    expect(spotAt(plate, 5)).toEqual({ kind: 'station', station: 'a:1' })
    expect(spotAt(plate, 16)).toEqual({ kind: 'arm', arm: 0 })
    expect(spotAt(plate, 25)).toEqual({ kind: 'station', station: 'b:1' })
    expect(spotAt(plate, 1e6)).toBeNull()
    expect(r.clashes).toEqual([])
    expect(r.stretched).toEqual([])
  })

  it('notes a move whose driving set its length', () => {
    const events = oneMove(10).map((e) => (e.kind === 'move_start' && e.cobot ? { ...e, arm: 0 } : e))
    expect(replay(events, twoStations(), railFor(10)).stretched).toHaveLength(1)
  })

  it('keeps a plate that ends stored in its incubator', () => {
    const events = oneMove(30).map((e) => (e.kind === 'completed' ? { ...e, device: 'b', unit: 1 } : e))
    const r = replay(events, twoStations(), null)
    expect(spotAt(r.plates.get(1)!.stays, 1e6)).toEqual({ kind: 'station', station: 'b:1' })
  })

  it('moves plates straight to the next station when there is no rail', () => {
    const r = replay(oneMove(30), twoStations(), null)
    expect(r.arms).toEqual([])
    expect(spotAt(r.plates.get(1)!.stays, 5)).toEqual({ kind: 'station', station: 'a:1' })
    expect(spotAt(r.plates.get(1)!.stays, 15)).toEqual({ kind: 'station', station: 'b:1' })
  })
})

describe('clashes', () => {
  const still = (x: number): Key[] => [{ t: 0, x, side: 1, reach: 0 }]
  const drive = (x0: number, x1: number, t0: number, t1: number): Key[] => [
    { t: 0, x: x0, side: 1, reach: 0 },
    { t: t0, x: x0, side: 1, reach: 0 },
    { t: t1, x: x1, side: 1, reach: 0 },
  ]

  it('finds when one arm drives into a parked one', () => {
    // arm 0 drives 0 -> 4 over 10 s; arm 1 parked at 3; too close once arm 0 passes 2.1
    const [c] = findClashes([drive(0, 4, 0, 10), still(3)], 0.9)
    expect(c.arms).toEqual([0, 1])
    expect(c.start).toBeCloseTo(5.25)
    expect(c.end).toBeCloseTo(10)
    expect(c.gap).toBeCloseTo(-1) // would have had to pass
  })

  it('ignores arms that keep their distance', () => {
    expect(findClashes([drive(0, 1, 0, 10), still(3)], 0.9)).toEqual([])
  })
})

describe('incubator levels', () => {
  it('counts plates inside at the start, stored, and taken out', () => {
    const inc = { ...dev('inc', [1, 1]), kind: 'storage' as const, capacity: [10, 5], stored_at_start: [3, 0] }
    const w: Workflow = {
      ...wf([inc]),
      routes: [
        { id: 'grow', name: 'grow', group: '', labware: '', enabled: true, scenarios: ['run'], count: 1, interval: 0, offset: 0, loop: null,
          steps: [{ devices: ['inc'], units: null, time: null, dwell: null, timing: null, label: null, optional: false, enabled: true, transport: 'cobot', join: null, sync: null, spawn: [], image: true, store: true }] },
        { id: 'soak', name: 'soak', group: '', labware: '', enabled: true, scenarios: ['run'], count: 1, interval: 0, offset: 0, loop: null,
          steps: [{ devices: ['inc'], units: null, time: null, dwell: null, timing: null, label: null, optional: false, enabled: true, transport: 'linked', join: null, sync: null, spawn: [], image: false, store: false }] },
      ],
    }
    const events: SimEvent[] = [
      ev(10, 1, 'completed', 0, { route: 'grow', device: 'inc', unit: 1 }),
      ev(20, 2, 'process_end', 0, { route: 'soak', device: 'inc', unit: 1 }),
      ev(30, 3, 'completed', 0, { route: 'grow', device: 'inc', unit: 2 }),
    ]
    const levels = incubatorLevels(w, events)
    const one = levels.get('inc:1')!
    expect([levelAt(one, 0), levelAt(one, 15), levelAt(one, 25)]).toEqual([3, 4, 3])
    expect(one.capacity).toBe(10)
    expect(levelAt(levels.get('inc:2')!, 40)).toBe(1)
  })
})
