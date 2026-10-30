// Replays a run physically: where every plate is at time t (in a station's nest, or held by an
// arm), and where each PreciseFlex arm is on the shared rail. The engine decides which arm makes
// each cobot move and how it drives, keeping the arms in order so they never pass each other
// (backend/src/axlr8/rail.py); this module only turns that into something that can be sampled.
import { NEST_OFFSET, stationKey, type ResolvedLayout } from './lab'
import type { RailMove, RailResult, SimEvent, Workflow } from './types'

export interface Key {
  t: number
  x: number // carriage position along the rail
  side: -1 | 1 // which side the gripper points to
  reach: number // 0 = retracted, 1 = over the nest
}

export interface Clash {
  start: number
  end: number
  arms: [number, number]
  x: number // where along the rail they come closest
  gap: number // closest carriage centre distance; < 0 means they passed each other
}

/** Where a plate is: in a station's nest, or held by an arm. */
export type Spot = { kind: 'station'; station: string } | { kind: 'arm'; arm: number }

interface Stay {
  start: number
  end: number
  spot: Spot
}

export interface Replay {
  arms: Key[][] // keyframes per arm
  homes: number[]
  start: number // rail extent
  end: number
  moves: RailMove[]
  clashes: Clash[] // a check on the engine: should always be empty
  blocked: RailMove[] // moves that waited for the rail to clear while an arm was free
  stretched: RailMove[] // moves where the arm's driving took longer than the model's move time
  plates: Map<number, { route: string; stays: Stay[] }>
}

const EPS = 1e-9

export function replay(events: SimEvent[], layout: ResolvedLayout, rail: RailResult | null): Replay {
  const byItem = new Map<number, SimEvent[]>()
  for (const e of events) {
    let list = byItem.get(e.item)
    if (!list) byItem.set(e.item, (list = []))
    list.push(e)
  }
  const railMoves = new Map<number, RailMove[]>()
  for (const m of rail?.moves ?? []) {
    let list = railMoves.get(m.item)
    if (!list) railMoves.set(m.item, (list = []))
    list.push(m)
  }

  const plates: Replay['plates'] = new Map()
  for (const [item, list] of byItem) {
    const stays: Stay[] = []
    const carried: RailMove[] = []
    let at: string | null = null
    const goTo = (t: number, spot: Spot | null) => {
      const last = stays[stays.length - 1]
      if (last && last.end === Infinity) last.end = t
      if (spot) stays.push({ start: t, end: Infinity, spot })
    }
    for (let j = 0; j < list.length; j++) {
      const e = list[j]
      if (e.kind === 'process_start' && e.device) {
        const s = stationKey(e.device, e.unit)
        if (s !== at) goTo(e.t, { kind: 'station', station: s })
        at = s
      } else if (e.kind === 'move_start') {
        const m = e.arm != null ? railMoves.get(item)?.find((r) => Math.abs(r.start - e.t) < 1e-6) : undefined
        if (m) {
          carried.push(m)
          at = m.target
          continue
        }
        // Moved by hand, by a linked transfer or by an arm with no layout: it appears where it is processed next.
        const next = list.slice(j).find((x) => x.kind === 'process_start' && x.step === e.to && x.device)
        if (next) {
          const s = stationKey(next.device!, next.unit)
          goTo(e.t, { kind: 'station', station: s })
          at = s
        }
      } else if (e.kind === 'completed' && !e.device) {
        goTo(e.t, null) // a plate that ends stored (e.device set) stays in its station
      }
    }
    for (const m of carried) insertStay(stays, m)
    plates.set(item, { route: list[0].route, stays })
  }

  const arms = (rail?.tracks ?? []).map((track) => track.map(([t, x, side, reach]) => ({ t, x, side, reach })))
  const moves = rail?.moves ?? []
  return {
    arms,
    homes: rail?.homes ?? [],
    start: rail?.start ?? 0,
    end: rail?.end ?? layout.length,
    moves,
    clashes: findClashes(arms, layout.min_separation - 1e-6),
    blocked: moves.filter((m) => m.blocked > 1e-6),
    stretched: moves.filter((m) => m.need > 0 && m.need >= m.end - m.start - 1e-6),
    plates,
  }
}

/** Puts the plate on the arm between pick and place, and in the destination nest after. */
function insertStay(stays: Stay[], m: RailMove) {
  const i = stays.findIndex((s) => s.start <= m.pick && m.pick < s.end)
  const after: Stay = { start: m.place, end: Infinity, spot: { kind: 'station', station: m.target } }
  const carry: Stay = { start: m.pick, end: m.place, spot: { kind: 'arm', arm: m.arm } }
  if (i < 0) {
    stays.push(carry, after)
    stays.sort((a, b) => a.start - b.start)
    return
  }
  const cur = stays[i]
  const tail = cur.end
  cur.end = m.pick
  after.end = tail
  stays.splice(i + 1, 0, carry, after)
}

