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

// Research is open while its run is still going (created or running) and any group, or the merge, is waiting or
// running. A run that has ended (failed, succeeded, cancelled) is settled whatever its parts say: when every
// group died no merge job was made, and its "waiting" would otherwise be waited on for ever.
export function isOpen(
  research: { state: string; groups: { state: GroupState }[]; merge: GroupState } | null,
): boolean {
  if (!research) return false
  if (research.state !== 'created' && research.state !== 'running') return false
  const open = (s: GroupState) => s === 'waiting' || s === 'running'
  return research.groups.some((g) => open(g.state)) || open(research.merge)
}

export const OWNER_ONLY = 'Only the platform owner can use onboarding.'

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403
}

// The draft profile's four topics, a fixed mapping of the profile keys (R38), and the plain name of each key.
export const TOPICS: { heading: string; keys: string[] }[] = [
  {
    heading: 'The business',
    keys: [
      'business_name',
      'what_they_sell',
      'main_products',
      'places_served',
      'price_position',
      'certifications',
      'contact_points',
    ],
  },
  { heading: 'Customers and voice', keys: ['audiences', 'tone_of_voice', 'differentiators'] },
  { heading: 'Online presence', keys: ['social_presence', 'search_visibility', 'ai_answer_visibility'] },
  { heading: 'Competitors', keys: ['competitors'] },
]

export const KEY_LABEL: Record<string, string> = {
  business_name: 'Business name',
  what_they_sell: 'What they sell',
  main_products: 'Main products',
  places_served: 'Places served',
  price_position: 'Price position',
  certifications: 'Certifications',
  contact_points: 'Contact points',
  audiences: 'Audiences',
  tone_of_voice: 'Tone of voice',
  differentiators: 'What sets them apart',
  social_presence: 'Social presence',
  search_visibility: 'Search visibility',
  ai_answer_visibility: 'AI answer visibility',
  competitors: 'Competitors',
}

// The safety rule kinds in plain words (M8's kinds, as the facts and rules screen shows and asks for them).
export const RULE_KIND_WORD: Record<string, string> = {
  forbidden_topic: 'topic never to discuss',
  forbidden_claim: 'forbidden claim',
  forbidden_word: 'word never to use',
  competitor_not_named: 'competitor not to name',
  tone_limit: 'tone limit',
  pause_dates: 'pause dates',
}

// A date as the screens show it: "1 Jan 2027". Dates of record (a review date) are calendar days, read as such.
export const dayOn = (iso: string): string =>
  new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: iso.length === 10 ? 'UTC' : 'Asia/Kolkata',
  })

// The first day a review date may have: tomorrow, UTC, as the core counts it.
export const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)

// What kind of thing a source is, in a word or two.
export const SOURCE_KIND_WORD: Record<string, string> = {
  site: 'Your site',
  document: 'Document',
  social: 'Social',
  search: 'Search',
  competitor: 'Competitor page',
  owner_statement: 'Stated by you',
}

// failureWords, except that a refused field says what is wrong with it: the core's per-field messages.
export function refusalWords(error: unknown, otherwise: string): string {
  if (error instanceof ApiError && error.code === 'invalid_request' && Array.isArray(error.details)) {
    const messages = (error.details as { message?: unknown }[])
      .map((d) => (typeof d.message === 'string' ? d.message : ''))
      .filter((m) => m !== '')
    if (messages.length > 0) return messages.join(' ')
  }
  return failureWords(error, otherwise)
}
