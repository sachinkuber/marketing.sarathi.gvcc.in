import { ApiError } from '../api/client'

// Words and figures shared by the three onboarding screens.

export type GroupState = 'waiting' | 'running' | 'done' | 'failed'

export const STATE_WORD: Record<GroupState, string> = {
  waiting: 'Waiting',
  running: 'Reading',
  done: 'Done',
  failed: 'Could not be read',
}

export const GROUP_NAME: Record<string, string> = {
  site: 'Website',
  social: 'Social profiles',
  visibility: 'Search visibility',
  competitors: 'Competitors',
  documents: 'Documents',
}

export const RESULT_WORD: Record<string, string> = {
  read: 'Read',
  blocked: 'Blocked',
  empty: 'Empty',
  error: 'Error',
  stated: 'Stated by the owner',
}

export const DOCUMENT_LIMITS =
  'PDF up to 100 MB (large PDFs are prepared for the AI automatically), images up to 5 MB, 20 files, 500 MB in all'

// Millionths as a string, to two decimals, rounded half up, with no floating point.
function twoDecimals(micros: string, locale: string): string {
  const cents = (BigInt(micros) + 5000n) / 10000n
  const whole = (cents / 100n).toLocaleString(locale)
  return `${whole}.${(cents % 100n).toString().padStart(2, '0')}`
}

export function costWords(cost: { usdMicros: string | null; inrMicros: string | null }): string {
  if (cost.usdMicros === null || cost.inrMicros === null) return 'cost not known yet'
  return `$${twoDecimals(cost.usdMicros, 'en-US')} · ₹${twoDecimals(cost.inrMicros, 'en-IN')}`
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function groupLine(g: {
  searches: number
  fetches: number
  cost: { usdMicros: string | null; inrMicros: string | null }
}): string {
  return [count(g.searches, 'search', 'searches'), count(g.fetches, 'page', 'pages'), costWords(g.cost)].join(
    ' · ',
  )
}

// What the core says is used as it is: it already writes plain, how-to-fix messages. A code is mapped only
// when no message came.
const FALLBACK: Record<string, string> = {
  intake_needed: 'Save the website first, then start research.',
  research_running: 'Research is already running for this brand. Wait for it to finish.',
  agent_unavailable: 'The research agent is not available right now. Try again in a few minutes.',
  too_large: 'This file is over the size limit. Use a smaller file, then upload it again.',
  unsupported_type: 'Upload a PDF, PNG, JPEG or WebP file.',
  too_many_documents: 'This brand already has 20 files. Remove one, then upload again.',
  brand_storage_full: 'This brand has used its 500 MB. Remove a file, then upload again.',
  file_name: 'Rename the file to 200 characters or fewer, then upload it again.',
  page_too_large: 'A page of this PDF is too large. Export the PDF again at a lower quality, then upload it.',
  pdf_unreadable: 'This PDF cannot be read. Export it again from the original, then upload it.',
  pdf_too_complex: 'This PDF is too complex to prepare. Export it again as a simpler PDF, then upload it.',
  document_in_use: 'Research has read this file, so it cannot be removed.',
}

export function failureWords(error: unknown, otherwise: string): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'The platform could not be reached. Check your connection and try again.'
    if (error.status === 403) return OWNER_ONLY
    // The core's own message when it sent one; the client's stand-in text ('The request failed.') is not one.
    if (error.code !== 'error' && error.code !== 'bad_reply' && error.message) return error.message
    if (FALLBACK[error.code]) return FALLBACK[error.code]!
    // No usable JSON came back: a proxy or the network answered instead of the core.
    if (error.status === 413)
      return 'This file is over the size limit: PDF up to 100 MB, images up to 5 MB. Use a smaller file, then upload it again.'
    if (error.status === 408 || error.status === 502 || error.status === 504)
      return 'The upload took too long or was cut off. Check your connection, then upload again.'
    if (error.status >= 500)
      return 'The platform had a problem with this request. Wait a minute, then try again.'
    if (error.status >= 400)
      return 'The platform did not accept this request. Reload the page, then try again.'
    return otherwise
  }
  return otherwise
}

export function megabytes(bytes: number): string {
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} kB`
}

// Research is open while any group, or the merge, is waiting or running.
export function isOpen(research: { groups: { state: GroupState }[]; merge: GroupState } | null): boolean {
  if (!research) return false
  const open = (s: GroupState) => s === 'waiting' || s === 'running'
  return research.groups.some((g) => open(g.state)) || open(research.merge)
}

export const OWNER_ONLY = 'Only the platform owner can use onboarding.'

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403
}
