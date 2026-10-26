// Pure edits on a Workflow. Step edits keep a route's loop on the same block of steps.
import type { Device, Loop, Route, Step, Workflow } from './types'

export const fixedTime = (value: number) => ({ value, kind: 'fixed' as const, spread: 0 })

function uniqueId(prefix: string, taken: string[]): string {
  for (let n = taken.length + 1; ; n++) if (!taken.includes(`${prefix}${n}`)) return `${prefix}${n}`
}

const mapRoute = (wf: Workflow, id: string, fn: (r: Route) => Route): Workflow => ({
  ...wf,
  routes: wf.routes.map((r) => (r.id === id ? fn(r) : r)),
})

export function newStep(device: string): Step {
  return {
    devices: [device], units: null, time: null, dwell: null, timing: null, label: null, optional: false,
    enabled: true, transport: 'cobot', join: null, sync: null, spawn: [],
  }
}

// ---------- devices ----------

export function deviceUsage(wf: Workflow, deviceId: string): string[] {
  return wf.routes.filter((r) => r.steps.some((s) => s.devices.includes(deviceId))).map((r) => r.id)
}

export function updateDevice(wf: Workflow, id: string, patch: Partial<Device>): Workflow {
  return { ...wf, devices: wf.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)) }
}

export function addDevice(wf: Workflow): Workflow {
  const id = uniqueId('device_', wf.devices.map((d) => d.id))
  const device: Device = {
    id, name: 'New device', kind: 'process', unit_phases: [1], time: fixedTime(60), timing: 'assumed', note: '',
  }
  return { ...wf, devices: [...wf.devices, device] }
}

/** Removes a device only when no route uses it. */
export function removeDevice(wf: Workflow, id: string): Workflow {
  if (deviceUsage(wf, id).length > 0) return wf
  return { ...wf, devices: wf.devices.filter((d) => d.id !== id) }
}

// ---------- routes ----------

export function updateRoute(wf: Workflow, id: string, patch: Partial<Route>): Workflow {
  return mapRoute(wf, id, (r) => ({ ...r, ...patch }))
}

export function addRoute(wf: Workflow): Workflow {
  const id = uniqueId('route_', wf.routes.map((r) => r.id))
  const route: Route = {
    id, name: 'New route', group: 'Custom', labware: '', enabled: true, scenarios: ['run', 'shutdown'],
    count: 1, interval: 0, offset: 0, steps: [newStep(wf.devices[0].id)], loop: null,
  }
  return { ...wf, routes: [...wf.routes, route] }
}

export function removeRoute(wf: Workflow, id: string): Workflow {
  return {
    ...wf,
    routes: wf.routes
      .filter((r) => r.id !== id)
      .map((r) => ({ ...r, steps: r.steps.map((s) => ({ ...s, spawn: s.spawn.filter((sp) => sp.route !== id) })) })),
  }
}

// ---------- steps ----------

export function updateStep(wf: Workflow, routeId: string, index: number, patch: Partial<Step>): Workflow {
  return mapRoute(wf, routeId, (r) => ({ ...r, steps: r.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) }))
}

/** Insert a copy-like new step after `index`, using the same device. */
export function insertStep(wf: Workflow, routeId: string, index: number): Workflow {
  return mapRoute(wf, routeId, (r) => {
    const at = index + 1
    const steps = [...r.steps.slice(0, at), newStep(r.steps[index]?.devices[0] ?? wf.devices[0].id), ...r.steps.slice(at)]
    let loop: Loop | null = r.loop
    if (loop) {
      if (at <= loop.start) loop = { ...loop, start: loop.start + 1, end: loop.end + 1 }
      else if (at <= loop.end) loop = { ...loop, end: loop.end + 1 }
    }
    return { ...r, steps, loop }
  })
}

export function removeStep(wf: Workflow, routeId: string, index: number): Workflow {
  const route = wf.routes.find((r) => r.id === routeId)
  if (!route || route.steps.length <= 1) return wf
  return mapRoute(wf, routeId, (r) => {
    let loop: Loop | null = r.loop
    if (loop) {
      if (index < loop.start) loop = { ...loop, start: loop.start - 1, end: loop.end - 1 }
      else if (index <= loop.end) loop = loop.end - 1 < loop.start ? null : { ...loop, end: loop.end - 1 }
    }
    return { ...r, steps: r.steps.filter((_, i) => i !== index), loop }
  })
}

export function moveStep(wf: Workflow, routeId: string, index: number, dir: -1 | 1): Workflow {
  const route = wf.routes.find((r) => r.id === routeId)
  const j = index + dir
  if (!route || j < 0 || j >= route.steps.length) return wf
  return mapRoute(wf, routeId, (r) => {
    const steps = [...r.steps]
    ;[steps[index], steps[j]] = [steps[j], steps[index]]
    return { ...r, steps }
  })
}
