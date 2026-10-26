import { describe, expect, it } from 'vitest'
import { fmtClock, fmtCompact, fmtDuration, fmtPct } from './format'

describe('fmtDuration', () => {
  it.each([
    [0, '0 s'],
    [42.4, '42 s'],
    [65, '1 min 05 s'],
    [3600 + 4 * 60 + 30, '1 h 04 min'],
  ])('%s s -> %s', (s, out) => expect(fmtDuration(s)).toBe(out))
})

describe('fmtClock', () => {
  it('pads hours, minutes and seconds', () => expect(fmtClock(3725.9)).toBe('01:02:05'))
})

describe('fmtPct', () => {
  it('rounds to whole percent', () => expect(fmtPct(0.9876)).toBe('99%'))
})

describe('fmtCompact', () => {
  it.each([
    [45, '45 s'],
    [180, '3 min'],
    [210, '3.5 min'],
    [9000, '2.5 h'],
  ])('%s s -> %s', (s, out) => expect(fmtCompact(s)).toBe(out))
})
