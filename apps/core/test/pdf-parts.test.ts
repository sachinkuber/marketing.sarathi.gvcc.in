import { describe, expect, it } from 'vitest'
import { splitPdf } from '../src/onboarding/pdf-parts.ts'
import { ENCRYPTED_PDF, pageCountOf, pdfOf } from './pdf-fixtures.ts'

const MB = 1_048_576
const limits = { maxBytes: 8 * MB, maxPages: 100 } as const

describe('splitPdf', () => {
  it('a small PDF is not split', async () => {
    expect(await splitPdf(await pdfOf([0, 0, 0]), limits)).toEqual([])
  })

  it('a PDF of 12 pages of about 3 MB each splits into parts of at most 8 MB with whole pages in order', async () => {
    const source = await pdfOf(Array.from({ length: 12 }, () => 3 * MB))
    const parts = await splitPdf(source, limits)
    expect(parts.length).toBeGreaterThan(1)
    let next = 1
    for (const part of parts) {
      expect(part.firstPage).toBe(next)
      expect(part.bytes.length).toBeLessThanOrEqual(8 * MB)
      expect(await pageCountOf(part.bytes)).toBe(part.lastPage - part.firstPage + 1)
      next = part.lastPage + 1
    }
    expect(next).toBe(13)
    // Greedy: each part but the last holds as many pages as fit, here two (three would pass 8 MB).
    expect(parts.slice(0, -1).every((p) => p.lastPage - p.firstPage + 1 === 2)).toBe(true)
  }, 60_000)

  it('a 250-page text PDF splits into parts of at most 100 pages', async () => {
    const source = await pdfOf(250, { text: true })
    expect(source.length).toBeLessThan(8 * MB)
    const parts = await splitPdf(source, limits)
    expect(parts.map((p) => [p.firstPage, p.lastPage])).toEqual([
      [1, 100],
      [101, 200],
      [201, 250],
    ])
    expect(await pageCountOf(parts[2]!.bytes)).toBe(50)
  }, 60_000)

  it('one page over 8 MB is refused naming the page', async () => {
    const source = await pdfOf([1 * MB, 9 * MB, 1 * MB])
    await expect(splitPdf(source, limits)).rejects.toMatchObject({
      status: 422,
      code: 'page_too_large',
      message:
        'Page 2 is 9.1 MB on its own; the limit for one page is 8 MB. Export the PDF with smaller images.',
    })
  }, 60_000)

  it('an encrypted or garbage PDF is refused as pdf_unreadable', async () => {
    const message =
      'This PDF could not be opened (it may be password-protected or damaged). Export it again without a password.'
    for (const bytes of [
      ENCRYPTED_PDF,
      Buffer.from('%PDF-1.7\nthis is not a pdf at all'),
      Buffer.from('%PDF-'),
    ]) {
      await expect(splitPdf(bytes, limits)).rejects.toMatchObject({
        status: 422,
        code: 'pdf_unreadable',
        message,
      })
    }
  })
})
