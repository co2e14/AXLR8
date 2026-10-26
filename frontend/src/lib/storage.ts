import type { LabConfig } from './types'

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null

/** Returns `value` as a LabConfig if it has the shape the app relies on, otherwise null.
 *  Full validation happens on the server; this only guards against data that would crash the UI. */
export function asLabConfig(value: unknown): LabConfig | null {
  if (!isObject(value) || !Array.isArray(value.stations) || value.stations.length === 0) return null
  const stationsOk = value.stations.every(
    (s) =>
      isObject(s) &&
      typeof s.id === 'string' &&
      typeof s.name === 'string' &&
      isObject(s.process_time) &&
      typeof s.process_time.value === 'number',
  )
  if (!stationsOk) return null
  return {
    name: typeof value.name === 'string' ? value.name : 'Untitled lab',
    stations: value.stations as LabConfig['stations'],
    arms: Array.isArray(value.arms) ? (value.arms as LabConfig['arms']) : [],
    transfers: Array.isArray(value.transfers) ? (value.transfers as LabConfig['transfers']) : [],
  }
}
