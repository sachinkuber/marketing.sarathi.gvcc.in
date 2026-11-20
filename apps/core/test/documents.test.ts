import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { createJob, createRun, startAttempt, type JobsDeps } from '../src/jobs/service.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
const MB = 1_048_576

let stack: Stack
let jobs: JobsDeps
let owner: TestClient
let admin: TestClient
let ownerId: string
let definitionId: string
let adminBrand: string
let seq = 0

const MAGIC = {
  'application/pdf': Buffer.from('%PDF-1.7\n'),
  'image/png': Buffer.from('89504e470d0a1a0a', 'hex'),
  'image/jpeg': Buffer.from('ffd8ffe0', 'hex'),
  'image/webp': Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]),
} as const
type Type = keyof typeof MAGIC

// A file of the given size in memory, starting with the magic bytes of its type.
function file(type: Type, size: number): Buffer {
  const out = Buffer.alloc(size)
  MAGIC[type].copy(out)
  return out
}

async function newBrand(): Promise<string> {
  return addBrand(stack, `docs-${(seq += 1)}`)
}

const base = (brandId: string) => `/api/v1/brands/${brandId}/onboarding/documents`

function upload(
  brandId: string,
  bytes: Buffer,
  options: { type?: string; name?: string | null; client?: TestClient } = {},
) {
  const headers: Record<string, string> = { 'content-type': options.type ?? 'application/pdf' }
  if (options.name !== null) headers['x-file-name'] = encodeURIComponent(options.name ?? 'brochure.pdf')
  return (options.client ?? owner).request('POST', base(brandId), { raw: bytes, headers })
}

// A document inserted straight into the table, for the limit tests (nothing is uploaded 20 or 500 MB at a time).
async function insertDocument(
  brandId: string,
  bytes: Buffer,
  type: Type = 'application/pdf',
): Promise<string> {
  const made = await stack.db.admin.query(
    `insert into app.brand_document (brand_id, file_name, media_type, bytes, size_bytes, sha256, uploaded_by)
     values ($1, 'seed', $2, $3, $4, $5, $6) returning id`,
    [brandId, type, bytes, bytes.length, createHash('sha256').update(bytes).digest('hex'), ownerId],
  )
  return made.rows[0].id as string
}

const count = async (brandId: string): Promise<number> =>
  (
    await stack.db.admin.query('select count(*)::int as n from app.brand_document where brand_id = $1', [
      brandId,
    ])
  ).rows[0].n

beforeAll(async () => {
  stack = await createStack({ withQueue: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  definitionId = await seedDefinition(stack.db)
  const brandId = await addBrand(stack, 'docs-admin')
  ownerId = await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
  await addUser(stack, { email: 'admin@example.test', password: PASSWORD, role: 'brand_admin', brandId })
  owner = (await enrolledClient(stack, 'owner@example.test', PASSWORD)).client
  admin = (await enrolledClient(stack, 'admin@example.test', PASSWORD)).client
  adminBrand = brandId
}, 120_000)
afterAll(async () => stack?.close())

describe('upload and list', () => {
  it('uploads a PDF and lists it without bytes', async () => {
    const brandId = await newBrand()
    const bytes = file('application/pdf', 2048)
    const made = await upload(brandId, bytes, { name: 'Our brochure é.pdf' })
    expect(made.status).toBe(201)
    expect(made.json).toEqual({
      id: expect.any(String),
      fileName: 'Our brochure é.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 2048,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      parts: 0,
    })

    const listed = await owner.request('GET', base(brandId))
    expect(listed.status).toBe(200)
    expect(listed.json.documents).toHaveLength(1)
    expect(listed.json.documents[0]).toMatchObject({
      id: made.json.id,
      sizeBytes: 2048,
      fileName: 'Our brochure é.pdf',
    })
    expect(JSON.stringify(listed.json)).not.toContain('bytes')

    // The onboarding row was created for the lock, and the upload was audited.
    expect(
      (await stack.db.admin.query('select 1 from app.onboarding where brand_id = $1', [brandId])).rowCount,
    ).toBe(1)
    const entry = stack.audit.entries.find(
      (e) => e.action === 'onboarding.document_uploaded' && e.brandId === brandId,
    )
    expect(entry?.detail).toEqual({ documentId: made.json.id, sizeBytes: 2048, mediaType: 'application/pdf' })
  })

  it('accepts a PNG, a JPEG and a WebP with their own magic bytes', async () => {
    const brandId = await newBrand()
    for (const type of ['image/png', 'image/jpeg', 'image/webp'] as const) {
      expect((await upload(brandId, file(type, 64), { type, name: 'x' })).status, type).toBe(201)
    }
  })

  it('a file whose bytes are not its type is refused', async () => {
    const brandId = await newBrand()
    const html = Buffer.from('<html><body>not a pdf</body></html>')
    const wrong = await upload(brandId, html)
    expect(wrong.status).toBe(415)
    expect(wrong.json.error.code).toBe('unsupported_type')
    // A PNG declared as a JPEG, and a RIFF file that is not WebP.
    expect((await upload(brandId, file('image/png', 64), { type: 'image/jpeg' })).status).toBe(415)
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)])
    expect((await upload(brandId, wav, { type: 'image/webp' })).status).toBe(415)
    // A type that is not allowed at all.
    const text = await upload(brandId, Buffer.from('hello'), { type: 'text/plain' })
    expect(text.status).toBe(415)
    expect(text.json.error.code).toBe('unsupported_type')
    expect(await count(brandId)).toBe(0)
  })

  it('refuses a missing or too-long file name with 400 file_name', async () => {
    const brandId = await newBrand()
    const none = await upload(brandId, file('application/pdf', 64), { name: null })
    expect(none.status).toBe(400)
    expect(none.json.error.code).toBe('file_name')
    expect(
      (await upload(brandId, file('application/pdf', 64), { name: 'a'.repeat(256) })).json.error.code,
    ).toBe('file_name')
    expect((await upload(brandId, file('application/pdf', 64), { name: ' ' })).status).toBe(400)
    expect((await upload(brandId, file('application/pdf', 64), { name: 'a'.repeat(255) })).status).toBe(201)
    expect(await count(brandId)).toBe(1)
  })
})

