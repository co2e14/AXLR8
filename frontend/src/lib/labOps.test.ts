import { describe, expect, it } from 'vitest'
import {
  addArm, addStationAfter, moveStation, removeArm, removeStation, routeTransfers, updateTransfer,
} from './labOps'
import type { LabConfig } from './types'

const t = (v: number) => ({ value: v, kind: 'fixed' as const, spread: 0 })
const st = (id: string) => ({ id, name: id, process_time: t(10), capacity: 1, batch_size: 1, buffer_size: null })

const base: LabConfig = {
  name: 'x',
  stations: [st('a'), st('b')],
  arms: [{ id: 'arm1', name: 'Arm 1' }],
  transfers: [
    { from_id: 'input', to_id: 'a', time: t(1), arm: null },
    { from_id: 'a', to_id: 'b', time: t(5), arm: 'arm1' },
    { from_id: 'b', to_id: 'output', time: t(2), arm: null },
  ],
}

const pairs = (lab: LabConfig) => routeTransfers(lab).map((x) => `${x.from_id}>${x.to_id}:${x.time.value}:${x.arm}`)

describe('routeTransfers', () => {
  it('lists one transfer per hop, defaulting missing ones', () => {
    expect(pairs({ ...base, transfers: [] })).toEqual(['input>a:0:null', 'a>b:0:null', 'b>output:0:null'])
  })
})

describe('station edits keep transfers on the route', () => {
  it('inserting splits the hop and copies its move to both halves', () => {
    const lab = addStationAfter(base, 0)
    expect(lab.stations.map((s) => s.id)).toEqual(['a', 's3', 'b'])
    expect(pairs(lab)).toEqual(['input>a:1:null', 'a>s3:5:arm1', 's3>b:5:arm1', 'b>output:2:null'])
  })
  it('new station ids never collide', () => {
    const lab = addStationAfter(addStationAfter(base, 0), 0)
    expect(new Set(lab.stations.map((s) => s.id)).size).toBe(4)
  })
  it('removing joins neighbours using the incoming move', () => {
    expect(pairs(removeStation(base, 'a'))).toEqual(['input>b:1:null', 'b>output:2:null'])
  })
  it('moving keeps moves attached to their position on the line', () => {
    const lab = moveStation(base, 'b', -1)
    expect(lab.stations.map((s) => s.id)).toEqual(['b', 'a'])
    expect(pairs(lab)).toEqual(['input>b:1:null', 'b>a:5:arm1', 'a>output:2:null'])
  })
  it('moving past the ends is a no-op', () => {
    expect(moveStation(base, 'a', -1)).toBe(base)
  })
})

describe('transfers and arms', () => {
  it('updates a transfer in place', () => {
    expect(pairs(updateTransfer(base, 'input', 'a', { arm: 'arm1' }))[0]).toBe('input>a:1:arm1')
  })
  it('removing an arm turns its moves into plain delays', () => {
    expect(pairs(removeArm(base, 'arm1'))[1]).toBe('a>b:5:null')
  })
  it('adds arms with unique ids', () => {
    const lab = addArm(addArm(base))
    expect(lab.arms.map((a) => a.id)).toEqual(['arm1', 'arm2', 'arm3'])
  })
})
