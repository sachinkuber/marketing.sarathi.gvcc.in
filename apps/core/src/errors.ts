import type { ErrorRequestHandler, RequestHandler, Response } from 'express'
import type { Logger } from 'pino'
import { captureError } from '@mkt/shared'
import { AppError } from './app-error.ts'

export { AppError }

function send(res: Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } })
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  send(res, 404, 'not_found', 'There is nothing at this address.')
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err)
      return
    }
    if (err instanceof AppError) {
      send(res, err.status, err.code, err.message, err.details)
      return
    }
    const type = (err as { type?: string }).type
    if (type === 'entity.parse.failed') {
      send(res, 400, 'invalid_json', 'The request body is not valid JSON.')
      return
    }
    if (type === 'encoding.unsupported') {
      send(res, 415, 'unsupported_encoding', 'The request body encoding is not supported.')
      return
    }
    if (type === 'entity.too.large') {
      send(res, 413, 'payload_too_large', 'The request body is too large.')
      return
    }
    logger.error({ err, requestId: req.id }, 'unhandled error')
    captureError(err)
    send(res, 500, 'internal_error', 'Something went wrong.')
  }
}
