import { writeFileSync } from 'node:fs'
import { AppError } from '../app-error.ts'
import { splitPdf, unreadable, type PdfLimits } from './pdf-parts.ts'

// The child process of a PDF split (see splitPdfOneAtATime): it reads one request, runs the split and answers once.
// Whatever it holds is dropped with the process, so a hostile PDF can only cost this process.
interface Request {
  bytes: Uint8Array
  limits: PdfLimits
  deadlineMs?: number
}

// Best effort: if the container runs out of memory, the kernel picks this process before the core.
try {
  writeFileSync('/proc/self/oom_score_adj', '1000')
} catch {
  // Not Linux, or not allowed: the split carries on.
}

process.once('message', (message: Request) => {
  const bytes = Buffer.from(message.bytes.buffer, message.bytes.byteOffset, message.bytes.byteLength)
  const options = message.deadlineMs === undefined ? {} : { deadlineMs: message.deadlineMs }
  splitPdf(bytes, message.limits, options)
    .then(
      (parts) => ({ parts }),
      (error: unknown) => ({
        error:
          error instanceof AppError
            ? { status: error.status, code: error.code, message: error.message }
            : { status: 422, code: 'pdf_unreadable', message: unreadable().message },
      }),
    )
    .then((answer) => {
      // Exit once the answer has been handed over.
      if (process.send === undefined) process.exit(1)
      process.send(answer, () => process.exit(0))
    })
})