describe('size limits', () => {
  it('a PDF over 100 MB is refused 413', async () => {
    const brandId = await newBrand()
    // One byte over: read, measured and named by the route. Rounded up, so it never reads as the limit itself.
    const over = await upload(brandId, file('application/pdf', 100 * MB + 1))
    expect(over.status).toBe(413)
    expect(over.json.error.code).toBe('too_large')
    expect(over.json.error.message).toBe('This PDF is 101 MB; the limit is 100 MB.')
    // Far over: the parser turns it away, with the same words.
    const far = await upload(brandId, file('application/pdf', 120 * MB))
    expect(far.status).toBe(413)
    expect(far.json.error.code).toBe('too_large')
    expect(far.json.error.message).toBe('This PDF is 120 MB; the limit is 100 MB.')
    expect(await count(brandId)).toBe(0)
  }, 120_000)

  it('an image over 5 MB is refused 413 naming the limit', async () => {
    const brandId = await newBrand()
    const over = await upload(brandId, file('image/png', 7 * MB), { type: 'image/png' })
    expect(over.status).toBe(413)
    expect(over.json.error.code).toBe('too_large')
    expect(over.json.error.message).toBe(
      'This image is 7 MB; the limit is 5 MB. Save it smaller or as a PDF.',
    )
    expect((await upload(brandId, file('image/webp', 5 * MB), { type: 'image/webp' })).status).toBe(201)
    expect(await count(brandId)).toBe(1)
  }, 60_000)

  it('a 40 MB PDF is accepted', async () => {
    const brandId = await newBrand()
    const bytes = file('application/pdf', 40 * MB)
    const made = await upload(brandId, bytes)
    expect(made.status).toBe(201)
    expect(made.json.sizeBytes).toBe(40 * MB)
    const stored = await stack.db.admin.query(
      'select sha256, size_bytes from app.brand_document where id = $1',
      [made.json.id],
    )
    expect(stored.rows[0]).toEqual({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size_bytes: 40 * MB,
    })
  }, 120_000)
})

describe('count and storage limits', () => {
  it('the 21st document is refused 409', async () => {
    const brandId = await newBrand()
    for (let i = 0; i < 20; i += 1) await insertDocument(brandId, file('application/pdf', 32))
    const refused = await upload(brandId, file('application/pdf', 32))
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('too_many_documents')
    expect(await count(brandId)).toBe(20)
  })

  it('a document that would pass 500 MB in total is refused 409 brand_storage_full', async () => {
    const brandId = await newBrand()
    for (let i = 0; i < 4; i += 1) await insertDocument(brandId, file('application/pdf', 100 * MB))
    await insertDocument(brandId, file('application/pdf', 99 * MB))
    // 499 MB held: one more MB fits exactly, a second does not.
    const fits = await upload(brandId, file('application/pdf', 1 * MB))
    expect(fits.status).toBe(201)
    const refused = await upload(brandId, file('application/pdf', 64))
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('brand_storage_full')
    expect(await count(brandId)).toBe(6)
  }, 180_000)

  it('two uploads at once cannot both take the last place', async () => {
    const brandId = await newBrand()
    for (let i = 0; i < 19; i += 1) await insertDocument(brandId, file('application/pdf', 32))
    const both = await Promise.all([
      upload(brandId, file('application/pdf', 64)),
      upload(brandId, file('application/pdf', 65)),
    ])
    expect(both.map((r) => r.status).sort()).toEqual([201, 409])
    expect(await count(brandId)).toBe(20)
  })
})

