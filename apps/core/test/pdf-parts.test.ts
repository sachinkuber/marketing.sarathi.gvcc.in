import { spawn, type ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { splitPdf, splitPdfOneAtATime, type SplitChildOptions } from '../src/onboarding/pdf-parts.ts'
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

  it('pages that all draw one large shared image are refused as too complex, not stored as many large parts', async () => {
    // 60 pages sharing a 7.9 MB image: every part carries its own copy of it.
    const source = await pdfOf(60, { sharedImage: Math.floor(7.9 * MB) })
    const error = await splitPdf(source, { maxBytes: 8 * MB, maxPages: 10 }).catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 422, code: 'pdf_too_complex' })
    expect((error as Error).message).toMatch(
      /^This PDF's pages share large images, so preparing it for the AI would need \d+ MB\. Export it again with compressed images, or as smaller files\.$/,
    )
  }, 60_000)

  it('a split that passes its deadline is refused as too complex', async () => {
    const source = await pdfOf(Array.from({ length: 12 }, () => 3 * MB))
    let clock = 0
    const slow = { now: () => (clock += 1000), deadlineMs: 1500 }
    await expect(splitPdf(source, limits, slow)).rejects.toMatchObject({
      status: 422,
      code: 'pdf_too_complex',
      message:
        'This PDF took too long to prepare for the AI. Export it again with fewer or smaller images, or as smaller files.',
    })
  }, 60_000)

  it('links between pages do not pull the pages they point to into a part', async () => {
    const source = await pdfOf(
      Array.from({ length: 6 }, () => 3 * MB),
      { linkFirstToLast: true },
    )
    const parts = await splitPdf(source, limits)
    expect(parts[0]!.bytes.length).toBeLessThan(6.5 * MB)
    let next = 1
    for (const part of parts) {
      expect(part.firstPage).toBe(next)
      expect(await pageCountOf(part.bytes)).toBe(part.lastPage - part.firstPage + 1)
      next = part.lastPage + 1
    }
    expect(next).toBe(7)
    expect(parts[0]!.lastPage).toBe(2)
  }, 60_000)
})

// A stand-in child that runs a one-line script of its own, so the tests control how the child behaves.
const scripted =
  (code: string, seen: ChildProcess[] = []): NonNullable<SplitChildOptions['fork']> =>
  () => {
    const child = spawn(process.execPath, ['-e', code], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    })
    seen.push(child)
    return child
  }
const unreadableMessage =
  'This PDF could not be opened (it may be password-protected or damaged). Export it again without a password.'
const exited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

describe('splitPdfOneAtATime (child process)', () => {
  it('a split runs outside the core process', async () => {
    const { fork } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const pids: (number | undefined)[] = []
    const real: NonNullable<SplitChildOptions['fork']> = (path, args, options) => {
      const child = fork(path, args, options)
      pids.push(child.pid)
      return child
    }
    const source = await pdfOf(250, { text: true })
    const parts = await splitPdfOneAtATime(source, limits, { fork: real })
    expect(parts.map((p) => [p.firstPage, p.lastPage])).toEqual([
      [1, 100],
      [101, 200],
      [201, 250],
    ])
    expect(Buffer.isBuffer(parts[0]!.bytes)).toBe(true)
    expect(await pageCountOf(parts[2]!.bytes)).toBe(50)
    expect(pids).toHaveLength(1)
    expect(pids[0]).toBeTypeOf('number')
    expect(pids[0]).not.toBe(process.pid)
    expect(fileURLToPath(new URL('../src/onboarding/pdf-split-child.ts', import.meta.url))).toMatch(/\.ts$/)
  }, 60_000)

  it('the real child gives the same refusals as the split', async () => {
    await expect(splitPdfOneAtATime(ENCRYPTED_PDF, limits)).rejects.toMatchObject({
      status: 422,
      code: 'pdf_unreadable',
      message: unreadableMessage,
    })
    const source = await pdfOf([1 * MB, 9 * MB, 1 * MB])
    await expect(splitPdfOneAtATime(source, limits)).rejects.toMatchObject({
      status: 422,
      code: 'page_too_large',
    })
    expect(await splitPdfOneAtATime(await pdfOf([0, 0, 0]), limits)).toEqual([])
  }, 60_000)

  it('a child that dies gives pdf_unreadable and the next split still works', async () => {
    const seen: ChildProcess[] = []
    const source = await pdfOf(Array.from({ length: 12 }, () => 3 * MB))
    await expect(
      splitPdfOneAtATime(source, limits, {
        fork: scripted('process.on("message",()=>process.exit(137))', seen),
      }),
    ).rejects.toMatchObject({ status: 422, code: 'pdf_unreadable', message: unreadableMessage })
    expect(exited(seen[0]!)).toBe(true)
    expect(seen[0]!.listenerCount('message')).toBe(0)
    expect((await splitPdfOneAtATime(source, limits)).length).toBeGreaterThan(1)
  }, 60_000)

  it('a child that sends a malformed answer is treated like one that died', async () => {
    const seen: ChildProcess[] = []
    await expect(
      splitPdfOneAtATime(Buffer.from('x'), limits, {
        fork: scripted('process.on("message",()=>{process.send("junk");setInterval(()=>{},1000)})', seen),
      }),
    ).rejects.toMatchObject({ status: 422, code: 'pdf_unreadable' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(exited(seen[0]!)).toBe(true)
    expect((await splitPdfOneAtATime(await pdfOf([0, 0, 0]), limits)).length).toBe(0)
  }, 60_000)

  it('a split past its deadline is killed and gives pdf_too_complex', async () => {
    const seen: ChildProcess[] = []
    const started = Date.now()
    await expect(
      splitPdfOneAtATime(Buffer.from('x'), limits, {
        deadlineMs: 100,
        killGraceMs: 200,
        fork: scripted('process.on("message",()=>{});setInterval(()=>{},1000)', seen),
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'pdf_too_complex',
      message:
        'This PDF took too long to prepare for the AI. Export it again with fewer or smaller images, or as smaller files.',
    })
    expect(Date.now() - started).toBeLessThan(5000)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(exited(seen[0]!)).toBe(true)
    // The queue carries on.
    expect(await splitPdfOneAtATime(await pdfOf([0, 0, 0]), limits)).toEqual([])
  }, 60_000)
})
