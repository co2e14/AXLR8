import { describe, expect, it } from 'vitest'
import { asLabConfig } from './storage'

describe('asLabConfig', () => {
  it('accepts a well-formed lab', () => {
    const lab = { name: 'x', stations: [{ id: 'a', name: 'A', process_time: { value: 1, kind: 'fixed', spread: 0 }, capacity: 1, batch_size: 1, buffer_size: null }], arms: [], transfers: [] }
    expect(asLabConfig(lab)).toEqual(lab)
  })
  it.each([
    ['missing stations', { name: 'old' }],
    ['empty stations', { name: 'x', stations: [] }],
    ['station without times', { name: 'x', stations: [{ id: 'a', name: 'A' }] }],
    ['not an object', 'hello'],
    ['null', null],
  ])('rejects %s', (_, value) => {
    expect(asLabConfig(value)).toBeNull()
  })
  it('fills in missing arms and transfers', () => {
    const lab = asLabConfig({ name: 'x', stations: [{ id: 'a', name: 'A', process_time: { value: 1, kind: 'fixed', spread: 0 }, capacity: 1, batch_size: 1, buffer_size: null }] })
    expect(lab?.arms).toEqual([])
    expect(lab?.transfers).toEqual([])
  })
})