describe('permission', () => {
  it('a brand admin gets 403 on all three routes', async () => {
    const documentId = await insertDocument(adminBrand, file('application/pdf', 32))
    expect((await upload(adminBrand, file('application/pdf', 64), { client: admin })).status).toBe(403)
    expect((await admin.request('GET', base(adminBrand))).status).toBe(403)
    expect((await admin.request('DELETE', `${base(adminBrand)}/${documentId}`)).status).toBe(403)
    expect(await count(adminBrand)).toBe(1)
  })

  it('refuses an upload with no session', async () => {
    const brandId = await newBrand()
    const reply = await stack.newClient().request('POST', base(brandId), {
      raw: file('application/pdf', 64),
      headers: { 'content-type': 'application/pdf', 'x-file-name': 'a.pdf' },
    })
    expect(reply.status).toBe(401)
  })
})

describe('delete', () => {
  it('deletes an unreferenced document with 204 and audits it', async () => {
    const brandId = await newBrand()
    const made = await upload(brandId, file('application/pdf', 64))
    const gone = await owner.request('DELETE', `${base(brandId)}/${made.json.id}`)
    expect(gone.status).toBe(204)
    expect(await count(brandId)).toBe(0)
    const entry = stack.audit.entries.find(
      (e) => e.action === 'onboarding.document_deleted' && e.brandId === brandId,
    )
    expect(entry?.detail).toEqual({ documentId: made.json.id })
    expect((await owner.request('DELETE', `${base(brandId)}/${made.json.id}`)).status).toBe(404)
  })

  it('a referenced document cannot be deleted', async () => {
    const brandId = await newBrand()
    const id = await insertDocument(brandId, file('application/pdf', 64))
    await stack.db.admin.query(
      `insert into app.research_source (brand_id, kind, document_id, result, extract) values ($1, 'document', $2, 'read', 'x')`,
      [brandId, id],
    )
    const refused = await owner.request('DELETE', `${base(brandId)}/${id}`)
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('document_in_use')
    expect(await count(brandId)).toBe(1)
  })
})

describe('the worker reads documents', () => {
  async function jobWith(brandId: string, documentIds: string[]): Promise<{ jobId: string; token: string }> {
    const jobId = await withBrand(stack.appPool, brandId, async (client) => {
      const runId = await createRun(client, brandId, {
        agent: 'test-agent',
        definitionVersionId: definitionId,
        startedByKind: 'system',
        startedById: null,
      })
      return createJob(client, jobs, brandId, {
        runId,
        jobClass: 'production',
        input: { documentIds },
        expectedResultType: 'test.echo',
      })
    })
    await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
      jobId,
    ])
    const started = await startAttempt(jobs, jobId, 'w1')
    if (started.finished || 'outcome' in started) throw new Error('unexpected')
    return { jobId, token: started.token }
  }
  const read = (jobId: string, documentId: string, token: string) =>
    fetch(`${stack.server.url}/api/v1/worker/jobs/${jobId}/documents/${documentId}`, {
      headers: { authorization: `Worker ${jobs.workerSecret}`, 'x-attempt-token': token },
    })

  it('the worker reads only documents listed in its job', async () => {
    const brandId = await newBrand()
    const other = await newBrand()
    const listed = file('image/png', 300)
    const listedId = await insertDocument(brandId, listed, 'image/png')
    const unlistedId = await insertDocument(brandId, file('application/pdf', 64))
    const foreignId = await insertDocument(other, file('application/pdf', 64))
    const { jobId, token } = await jobWith(brandId, [listedId, foreignId])

    const ok = await read(jobId, listedId, token)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await ok.arrayBuffer()).equals(listed)).toBe(true)

    // In the brand but not in the job's input.
    expect((await read(jobId, unlistedId, token)).status).toBe(404)
    // In the job's input but another brand's.
    expect((await read(jobId, foreignId, token)).status).toBe(404)
    // Not a document at all.
    expect((await read(jobId, '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b', token)).status).toBe(404)
  })

  it('a job with no document list reads nothing, and a missing token is refused', async () => {
    const brandId = await newBrand()
    const id = await insertDocument(brandId, file('application/pdf', 64))
    const { jobId, token } = await jobWith(brandId, [])
    expect((await read(jobId, id, token)).status).toBe(404)
    const none = await fetch(`${stack.server.url}/api/v1/worker/jobs/${jobId}/documents/${id}`, {
      headers: { authorization: `Worker ${jobs.workerSecret}` },
    })
    expect(none.status).toBe(403)
  })
})
