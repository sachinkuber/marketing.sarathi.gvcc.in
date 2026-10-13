import { describe, expect, it } from 'vitest'
import { PayloadRejected, canonicalise, hashCanonical, prepareVersion } from '../src/index.ts'
import { VECTORS } from './vectors.ts'

describe('test vectors (acceptance test 14, application half)', () => {
  for (const vector of VECTORS) {
    it(vector.name, () => {
      if (vector.reject !== undefined) {
        const attempt = () => prepareVersion(vector.input)
        expect(attempt).toThrow(PayloadRejected)
        expect(attempt).toThrow(vector.reject)
        return
      }
      const prepared = prepareVersion(vector.input)
      expect(prepared.canonical).toBe(vector.canonical)
      expect(prepared.hash).toBe(vector.hash)
      expect(prepared.hashScheme).toBe('cv1')
    })
  }
})

describe('canonicalise', () => {
  it('sorts keys by UTF-16 code unit and writes no whitespace', () => {
    expect(canonicalise({ b: 1, a: [true, 'x'], A: { z: 0, y: -2 } })).toBe(
      '{"A":{"y":-2,"z":0},"a":[true,"x"],"b":1}',
    )
  })

  it('leaves out an absent value and refuses null, a decimal and a number past the safe range', () => {
    expect(canonicalise({ a: undefined, b: 1 })).toBe('{"b":1}')
    expect(() => canonicalise({ a: null })).toThrow()
    expect(() => canonicalise({ a: 1.5 })).toThrow()
    expect(() => canonicalise({ a: 2 ** 53 })).toThrow()
  })

  it('writes strings the one JSON way', () => {
    expect(canonicalise({ s: 'a"b\\c\n\t\u0001é' })).toBe('{"s":"a\\"b\\\\c\\n\\t\\u0001é"}')
  })
})

describe('hashCanonical', () => {
  it('is sha256: followed by 64 lower-case hexadecimal characters of the UTF-8 bytes', () => {
    // sha256 of the empty string.
    expect(hashCanonical('')).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(hashCanonical('é')).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
