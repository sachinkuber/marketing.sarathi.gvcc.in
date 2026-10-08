import { createHash } from 'node:crypto'
import { HASH_SCHEME, contentPayloadSchema, type ContentPayload } from '@mkt/shared'
import { PayloadRejected, normalisePayload } from './normalise.ts'

// JSON in the JSON Canonicalization Scheme (RFC 8785), for the values a payload can hold: strings, safe
// integers, booleans, arrays and objects. Keys are sorted by UTF-16 code unit (the default sort), there is no
// whitespace, and JSON.stringify writes strings the one way the scheme requires. A key whose value is
// undefined is left out; null and non-integers are refused.
export function canonicalise(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('only integers are allowed in a payload')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalise(record[key])}`).join(',')}}`
  }
  throw new Error('a payload cannot hold null or a value of this type')
}

export function hashCanonical(canonical: string): string {
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export interface PreparedVersion {
  payload: ContentPayload
  canonical: string
  hash: string
  hashScheme: typeof HASH_SCHEME
}

// The one place a content version's text and hash are made. The database recomputes the hash on insert.
export function prepareVersion(input: unknown): PreparedVersion {
  const parsed = contentPayloadSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new PayloadRejected(
      issue?.path.join('.') || '(payload)',
      issue?.message ?? 'is not a valid payload',
    )
  }
  const payload = normalisePayload(parsed.data)
  const canonical = canonicalise(payload)
  return { payload, canonical, hash: hashCanonical(canonical), hashScheme: HASH_SCHEME }
}