/** Index of the last element starting at or before t, or -1. */
function lastBy<T>(list: T[], t: number, at: (x: T) => number): number {
  let lo = 0
  let hi = list.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (at(list[mid]) <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

export function sample(track: Key[], t: number): Key {
  const i = lastBy(track, t, (k) => k.t)
  if (i < 0) return { ...track[0], t }
  const a = track[i]
  const b = track[i + 1]
  if (!b || b.t <= a.t) return { ...a, t }
  const f = (t - a.t) / (b.t - a.t)
  // The gripper turns to its new side while retracted.
  return { t, x: a.x + (b.x - a.x) * f, side: a.reach > 0 ? a.side : b.side, reach: a.reach + (b.reach - a.reach) * f }
}

export function spotAt(stays: Stay[], t: number): Spot | null {
  const i = lastBy(stays, t, (s) => s.start)
  if (i < 0) return null
  const s = stays[i]
  return t < s.end ? s.spot : null
}

/** Intervals where two carriages are closer than `sep`, or have swapped order along the rail. */
export function findClashes(tracks: Key[][], sep: number): Clash[] {
  const out: Clash[] = []
  for (let a = 0; a < tracks.length; a++) {
    for (let b = a + 1; b < tracks.length; b++) {
      // Arms keep their home order (a before b), so the signed gap xb − xa should stay at least sep.
      const times = [...new Set([...tracks[a], ...tracks[b]].map((k) => k.t))].sort((p, q) => p - q)
      const gap = (t: number) => sample(tracks[b], t).x - sample(tracks[a], t).x
      const mid = (t: number) => (sample(tracks[a], t).x + sample(tracks[b], t).x) / 2
      let open: Clash | null = null
      for (let i = 0; i + 1 < times.length; i++) {
        const t0 = times[i]
        const t1 = times[i + 1]
        const g0 = gap(t0)
        const g1 = gap(t1)
        if (g0 >= sep && g1 >= sep) continue
        // The gap is linear within a segment: find the part of it below sep.
        const cross = (t0 * (g1 - sep) + t1 * (sep - g0)) / (g1 - g0)
        const enter = g0 < sep ? t0 : cross
        const leave = g1 < sep ? t1 : cross
        const [g, tg] = g0 <= g1 ? [g0, t0] : [g1, t1]
        if (open && enter <= open.end + EPS) open.end = leave
        else {
          if (open) out.push(open)
          open = { start: enter, end: leave, arms: [a, b], x: mid(tg), gap: g }
        }
        if (g < open.gap) {
          open.gap = g
          open.x = mid(tg)
        }
      }
      if (open) out.push(open)
    }
  }
  return out.filter((c) => c.end - c.start > 1e-3 || c.gap < 0).sort((p, q) => p.start - q.start)
}

export interface Level {
  capacity: number
  changes: [number, number][] // (t, plates inside from then on), sorted by t
}

/** How many plates each incubator unit holds over time: the plates inside at the start of the day,
 *  plus plates stored (a route ending there), minus stored plates taken out (a route starting there). */
export function incubatorLevels(wf: Workflow, events: SimEvent[]): Map<string, Level> {
  const out = new Map<string, Level>()
  const deltas = new Map<string, [number, number][]>()
  const stores = new Set(wf.devices.filter((d) => d.capacity).map((d) => d.id))
  const routes = new Map(wf.routes.map((r) => [r.id, r]))
  for (const d of wf.devices) {
    if (!d.capacity || !d.unit_phases) continue
    d.unit_phases.forEach((_, i) => {
      const key = stationKey(d.id, i + 1)
      out.set(key, { capacity: d.capacity![i] ?? 0, changes: [[-Infinity, d.stored_at_start?.[i] ?? 0]] })
      deltas.set(key, [])
    })
  }
  for (const e of events) {
    if (!e.device || !stores.has(e.device)) continue
    const key = stationKey(e.device, e.unit)
    if (e.kind === 'completed') deltas.get(key)?.push([e.t, 1])
    else if (e.kind === 'process_end' && e.step === 0 && !routes.get(e.route)?.steps[0]?.store) deltas.get(key)?.push([e.t, -1])
  }
  for (const [key, list] of deltas) {
    const level = out.get(key)!
    let n = level.changes[0][1]
    for (const [t, d] of list.sort((a, b) => a[0] - b[0])) {
      n = Math.max(0, n + d)
      level.changes.push([t, n])
    }
  }
  return out
}

export const levelAt = (level: Level, t: number) => level.changes[Math.max(0, lastBy(level.changes, t, (c) => c[0]))][1]

/** World (x, z) of a station's nest, with z across the rail. */
export const nestXZ = (layout: ResolvedLayout, station: string): [number, number] => {
  const p = layout.at.get(station)
  return p ? [p.x, p.side * NEST_OFFSET] : [0, 0]
}
