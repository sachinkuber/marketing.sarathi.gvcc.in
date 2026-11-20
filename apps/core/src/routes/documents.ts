import express, { type RequestHandler } from 'express'
import type { Pool } from '@mkt/db'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { principalOf } from '../auth/session.ts'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'
import {
  deleteDocument,
  isDocumentType,
  listDocuments,
  MAX_FILE_NAME,
  PDF_LIMIT,
  tooLargeMessage,
  uploadDocument,
  type DocumentType,
} from '../onboarding/documents.ts'
import { inputOf, validate } from '../validate.ts'

export interface DocumentRouteDeps {
  pool: Pool
  audit: AuditSink
}

const brandParams = z.strictObject({ brandId: z.uuid() })
const documentParams = z.strictObject({ brandId: z.uuid(), documentId: z.uuid() })

// The upload is the file's own bytes. Its type is the Content-Type header, and its name is the X-File-Name
// header, percent-encoded (a header cannot carry every character of a file name).
const fileNameOf = (req: express.Request): string => {
  const raw = req.headers['x-file-name']
  let name: string
  try {
    name = typeof raw === 'string' ? decodeURIComponent(raw).trim() : ''
  } catch {
    name = ''
  }
  // Control characters include U+0000, which a text column rejects.
  // eslint-disable-next-line no-control-regex
  if (name === '' || name.length > MAX_FILE_NAME || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AppError(
      400,
      'file_name',
      `Send the file name in the X-File-Name header, URL-encoded, 1 to ${MAX_FILE_NAME} characters.`,
    )
  }
  return name
}

const mediaTypeOf = (req: express.Request): DocumentType => {
  const declared = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
  if (!isDocumentType(declared)) {
    throw new AppError(415, 'unsupported_type', 'Upload a PDF, PNG, JPEG or WebP file.')
  }
  return declared
}

// The raw parser reads one byte past the PDF limit, so a file over the limit is measured and named by the
// route; a body past even that is turned away by the parser, and that error is given the same words.
const readBytes = express.raw({ type: () => true, limit: PDF_LIMIT + 1, inflate: false })
const rawBody: RequestHandler = (req, res, next) => {
  const type = mediaTypeOf(req)
  fileNameOf(req)
  readBytes(req, res, (error?: unknown) => {
    if ((error as { type?: string } | undefined)?.type === 'entity.too.large') {
      const length = Number(req.headers['content-length'])
      next(new AppError(413, 'too_large', tooLargeMessage(type, Number.isFinite(length) ? length : null)))
      return
    }
    next(error)
  })
}

export function registerDocumentRoutes(table: RouteTable, deps: DocumentRouteDeps): void {
  // The global JSON parser (100 kB) skips exactly this request (see app.ts). The body parser runs here, after
  // the person's permission for the brand has been checked.
  table.add({
    method: 'post',
    path: '/brands/:brandId/onboarding/documents',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary:
      'Upload a brand document (PDF up to 100 MB; PNG, JPEG or WebP up to 5 MB; 20 per brand, 500 MB in all) as the raw body',
    handlers: [
      validate({ params: brandParams }),
      rawBody,
      async (req, res) => {
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
        const made = await uploadDocument(deps.pool, deps, {
          brandId: brandContextOf(res).brandId,
          actorId: principalOf(res).userId,
          fileName: fileNameOf(req),
          mediaType: mediaTypeOf(req),
          bytes,
        })
        res.status(201).json(made)
      },
    ],
  })

  table.add({
    method: 'get',
    path: '/brands/:brandId/onboarding/documents',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary: "The brand's uploaded documents, newest first, without their bytes",
    handlers: [
      validate({ params: brandParams }),
      async (_req, res) => {
        res.json({ documents: await listDocuments(deps.pool, brandContextOf(res).brandId) })
      },
    ],
  })

  table.add({
    method: 'delete',
    path: '/brands/:brandId/onboarding/documents/:documentId',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary: 'Delete a brand document that no research source refers to',
    handlers: [
      validate({ params: documentParams }),
      async (_req, res) => {
        const { params } = inputOf<{ params: z.infer<typeof documentParams> }>(res)
        await deleteDocument(deps.pool, deps, {
          brandId: brandContextOf(res).brandId,
          documentId: params.documentId,
          actorId: principalOf(res).userId,
        })
        res.status(204).end()
      },
    ],
  })
}
