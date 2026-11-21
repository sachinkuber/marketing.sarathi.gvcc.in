// The application's error with a status and a code. It has no imports, so a process that only needs it (the PDF
// split child) does not load the rest of core.
export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }
}
