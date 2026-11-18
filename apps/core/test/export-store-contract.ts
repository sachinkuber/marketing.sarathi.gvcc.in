import { describe, expect, it } from 'vitest'
import type { ExportBatch, ExportStore } from '../src/audit/store.ts'

const hash = (c: string) => 'sha256:' + c.repeat(64)

function batch(chainKey: string, throughSeq: number, headHash: string): ExportBatch {
  return { chainKey, fromSeq: 1, throughSeq, headHash, entries: [] }
}

// What every ExportStore must do, whatever it keeps the copies in.
export function exportStoreContract(name: string, make: () => ExportStore | Promise<ExportStore>) {
  describe(`${name} meets the ExportStore contract`, () => {
    it('hands back the same location for the same batch and refuses a different hash', async () => {
      const store = await make()
      const first = await store.put(batch('c1', 2, hash('a')))
      expect(await store.put(batch('c1', 2, hash('a')))).toBe(first)
      await expect(store.put(batch('c1', 2, hash('b')))).rejects.toThrow()
      // The refused write changed nothing.
      expect((await store.marks('c1')).map((m) => m.chainHash)).toEqual([hash('a')])
    })

    it('lists marks ascending by throughSeq (numerically) and only for the chain asked', async () => {
      const store = await make()
      for (const seq of [10, 2, 100, 9]) await store.put(batch('c1', seq, hash('a')))
      await store.put(batch('c2', 5, hash('c')))
      const marks = await store.marks('c1')
      expect(marks.map((m) => m.throughSeq)).toEqual([2, 9, 10, 100])
      expect(marks.every((m) => m.chainKey === 'c1' && m.chainHash === hash('a'))).toBe(true)
      expect(marks.every((m) => typeof m.location === 'string' && m.location.length > 0)).toBe(true)
      expect(await store.marks('nobody')).toEqual([])
    })

    it('lists the chain keys it holds, sorted', async () => {
      const store = await make()
      expect(await store.chainKeys()).toEqual([])
      await store.put(batch('b', 1, hash('a')))
      await store.put(batch('a', 1, hash('a')))
      await store.put(batch('a', 2, hash('b')))
      expect(await store.chainKeys()).toEqual(['a', 'b'])
    })
  })
}
