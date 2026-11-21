import { PDFDocument, PDFName } from 'pdf-lib'
import { AppError } from '../errors.ts'

// The AI reads one PDF part at a time, so a large PDF is cut into runs of whole pages that each fit its limits.
export interface PdfLimits {
  maxBytes: number
  maxPages: number
}
export interface PdfPart {
  firstPage: number
  lastPage: number
  bytes: Buffer
}

const MB = 1_048_576
// What one split may hold in all, relative to the upload: copying a page copies the images it shares with other
// pages into every part, so a PDF whose pages share a large image would otherwise grow without bound.
const MIN_PARTS_TOTAL = 32 * MB
const SPLIT_DEADLINE_MS = 120_000
const unreadable = () =>
  new AppError(
    422,
    'pdf_unreadable',
    'This PDF could not be opened (it may be password-protected or damaged). Export it again without a password.',
  )

// A tenth of a megabyte, rounded up, so a page just over the limit never reads as exactly the limit.
const megabytes = (bytes: number): string => `${Math.ceil((bytes / MB) * 10) / 10}`

// Lets the server answer other requests between the heavy steps of a split.
const breathe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export interface SplitOptions {
  // For tests: the clock, and how long a split may take.
  now?: () => number
  deadlineMs?: number
}

const tooComplex = (message: string) => new AppError(422, 'pdf_too_complex', message)

async function load(bytes: Buffer): Promise<PDFDocument> {
  try {
    const source = await PDFDocument.load(bytes)
    if (source.getPageCount() === 0) throw unreadable()
    return source
  } catch (error) {
    throw error instanceof AppError ? error : unreadable()
  }
}

// [] when the PDF is within both limits. Otherwise whole pages are packed greedily, each part as long as the limits
// allow. A part's size is only known once it is saved, so the length of each part is found by saving candidates.
export async function splitPdf(
  bytes: Buffer,
  limits: PdfLimits,
  options: SplitOptions = {},
): Promise<PdfPart[]> {
  try {
    return await split(bytes, limits, options)
  } catch (error) {
    // Whatever pdf-lib fails with on a file it cannot work with is the owner's file being unreadable.
    throw error instanceof AppError ? error : unreadable()
  }
}

async function split(bytes: Buffer, limits: PdfLimits, options: SplitOptions): Promise<PdfPart[]> {
  const now = options.now ?? Date.now
  const deadline = options.deadlineMs ?? SPLIT_DEADLINE_MS
  const started = now()
  const source = await load(bytes)
  const total = source.getPageCount()
  if (bytes.length <= limits.maxBytes && total <= limits.maxPages) return []

  // The copier deep-copies everything a page reaches, and a link's destination is another page: with its
  // annotations a page drags in the page it points to. The parts keep no links; the stored original does.
  for (const page of source.getPages()) {
    for (const key of ['Annots', 'B', 'AA']) page.node.delete(PDFName.of(key))
  }
  const partsLimit = Math.max(2 * bytes.length, MIN_PARTS_TOTAL)
  let partsTotal = 0

  // Pages `from` to `from + count - 1` (zero-based) as a PDF of their own.
  const save = async (from: number, count: number): Promise<Buffer> => {
    const part = await PDFDocument.create()
    const pages = await part.copyPages(
      source,
      Array.from({ length: count }, (_, i) => from + i),
    )
    for (const page of pages) part.addPage(page)
    await breathe()
    return Buffer.from(await part.save({ useObjectStreams: false }))
  }
  const averagePage = bytes.length / total

  const parts: PdfPart[] = []
  let from = 0
  while (from < total) {
    if (now() - started > deadline) {
      throw tooComplex(
        'This PDF took too long to prepare for the AI. Export it again with fewer or smaller images, or as smaller files.',
      )
    }
    const cap = Math.min(limits.maxPages, total - from)
    // The longest run of pages from `from` that saves within maxBytes: `fits` is the largest length known to
    // fit, `fails` the smallest known not to. Start from the average page size, then double or halve.
    let fits = 0
    let fails = cap + 1
    let best: Buffer | null = null
    let single = 0
    let guess = Math.min(cap, Math.max(1, Math.floor(limits.maxBytes / averagePage)))
    while (fails - fits > 1) {
      const count = guess
      const saved = await save(from, count)
      if (count === 1) single = saved.length
      if (saved.length <= limits.maxBytes) {
        fits = count
        best = saved
      } else {
        fails = count
      }
      guess = fails > cap ? Math.min(cap, fits * 2) : Math.floor((fits + fails) / 2)
    }
    if (best === null) {
      throw new AppError(
        422,
        'page_too_large',
        `Page ${from + 1} is ${megabytes(single)} MB on its own; the limit for one page is ${limits.maxBytes / MB} MB. Export the PDF with smaller images.`,
      )
    }
    partsTotal += best.length
    if (partsTotal > partsLimit) {
      throw tooComplex(
        `This PDF's pages share large images, so preparing it for the AI would need ${Math.ceil(partsTotal / MB)} MB. Export it again with compressed images, or as smaller files.`,
      )
    }
    parts.push({ firstPage: from + 1, lastPage: from + fits, bytes: best })
    from += fits
  }
  return parts
}

// One split at a time in this process: splitting holds a whole PDF and its parts in memory.
let queue: Promise<unknown> = Promise.resolve()
export function splitPdfOneAtATime(
  bytes: Buffer,
  limits: PdfLimits,
  options?: SplitOptions,
): Promise<PdfPart[]> {
  const run = queue.then(() => splitPdf(bytes, limits, options))
  queue = run.catch(() => undefined)
  return run
}
