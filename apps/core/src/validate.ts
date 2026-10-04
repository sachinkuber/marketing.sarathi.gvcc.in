import type { RequestHandler, Response } from 'express'
import type { z } from 'zod'
import { AppError } from './errors.ts'

interface Schemas {
  params?: z.ZodType
  query?: z.ZodType
  body?: z.ZodType
}

// Every schema passed here is written with z.strictObject, so an unknown field is an error.
export function validate(schemas: Schemas): RequestHandler {
  return (req, res, next) => {
    const parsedParts: Record<string, unknown> = {}
    const issues: { part: string; path: string; message: string }[] = []
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part]
      if (!schema) continue
      const result = schema.safeParse(req[part])
      if (result.success) {
        parsedParts[part] = result.data
      } else {
        for (const issue of result.error.issues) {
          issues.push({ part, path: issue.path.join('.'), message: issue.message })
        }
      }
    }
    if (issues.length > 0) throw new AppError(400, 'invalid_request', 'The request is not valid.', issues)
    res.locals.input = parsedParts
    next()
  }
}

export function inputOf<T>(res: Response): T {
  return res.locals.input as T
}
