import { createHash } from 'node:crypto'
import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'

// Brand documents (spec 13, test 51). The size limits are the owner's decision (a PDF up to 100 MB, which
// supersedes the spec's 10 MB) and match migration 0026's check.
export const MEDIA_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const
export type DocumentType = (typeof MEDIA_TYPES)[number]

const MB = 1_048_576
export const PDF_LIMIT = 100 * MB
export const IMAGE_LIMIT = 5 * MB
export const MAX_DOCUMENTS = 20
export const BRAND_STORAGE_LIMIT = 500 * MB
export const MAX_FILE_NAME = 255

export const isDocumentType = (value: string): value is DocumentType =>
  (MEDIA_TYPES as readonly string[]).includes(value)

export const limitFor = (type: DocumentType): number => (type === 'application/pdf' ? PDF_LIMIT : IMAGE_LIMIT)

// Whole megabytes, rounded up, so a 100.4 MB file never reads as "100 MB" beside a 100 MB limit.
const megabytes = (bytes: number): number => Math.max(1, Math.ceil(bytes / MB))

export function tooLargeMessage(type: DocumentType, sizeBytes: number | null): string {
  const limit = limitFor(type) / MB
  if (type === 'application/pdf') {
    return sizeBytes === null
      ? `This PDF is over the limit of ${limit} MB.`
      : `This PDF is ${megabytes(sizeBytes)} MB; the limit is ${limit} MB.`
  }
  const size = sizeBytes === null ? 'over the limit' : `${megabytes(sizeBytes)} MB`
  return `This image is ${size}; the limit is ${limit} MB. Save it smaller or as a PDF.`
}

// What the first bytes must be for the type the caller declared: the declaration alone is never believed.
export function matchesMagic(type: DocumentType, bytes: Buffer): boolean {
  switch (type) {
    case 'application/pdf':
      return bytes.subarray(0, 5).toString('latin1') === '%PDF-'
    case 'image/png':
      return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'image/webp':
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
        bytes.subarray(8, 12).toString('latin1') === 'WEBP'
      )
  }
}

interface Deps {
  audit: AuditSink
}

export interface DocumentSummary {
  id: string
  fileName: string
  mediaType: string
  sizeBytes: number
  sha256: string
  // Until the document is prepared for the AI (task 5b).
  parts: number
  uploadedAt?: string
}

export async function uploadDocument(
  pool: Pool,
  deps: Deps,
  input: { brandId: string; actorId: string; fileName: string; mediaType: DocumentType; bytes: Buffer },
): Promise<DocumentSummary> {
  const { bytes, mediaType } = input
  if (!matchesMagic(mediaType, bytes)) {
    throw new AppError(
      415,
      'unsupported_type',
      'This file is not what its type says it is. Upload a PDF, PNG, JPEG or WebP file.',
    )
  }
  const limit = limitFor(mediaType)
  if (bytes.length > limit) throw new AppError(413, 'too_large', tooLargeMessage(mediaType, bytes.length))
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  return withBrand(pool, input.brandId, async (client) => {
    // Two uploads at once must not pass the limits together: the brand's onboarding row is locked while the
    // brand's documents are counted, and it is created here if the owner has not started onboarding yet.
    await client.query(
      'insert into app.onboarding (brand_id) values ($1) on conflict (brand_id) do nothing',
      [input.brandId],
    )
    await client.query('select 1 from app.onboarding where brand_id = $1 for update', [input.brandId])
    const held = await client.query<{ n: number; total: string }>(
      `select count(*)::int as n, coalesce(sum(size_bytes), 0)::text as total
         from app.brand_document where brand_id = $1`,
      [input.brandId],
    )
    const { n, total } = held.rows[0]!
    if (n >= MAX_DOCUMENTS) {
      throw new AppError(
        409,
        'too_many_documents',
        `This brand already has ${MAX_DOCUMENTS} documents, the most it can hold. Delete one first.`,
      )
    }
    if (Number(total) + bytes.length > BRAND_STORAGE_LIMIT) {
      throw new AppError(
        409,
        'brand_storage_full',
        `The brand's documents would pass ${BRAND_STORAGE_LIMIT / MB} MB in total. Delete one first.`,
      )
    }
    const made = await client.query<{ id: string }>(
      `insert into app.brand_document (brand_id, file_name, media_type, bytes, size_bytes, sha256, uploaded_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [input.brandId, input.fileName, mediaType, bytes, bytes.length, sha256, input.actorId],
    )
    const id = made.rows[0]!.id
    await deps.audit.record(
      {
        action: 'onboarding.document_uploaded',
        actor: input.actorId,
        brandId: input.brandId,
        subject: id,
        outcome: 'success',
        detail: { documentId: id, sizeBytes: bytes.length, mediaType },
      },
      client,
    )
    return { id, fileName: input.fileName, mediaType, sizeBytes: bytes.length, sha256, parts: 0 }
  })
}

export async function listDocuments(pool: Pool, brandId: string): Promise<DocumentSummary[]> {
  return withBrand(pool, brandId, async (client) => {
    const { rows } = await client.query<{
      id: string
      file_name: string
      media_type: string
      size_bytes: number
      sha256: string
      uploaded_at: Date
    }>(
      `select id, file_name, media_type, size_bytes, sha256, uploaded_at
         from app.brand_document where brand_id = $1 order by uploaded_at desc, id`,
      [brandId],
    )
    return rows.map((r) => ({
      id: r.id,
      fileName: r.file_name,
      mediaType: r.media_type,
      sizeBytes: r.size_bytes,
      sha256: r.sha256,
      parts: 0,
      uploadedAt: r.uploaded_at.toISOString(),
    }))
  })
}

export async function deleteDocument(
  pool: Pool,
  deps: Deps,
  input: { brandId: string; documentId: string; actorId: string },
): Promise<void> {
  try {
    await withBrand(pool, input.brandId, async (client) => {
      const gone = await client.query('delete from app.brand_document where brand_id = $1 and id = $2', [
        input.brandId,
        input.documentId,
      ])
      if (gone.rowCount === 0) throw new AppError(404, 'not_found', 'There is nothing at this address.')
      await deps.audit.record(
        {
          action: 'onboarding.document_deleted',
          actor: input.actorId,
          brandId: input.brandId,
          subject: input.documentId,
          outcome: 'success',
          detail: { documentId: input.documentId },
        },
        client,
      )
    })
  } catch (error) {
    // A research source still points at it (the foreign key from research_source).
    if ((error as { code?: string }).code === '23503') {
      throw new AppError(409, 'document_in_use', 'Research has used this document, so it cannot be deleted.')
    }
    throw error
  }
}

// The bytes of a document the job lists in its input, in the job's own brand; nothing else is readable.
export async function readJobDocument(
  client: PoolClient,
  input: { jobId: string; brandId: string; documentId: string },
): Promise<{ mediaType: string; bytes: Buffer }> {
  const found = await client.query<{ media_type: string; bytes: Buffer }>(
    `select d.media_type, d.bytes
       from app.job_input j
       join app.brand_document d on d.brand_id = j.brand_id
      where j.job_id = $1 and j.brand_id = $2 and d.id = $3
        and jsonb_typeof(j.input -> 'documentIds') = 'array'
        and j.input -> 'documentIds' ? $3::text`,
    [input.jobId, input.brandId, input.documentId],
  )
  const row = found.rows[0]
  if (!row) throw new AppError(404, 'not_found', 'There is nothing at this address.')
  return { mediaType: row.media_type, bytes: row.bytes }
}
