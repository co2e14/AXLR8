import { describe, expect, it } from 'vitest'
import { asWorkflow } from './storage'

const device = { id: 'a', name: 'A', kind: 'process', unit_phases: [1], time: { value: 1, kind: 'fixed', spread: 0 }, timing: 'fixed', note: '' }
const route = { id: 'r', name: 'R', steps: [{ devices: ['a'] }] }

describe('asWorkflow', () => {
  it('accepts a well-formed workflow and fills defaults', () => {
    const wf = asWorkflow({ name: 'x', devices: [device], routes: [route] })
    expect(wf?.routes[0].steps[0]).toMatchObject({ devices: ['a'], enabled: true, transport: 'cobot', spawn: [] })
    expect(wf?.move_time.value).toBe(30)
  })
  it.each([
    ['old single-line lab', { name: 'old', stations: [] }],
    ['no devices', { name: 'x', devices: [], routes: [route] }],
    ['step without devices', { name: 'x', devices: [device], routes: [{ id: 'r', name: 'R', steps: [{}] }] }],
    ['device without time', { name: 'x', devices: [{ id: 'a', name: 'A' }], routes: [route] }],
    ['null', null],
  ])('rejects %s', (_, value) => {
    expect(asWorkflow(value)).toBeNull()
  })
})
