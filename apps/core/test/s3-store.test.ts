import { describe, expect, it } from 'vitest'
import { S3ExportStore } from '../src/audit/s3-store.ts'
import type { ExportBatch } from '../src/audit/store.ts'
import { MemoryExportStore } from '../src/audit/store.ts'
import { exportStoreContract } from './export-store-contract.ts'
import { FakeS3 } from './s3-fake.ts'

const H = 'sha256:' + 'a'.repeat(64)
const NOW = new Date('2026-11-17T10:00:00.000Z')

function make(over: { objectLock?: boolean; retentionDays?: number; fake?: FakeS3 } = {}) {
  const fake = over.fake ?? new FakeS3()
  const store = new S3ExportStore({
    client: fake,
    bucket: 'audit-bucket',
    retentionDays: over.retentionDays ?? 400,
    objectLock: over.objectLock ?? false,
    now: () => NOW,
  })
  return { fake, store }
}

const batch = (throughSeq = 3, headHash = H): ExportBatch => ({
  chainKey: 'chain-1',
  fromSeq: 1,
  throughSeq,
  headHash,
  entries: [
    {
      seq: 1,
      at: '2026-11-17T09:00:00.000000Z',
      actor_kind: 'system',
      actor_id: null,
      action: 'x',
      outcome: 'success',
      subject: null,
      detail: {},
      prev_hash: null,
      hash: H,
    },
  ],
})

exportStoreContract('MemoryExportStore', () => new MemoryExportStore())
exportStoreContract('S3ExportStore over a fake bucket', () => make().store)

describe('S3ExportStore', () => {
  it('writes audit/<chainKey>/<throughSeq>-<headHash>.jsonl with one entry per line and returns its location', async () => {
    const { fake, store } = make()
    const location = await store.put(batch())
    const key = `audit/chain-1/3-${H}.jsonl`
    expect(location).toBe(`s3://audit-bucket/${key}`)
    const put = fake.sent.find((s) => s.command === 'PutObjectCommand')!
    expect(put.input).toMatchObject({ Bucket: 'audit-bucket', Key: key, ContentType: 'application/x-ndjson' })
    const lines = fake.objects.get(key)!.body.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).seq).toBe(1)
  })

  it('put sends If-None-Match: * so an existing key is never overwritten', async () => {
    const { fake, store } = make()
    await store.put(batch())
    const put = fake.sent.find((s) => s.command === 'PutObjectCommand')!
    expect(put.input.IfNoneMatch).toBe('*')
    // The bucket refuses a second write of the key (412); the repeat is answered from what is held.
    fake.sent.length = 0
    await store.put(batch())
    expect(fake.sent.filter((s) => s.command === 'PutObjectCommand')).toHaveLength(0)
  })

  it('a 412 from the bucket for a key the listing did not show is treated as held, not overwritten', async () => {
    const { fake, store } = make()
    // A concurrent writer stored the same batch between our listing and our put.
    const key = `audit/chain-1/3-${H}.jsonl`
    const realSend = fake.send.bind(fake)
    let raced = false
    fake.send = async (command) => {
      if (!raced && command.constructor.name === 'PutObjectCommand') {
        raced = true
        fake.objects.set(key, { body: 'other', input: {} })
      }
      return realSend(command)
    }
    expect(await store.put(batch())).toBe(`s3://audit-bucket/${key}`)
    expect(fake.objects.get(key)!.body).toBe('other')
  })

  it('with objectLock true, put sets ObjectLockMode COMPLIANCE and RetainUntilDate = now + retentionDays', async () => {
    const { fake, store } = make({ objectLock: true, retentionDays: 400 })
    await store.put(batch())
    const put = fake.sent.find((s) => s.command === 'PutObjectCommand')!
    expect(put.input.ObjectLockMode).toBe('COMPLIANCE')
    expect(put.input.ObjectLockRetainUntilDate).toEqual(new Date(NOW.getTime() + 400 * 86_400_000))
  })

  it('with objectLock false, put sends neither lock header', async () => {
    const { fake, store } = make({ objectLock: false })
    await store.put(batch())
    const put = fake.sent.find((s) => s.command === 'PutObjectCommand')!
    expect(put.input).not.toHaveProperty('ObjectLockMode')
    expect(put.input).not.toHaveProperty('ObjectLockRetainUntilDate')
  })

  it('put of the same key with a different headHash throws and leaves the held object alone', async () => {
    const { fake, store } = make()
    await store.put(batch())
    await expect(store.put(batch(3, 'sha256:' + 'b'.repeat(64)))).rejects.toThrow(/different hash/)
    expect([...fake.objects.keys()]).toEqual([`audit/chain-1/3-${H}.jsonl`])
  })

  it('marks lists keys in throughSeq order across pages', async () => {
    const { store } = make({ fake: new FakeS3(2) })
    for (const seq of [7, 1, 12, 3, 20]) await store.put(batch(seq))
    expect((await store.marks('chain-1')).map((m) => m.throughSeq)).toEqual([1, 3, 7, 12, 20])
  })

  it('chainKeys pages through the common prefixes', async () => {
    const { store } = make({ fake: new FakeS3(1) })
    for (const chain of ['c', 'a', 'b']) await store.put({ ...batch(), chainKey: chain })
    expect(await store.chainKeys()).toEqual(['a', 'b', 'c'])
  })

  it('reports a failure by name only, never the provider message or the content', async () => {
    const { fake, store } = make()
    fake.send = async () => {
      throw Object.assign(new Error('secret-detail https://key:pw@host'), { name: 'AccessDenied' })
    }
    const error = await store.put(batch()).then(
      () => null,
      (e: Error) => e,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toContain('AccessDenied')
    expect(error!.message).not.toContain('secret-detail')
    expect(error!.message).not.toContain('pw')
  })

  it('rejects settings that cannot be right', () => {
    const fake = new FakeS3()
    const opts = { client: fake, bucket: 'b', retentionDays: 400, objectLock: false }
    expect(() => new S3ExportStore({ ...opts, retentionDays: 0 })).toThrow()
    expect(() => new S3ExportStore({ ...opts, bucket: '' })).toThrow()
  })
})
