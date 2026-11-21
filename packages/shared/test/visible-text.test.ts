import { describe, expect, it } from 'vitest'
import { NOT_VISIBLE, shown } from '../src/visible-text.ts'

describe('the visible-text helper', () => {
  it('takes non-blank text up to its limit, without invisible or control characters', () => {
    expect(shown(5).safeParse('Pune').success).toBe(true)
    expect(shown(5).safeParse('x'.repeat(5)).success).toBe(true)
    expect(shown(5).safeParse('x'.repeat(6)).success).toBe(false)
    expect(shown(5).safeParse('').success).toBe(false)
    for (const bad of [
      '   ',
      `a${String.fromCodePoint(0x200b)}b`,
      `a${String.fromCodePoint(0x202e)}b`,
      'a\u0000b',
    ])
      expect(shown(5).safeParse(bad).error?.issues).toEqual([
        expect.objectContaining({ message: NOT_VISIBLE }),
      ])
    // A line break and a tab are text, not invisible characters.
    expect(shown(5).safeParse('a\nb\tc').success).toBe(true)
  })
})
