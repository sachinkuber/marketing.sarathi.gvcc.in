import { fork as forkProcess, type ChildProcess, type ForkOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Logger } from 'pino'
import { PDFDocument, PDFName } from 'pdf-lib'
import { AppError } from '../app-error.ts'

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
export const unreadable = () =>
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
const tookTooLong = () =>
  tooComplex(
    'This PDF took too long to prepare for the AI. Export it again with fewer or smaller images, or as smaller files.',
  )
// A child that ended without an answer: killed (often out of memory), crashed, or sent nonsense.
const unprepared = () =>
  new AppError(
    422,
    'pdf_unreadable',
    'This PDF could not be prepared. It may be damaged, or too large to prepare at once. Export it again, or as smaller files.',
  )

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
      throw tookTooLong()
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

export interface SplitChildOptions {
  // For tests: how long the split may take, how long the parent waits after that before killing the child,
  // and the function that starts the child.
  deadlineMs?: number
  killGraceMs?: number
  fork?: (modulePath: string, args: string[], options: ForkOptions) => ChildProcess
  // Where a child that ends without an answer is reported (its own output goes to the container log).
  logger?: Pick<Logger, 'warn'>
}

const KILL_GRACE_MS = 5_000
// How long an exited child's channel may take to close before the split gives up on its answer (M3).
const EXIT_DRAIN_MS = 1_000
// The heap of the child only; Buffers are outside it. The container's own limit stops the rest, and the core
// outlives a child the container kills (the split then answers pdf_unreadable).
const CHILD_ARGS = ['--max-old-space-size=512']
const CHILD_PATH = fileURLToPath(new URL('./pdf-split-child.ts', import.meta.url))

type Answer = { parts: PdfPart[] } | { error: { status: number; code: string; message: string } }

function asAnswer(value: unknown): Answer | null {
  if (typeof value !== 'object' || value === null) return null
  const { parts, error } = value as { parts?: unknown; error?: unknown }
  if (Array.isArray(parts)) {
    const whole = parts.every(
      (p: unknown) =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as PdfPart).firstPage === 'number' &&
        typeof (p as PdfPart).lastPage === 'number' &&
        (p as PdfPart).bytes instanceof Uint8Array,
    )
    if (!whole) return null
    return {
      parts: (parts as PdfPart[]).map((p) => ({
        firstPage: p.firstPage,
        lastPage: p.lastPage,
        bytes: Buffer.from(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength),
      })),
    }
  }
  if (typeof error === 'object' && error !== null) {
    const e = error as { status?: unknown; code?: unknown; message?: unknown }
    if (typeof e.status === 'number' && typeof e.code === 'string' && typeof e.message === 'string') {
      return { error: { status: e.status, code: e.code, message: e.message } }
    }
  }
  return null
}

// The split runs in a child process of its own, with a memory limit and a time limit, so a PDF that is hostile or
// huge costs the child and not the core (R17, R19). One child per split.
function splitInChild(bytes: Buffer, limits: PdfLimits, options: SplitChildOptions): Promise<PdfPart[]> {
  const deadlineMs = options.deadlineMs ?? SPLIT_DEADLINE_MS
  const start = options.fork ?? forkProcess
  return new Promise<PdfPart[]>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = start(CHILD_PATH, [], {
        execArgv: CHILD_ARGS,
        serialization: 'advanced',
        // Only what the split needs: no secrets and no NODE_OPTIONS from the core's environment.
        env: process.env.NODE_ENV === undefined ? {} : { NODE_ENV: process.env.NODE_ENV },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      })
    } catch {
      reject(
        new AppError(
          503,
          'pdf_split_unavailable',
          'The server could not start reading this PDF. Try again in a minute.',
        ),
      )
      return
    }
    let done = false
    let drain: ReturnType<typeof setTimeout> | undefined
    const finish = (settle: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(drain)
      child.off('message', onMessage)
      child.off('exit', onExit)
      child.off('disconnect', onDisconnect)
      child.off('error', onError)
      // A child that has not exited is killed; one that has is already reaped. A late error is swallowed.
      child.on('error', () => undefined)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      settle()
    }
    const died = (how: Record<string, unknown>): void =>
      finish(() => {
        options.logger?.warn(how, 'the PDF split child ended without an answer')
        reject(unprepared())
      })
    const ended = (): Record<string, unknown> => ({ exitCode: child.exitCode, signalCode: child.signalCode })
    function onMessage(value: unknown): void {
      const answer = asAnswer(value)
      if (answer === null) return died({ malformed: true })
      finish(() => {
        if ('parts' in answer) resolve(answer.parts)
        else reject(new AppError(answer.error.status, answer.error.code, answer.error.message))
      })
    }
    // The exit can be reported before the child's last message has been read from the channel. So an exit counts
    // as a death only once the channel has closed (every message in it has been read by then), or after a short
    // drain if the channel never says so.
    const exitedNow = (): boolean => child.exitCode !== null || child.signalCode !== null
    function onExit(): void {
      if (!child.connected) return died(ended())
      drain = setTimeout(() => died(ended()), EXIT_DRAIN_MS)
    }
    function onDisconnect(): void {
      if (exitedNow()) died(ended())
    }
    function onError(error: Error): void {
      died({ error: error.message })
    }
    child.on('message', onMessage)
    child.on('exit', onExit)
    child.on('disconnect', onDisconnect)
    child.on('error', onError)
    const timer = setTimeout(
      () => finish(() => reject(tookTooLong())),
      deadlineMs + (options.killGraceMs ?? KILL_GRACE_MS),
    )
    // A child that is already gone makes send fail through the error event or the callback.
    try {
      child.send({ bytes, limits, deadlineMs }, (error) => {
        if (error) died({ error: error.message })
      })
    } catch (error) {
      died({ error: error instanceof Error ? error.message : 'send failed' })
    }
  })
}

// One split at a time in this process: splitting holds a whole PDF and its parts in memory.
let queue: Promise<unknown> = Promise.resolve()
export function splitPdfOneAtATime(
  bytes: Buffer,
  limits: PdfLimits,
  options: SplitChildOptions = {},
): Promise<PdfPart[]> {
  const run = queue.then(() => splitInChild(bytes, limits, options))
  queue = run.catch(() => undefined)
  return run
}
