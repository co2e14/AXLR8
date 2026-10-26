import type { Device, Route, Step, Workflow } from './types'

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
const isTime = (x: unknown) => isObject(x) && typeof x.value === 'number'

function asStep(s: unknown): Step | null {
  if (!isObject(s) || !Array.isArray(s.devices) || s.devices.length === 0) return null
  return {
    units: null, time: null, dwell: null, timing: null, label: null, optional: false, enabled: true,
    transport: 'cobot', join: null, sync: null, spawn: [], ...(s as Partial<Step>), devices: s.devices as string[],
  }
}

function asRoute(r: unknown): Route | null {
  if (!isObject(r) || typeof r.id !== 'string' || !Array.isArray(r.steps) || r.steps.length === 0) return null
  const steps = r.steps.map(asStep)
  if (steps.some((s) => s === null)) return null
  return {
    name: r.id, group: '', labware: '', enabled: true, scenarios: ['run', 'shutdown'], count: 1, interval: 0,
    offset: 0, loop: null, ...(r as Partial<Route>), id: r.id, steps: steps as Step[],
  }
}

function asDevice(d: unknown): Device | null {
  if (!isObject(d) || typeof d.id !== 'string' || !isTime(d.time)) return null
  return { name: d.id, kind: 'process', unit_phases: [1], timing: 'fixed', note: '', ...(d as Partial<Device>), id: d.id, time: d.time as Device['time'] }
}

/** Returns `value` as a Workflow if it has the shape the app relies on, otherwise null.
 *  Full validation happens on the server; this only guards against data that would crash the UI. */
export function asWorkflow(value: unknown): Workflow | null {
  if (!isObject(value) || !Array.isArray(value.devices) || !Array.isArray(value.routes)) return null
  if (value.devices.length === 0 || value.routes.length === 0) return null
  const devices = value.devices.map(asDevice)
  const routes = value.routes.map(asRoute)
  if (devices.some((d) => d === null) || routes.some((r) => r === null)) return null
  return {
    name: typeof value.name === 'string' ? value.name : 'Untitled workflow',
    devices: devices as Device[],
    routes: routes as Route[],
    move_time: isTime(value.move_time) ? (value.move_time as Workflow['move_time']) : { value: 30, kind: 'fixed', spread: 0 },
    cobots_by_phase: isObject(value.cobots_by_phase) ? (value.cobots_by_phase as Record<string, number>) : { '3': 1, '4': 3 },
  }
}
