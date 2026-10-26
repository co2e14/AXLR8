import { describe, expect, it } from 'vitest'
import {
  addDevice, addRoute, deviceUsage, insertStep, moveStep, removeRoute, removeStep, updateStep,
} from './workflowOps'
import type { Route, Step, Workflow } from './types'

const t = (v: number) => ({ value: v, kind: 'fixed' as const, spread: 0 })
const step = (d: string, extra: Partial<Step> = {}): Step => ({
  devices: [d], units: null, time: null, dwell: null, timing: null, label: null, optional: false, enabled: true,
  transport: 'cobot', join: null, sync: null, spawn: [], ...extra,
})
const route = (id: string, steps: Step[], extra: Partial<Route> = {}): Route => ({
  id, name: id, group: '', labware: '', enabled: true, scenarios: ['run', 'shutdown'], count: 1, interval: 0, offset: 0,
  steps, loop: null, ...extra,
})
const base: Workflow = {
  name: 'w',
  devices: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase(), kind: 'process', unit_phases: [1], time: t(1), timing: 'fixed', note: '' })),
  routes: [
    route('r', [step('a'), step('b'), step('c'), step('d')], { loop: { start: 1, end: 2, times: 3 } }),
    route('pins', [step('a')], { count: 0 }),
  ],
  move_time: t(30),
  cobots_by_phase: { '4': 3 },
}
const r = (wf: Workflow) => wf.routes[0]
const devs = (wf: Workflow) => r(wf).steps.map((s) => s.devices[0]).join('')

describe('steps keep the loop on the same block', () => {
  it('inserting inside the loop grows it', () => {
    const wf = insertStep(base, 'r', 1)
    expect(devs(wf)).toBe('abbcd')
    expect(r(wf).loop).toEqual({ start: 1, end: 3, times: 3 })
  })
  it('inserting before the loop shifts it', () => {
    expect(r(insertStep(base, 'r', 0)).loop).toEqual({ start: 2, end: 3, times: 3 })
  })
  it('inserting after the loop leaves it', () => {
    expect(r(insertStep(base, 'r', 2)).loop).toEqual({ start: 1, end: 2, times: 3 })
  })
  it('removing inside the loop shrinks it, and the last loop step removes the loop', () => {
    const once = removeStep(base, 'r', 1)
    expect(devs(once)).toBe('acd')
    expect(r(once).loop).toEqual({ start: 1, end: 1, times: 3 })
    expect(r(removeStep(once, 'r', 1)).loop).toBeNull()
  })
  it('removing before the loop shifts it', () => {
    expect(r(removeStep(base, 'r', 0)).loop).toEqual({ start: 0, end: 1, times: 3 })
  })
  it('never removes the only step', () => {
    expect(removeStep(base, 'pins', 0)).toBe(base)
  })
  it('moves steps', () => {
    expect(devs(moveStep(base, 'r', 0, 1))).toBe('bacd')
    expect(moveStep(base, 'r', 0, -1)).toBe(base)
  })
  it('updates one step', () => {
    expect(r(updateStep(base, 'r', 3, { optional: true })).steps[3].optional).toBe(true)
  })
})

describe('devices and routes', () => {
  it('lists where a device is used', () => {
    expect(deviceUsage(base, 'a')).toEqual(['r', 'pins'])
    expect(deviceUsage(base, 'zz')).toEqual([])
  })
  it('adds devices and routes with unique ids', () => {
    const wf = addDevice(addDevice(base))
    expect(new Set(wf.devices.map((d) => d.id)).size).toBe(6)
    const wf2 = addRoute(addRoute(base))
    expect(new Set(wf2.routes.map((x) => x.id)).size).toBe(4)
  })
  it('removing a route drops spawns that fed it', () => {
    const fed = updateStep(base, 'r', 0, { spawn: [{ route: 'pins', count: 2 }] })
    const wf = removeRoute(fed, 'pins')
    expect(wf.routes.map((x) => x.id)).toEqual(['r'])
    expect(r(wf).steps[0].spawn).toEqual([])
  })
})
