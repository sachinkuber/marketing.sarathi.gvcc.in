import { AppError } from '../errors.ts'
import { splitPdf, type PdfLimits } from './pdf-parts.ts'

// The child process of a PDF split (see splitPdfOneAtATime): it reads one request, runs the split and answers once.
// Whatever it holds is dropped with the process, so a hostile PDF can only cost this process.
interface Request {
  bytes: Uint8Array
  limits: PdfLimits
  deadlineMs?: number
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
            : { status: 422, code: 'pdf_unreadable', message: 'This PDF could not be opened.' },
      }),
    )
    .then((answer) => {
      // Exit once the answer has been handed over.
      if (process.send === undefined) process.exit(1)
      process.send(answer, () => process.exit(0))
    })
})
