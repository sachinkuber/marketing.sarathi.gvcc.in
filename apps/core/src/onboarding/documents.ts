import { createHash } from 'node:crypto'
import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'
import { splitPdfOneAtATime, type PdfPart } from './pdf-parts.ts'
import { researchRunIsOpen } from './runs.ts'

// Brand documents (spec 13, test 51). The size limits are the owner's decision (a PDF up to 100 MB, which
// supersedes the spec's 10 MB) and match migration 0026's check.
export const MEDIA_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const
export type DocumentType = (typeof MEDIA_TYPES)[number]

const MB = 1_048_576
export const PDF_LIMIT = 100 * MB
export const IMAGE_LIMIT = 5 * MB
export const MAX_DOCUMENTS = 20
export const BRAND_STORAGE_LIMIT = 500 * MB
export const MAX_FILE_NAME = 200
// What the AI reads in one piece: a PDF over either limit is stored with parts that are within both.
export const PART_LIMITS = { maxBytes: 8 * MB, maxPages: 100 } as const

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
  // The parts the AI reads (0 when the document is read whole).
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
  // Every PDF is opened here, so an unreadable one is refused whatever its size. This runs before the transaction:
  // the brand's onboarding row is not held while a large PDF is split, and a refused split has stored nothing.
  const parts = mediaType === 'application/pdf' ? await splitPdfOneAtATime(bytes, PART_LIMITS) : []

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
    await storeParts(client, input.brandId, id, parts)
    await deps.audit.record(
      {
        action: 'onboarding.document_uploaded',
        actor: input.actorId,
        brandId: input.brandId,
        subject: id,
        outcome: 'success',
        detail: { documentId: id, sizeBytes: bytes.length, mediaType, parts: parts.length },
      },
      client,
    )
    return { id, fileName: input.fileName, mediaType, sizeBytes: bytes.length, sha256, parts: parts.length }
  })
}

async function storeParts(
  client: PoolClient,
  brandId: string,
  documentId: string,
  parts: PdfPart[],
): Promise<void> {
  for (const [i, part] of parts.entries()) {
    await client.query(
      `insert into app.brand_document_part (brand_id, document_id, part_no, first_page, last_page, bytes, size_bytes, sha256)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        brandId,
        documentId,
        i + 1,
        part.firstPage,
        part.lastPage,
        part.bytes,
        part.bytes.length,
        createHash('sha256').update(part.bytes).digest('hex'),
      ],
    )
  }
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
      parts: number
    }>(
      `select d.id, d.file_name, d.media_type, d.size_bytes, d.sha256, d.uploaded_at,
              (select count(*)::int from app.brand_document_part p where p.brand_id = d.brand_id and p.document_id = d.id) as parts
         from app.brand_document d where d.brand_id = $1 order by d.uploaded_at desc, d.id`,
      [brandId],
    )
    return rows.map((r) => ({
      id: r.id,
      fileName: r.file_name,
      mediaType: r.media_type,
      sizeBytes: r.size_bytes,
      sha256: r.sha256,
      parts: r.parts,
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
      // The documents group reads the brand's files while research runs: a file deleted under it would fail the
      // group. The onboarding row is locked as starting research locks it, so a start and a delete do not cross.
      const onboarding = await client.query<{ research_run_id: string | null }>(
        'select research_run_id from app.onboarding where brand_id = $1 for update',
        [input.brandId],
      )
      const runId = onboarding.rows[0]?.research_run_id
      if (runId && (await researchRunIsOpen(client, runId))) {
        throw new AppError(
          409,
          'research_running',
          'Research is reading the brand’s documents. Wait for it to finish, then delete the file.',
        )
      }
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
      throw new AppError(
        409,
        'document_in_use',
        'Research has used this document, so it is kept with the research. Upload a new version instead of deleting this one.',
      )
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

// A document the job's input lists, in the job's own brand, with the parts the AI reads.
export interface JobDocument {
  id: string
  fileName: string
  mediaType: string
  sizeBytes: number
  parts: { partNo: number; firstPage: number; lastPage: number; sizeBytes: number }[]
}

export async function listJobDocuments(
  client: PoolClient,
  input: { jobId: string; brandId: string },
): Promise<JobDocument[]> {
  const found = await client.query<{
    id: string
    file_name: string
    media_type: string
    size_bytes: number
    parts: JobDocument['parts']
  }>(
    `select d.id, d.file_name, d.media_type, d.size_bytes,
            coalesce((select jsonb_agg(jsonb_build_object('partNo', p.part_no, 'firstPage', p.first_page,
                        'lastPage', p.last_page, 'sizeBytes', p.size_bytes) order by p.part_no)
                        from app.brand_document_part p where p.brand_id = d.brand_id and p.document_id = d.id),
                     '[]'::jsonb) as parts
       from app.job_input j
       join app.brand_document d on d.brand_id = j.brand_id
      where j.job_id = $1 and j.brand_id = $2
        and jsonb_typeof(j.input -> 'documentIds') = 'array'
        and j.input -> 'documentIds' ? d.id::text
      order by d.uploaded_at, d.id`,
    [input.jobId, input.brandId],
  )
  return found.rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    mediaType: r.media_type,
    sizeBytes: r.size_bytes,
    parts: r.parts,
  }))
}

// One part of a listed document.
export async function readJobDocumentPart(
  client: PoolClient,
  input: { jobId: string; brandId: string; documentId: string; partNo: number },
): Promise<{ firstPage: number; lastPage: number; bytes: Buffer }> {
  const found = await client.query<{ first_page: number; last_page: number; bytes: Buffer }>(
    `select p.first_page, p.last_page, p.bytes
       from app.job_input j
       join app.brand_document_part p on p.brand_id = j.brand_id
      where j.job_id = $1 and j.brand_id = $2 and p.document_id = $3 and p.part_no = $4
        and jsonb_typeof(j.input -> 'documentIds') = 'array'
        and j.input -> 'documentIds' ? $3::text`,
    [input.jobId, input.brandId, input.documentId, input.partNo],
  )
  const row = found.rows[0]
  if (!row) throw new AppError(404, 'not_found', 'There is nothing at this address.')
  return { firstPage: row.first_page, lastPage: row.last_page, bytes: row.bytes }
}
