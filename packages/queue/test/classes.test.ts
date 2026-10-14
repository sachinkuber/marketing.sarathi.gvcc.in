import { describe, expect, it } from 'vitest'
import { CLASS_SETTINGS, JOB_CLASSES, perProcessCap } from '../src/classes.ts'

describe('the four job classes (spec 9.3)', () => {
  it('has exactly the specified settings', () => {
    const table = JOB_CLASSES.map((c) => {
      const s = CLASS_SETTINGS[c]
      return [
        c,
        s.heartbeatSeconds,
        s.expireInSeconds,
        s.retryLimit + 1,
        s.brandCap,
        s.notify,
        s.pollingIntervalSeconds,
      ]
    })
    expect(table).toEqual([
      ['interactive', 60, 300, 3, 2, true, 2],
      ['publishing', 60, 600, 5, 2, true, 2],
      ['production', 90, 1800, 3, 3, false, 2],
      ['bulk', 90, 7200, 3, 1, false, 2],
    ])
  })

  it('names one queue and one dead-letter queue per class, all different', () => {
    const names = JOB_CLASSES.flatMap((c) => [CLASS_SETTINGS[c].queue, CLASS_SETTINGS[c].deadLetter])
    expect(new Set(names).size).toBe(8)
  })

  it('divides a brand cap between worker processes and never exceeds it', () => {
    expect(perProcessCap(3, 1)).toBe(3)
    expect(perProcessCap(3, 2)).toBe(1)
    expect(perProcessCap(4, 2)).toBe(2)
    expect(() => perProcessCap(1, 2)).toThrow(/smaller than the number of processes/)
  })
})
