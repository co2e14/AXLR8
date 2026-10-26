// Pure edits on a LabConfig. Every edit keeps exactly one transfer per hop of the route.
import { INPUT, OUTPUT, type LabConfig, type Station, type Transfer } from './types'

export const fixedTime = (value: number) => ({ value, kind: 'fixed' as const, spread: 0 })

function locations(lab: Pick<LabConfig, 'stations'>): string[] {
  return [INPUT, ...lab.stations.map((s) => s.id), OUTPUT]
}

export function routeTransfers(lab: LabConfig): Transfer[] {
  const locs = locations(lab)
  return locs.slice(1).map((to, i) => {
    const from = locs[i]
    return lab.transfers.find((t) => t.from_id === from && t.to_id === to) ?? {
      from_id: from, to_id: to, time: fixedTime(0), arm: null,
    }
  })
}

/** Rebuild transfers for new stations; `pick(i)` gives the old transfer to reuse for hop i. */
function rewire(lab: LabConfig, stations: Station[], pick: (i: number) => Transfer): LabConfig {
  const locs = locations({ stations })
  const transfers = locs.slice(1).map((to, i) => ({ ...pick(i), from_id: locs[i], to_id: to }))
  return { ...lab, stations, transfers }
}

function uniqueId(prefix: string, taken: string[]): string {
  for (let n = taken.length + 1; ; n++) if (!taken.includes(`${prefix}${n}`)) return `${prefix}${n}`
}

/** Insert a new station after position `index` (-1 = at the start). */
export function addStationAfter(lab: LabConfig, index: number): LabConfig {
  const id = uniqueId('s', lab.stations.map((s) => s.id))
  const station: Station = {
    id, name: 'New station', process_time: fixedTime(60), capacity: 1, batch_size: 1, buffer_size: null,
  }
  const stations = [...lab.stations.slice(0, index + 1), station, ...lab.stations.slice(index + 1)]
  const old = routeTransfers(lab)
  const split = index + 1 // hop that the new station sits on
  return rewire(lab, stations, (i) => old[i <= split ? i : i - 1])
}

export function removeStation(lab: LabConfig, id: string): LabConfig {
  const index = lab.stations.findIndex((s) => s.id === id)
  if (index < 0 || lab.stations.length === 1) return lab
  const old = routeTransfers(lab)
  const stations = lab.stations.filter((s) => s.id !== id)
  return rewire(lab, stations, (i) => old[i <= index ? i : i + 1])
}

export function moveStation(lab: LabConfig, id: string, dir: -1 | 1): LabConfig {
  const i = lab.stations.findIndex((s) => s.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= lab.stations.length) return lab
  const stations = [...lab.stations]
  ;[stations[i], stations[j]] = [stations[j], stations[i]]
  const old = routeTransfers(lab)
  return rewire(lab, stations, (k) => old[k])
}

export function updateStation(lab: LabConfig, id: string, patch: Partial<Station>): LabConfig {
  return { ...lab, stations: lab.stations.map((s) => (s.id === id ? { ...s, ...patch } : s)) }
}

export function updateTransfer(lab: LabConfig, from: string, to: string, patch: Partial<Transfer>): LabConfig {
  return {
    ...lab,
    transfers: routeTransfers(lab).map((t) => (t.from_id === from && t.to_id === to ? { ...t, ...patch } : t)),
  }
}

export function addArm(lab: LabConfig): LabConfig {
  const id = uniqueId('arm', lab.arms.map((a) => a.id))
  return { ...lab, arms: [...lab.arms, { id, name: `Cobot ${lab.arms.length + 1}` }] }
}

export function renameArm(lab: LabConfig, id: string, name: string): LabConfig {
  return { ...lab, arms: lab.arms.map((a) => (a.id === id ? { ...a, name } : a)) }
}

export function removeArm(lab: LabConfig, id: string): LabConfig {
  return {
    ...lab,
    arms: lab.arms.filter((a) => a.id !== id),
    transfers: lab.transfers.map((t) => (t.arm === id ? { ...t, arm: null } : t)),
  }
}
