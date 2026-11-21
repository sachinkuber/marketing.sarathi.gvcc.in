import type { SourceKind } from '@mkt/shared'

// The kinds of source an agent can read or an owner can give (database enum app.source_kind), from shared, so
// the facts and rules agent's input and the core name the same kinds.
export { SOURCE_KINDS, type SourceKind } from '@mkt/shared'

// What can stand behind a verified fact: the brand's own site, a document the owner uploaded, or the owner's
// own word. Social posts, search results and competitor pages can suggest a fact but never support one alone.
const QUALIFYING: readonly SourceKind[] = ['site', 'document', 'owner_statement']

// Ruling R41: the model picks a source's kind, so a page labelled site is the brand's own only when its
// registrable domain is the intake website's (a subdomain counts). With no intake website no site page qualifies.
// The one check for "can this stand behind a fact": the facts result's grading and the owner's confirmation.
export function qualifiesAsFactSource(
  sources: readonly { kind: SourceKind; address: string | null }[],
  website: string | null,
): boolean {
  const brand = registrableDomain(website)
  return sources.some((source) =>
    source.kind === 'site'
      ? brand !== null && registrableDomain(source.address) === brand
      : QUALIFYING.includes(source.kind),
  )
}

// A source as the grading reads it: what it is, where it was read, and whether it could be read.
export interface GradedSource {
  kind: SourceKind
  address: string | null
  result: string
}
export type GradeNote = 'one source' | 'sources disagree' | 'to confirm'
type Confidence = 'found' | 'assumed' | 'unknown'

// Ruling R34: second-level labels under a two-letter country code that are part of the public suffix, so that
// "aztek.co.in", "shop.com.au" and "brand.co.uk" are compared whole. No public-suffix list (no dependency).
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'gen', 'firm', 'ind'])
// Shared hosting, where each tenant owns one name under the host's: "aztek.github.io" and "other.github.io" are
// two owners, so one more label is kept (otherwise another tenant could count as the brand's own site, R33).
const SHARED_HOSTING = new Set([
  'github.io',
  'gitlab.io',
  'blogspot.com',
  'wordpress.com',
  'wixsite.com',
  'weebly.com',
  'netlify.app',
  'vercel.app',
  'pages.dev',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'myshopify.com',
  'square.site',
])

// The registrable domain of a web address: lower case, without a leading "www.", its last two labels, or its
// last three when it ends in a two-letter country code under one of SECOND_LEVEL or in a SHARED_HOSTING suffix.
// Null for anything that is not a web address (a document, a file name), which therefore never counts as a host.
export function registrableDomain(address: string | null): string | null {
  if (address === null) return null
  let host: string
  try {
    host = new URL(address).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
  if (host === '') return null
  // An IP address is its own host.
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return host
  const labels = host.split('.')
  const tld = labels[labels.length - 1]!
  const second = labels[labels.length - 2]
  // A public suffix of two labels: a country's second level (co.in) or a shared host (github.io).
  const twoLabelSuffix =
    (tld.length === 2 && second !== undefined && SECOND_LEVEL.has(second)) ||
    SHARED_HOSTING.has(labels.slice(-2).join('.'))
  const keep = labels.length >= 3 && twoLabelSuffix ? 3 : 2
  return labels.slice(-keep).join('.')
}

// Spec 8.2 and rulings R22, R22a, R33, R34, R35: the confidence a suggestion may keep, given the sources it
// cites and the brand's intake website. It only ever lowers what the agent claimed:
// - `found` stays only when a read source is the brand's own site (a page labelled site whose registrable domain
//   is the intake website's), an uploaded document or the owner's statement, or when read sources at two
//   different registrable domains agree (the sources a suggestion cites are taken to agree unless told
//   otherwise). A page labelled site on another domain is a third-party page: it counts toward the two domains.
//   A page that could not be read supports nothing, and a competitor page never counts.
// - The `competitors` key is never `found` from research: it is noted "to confirm" (the owner confirms them).
// - Sources that disagree make it `assumed`, noted "sources disagree"; any other lowering is noted "one source".
// - `assumed` stays `assumed`, and `unknown` stays `unknown`.
export function gradeConfidence(
  sources: readonly GradedSource[],
  claimed: Confidence,
  context: { key?: string; disagree?: boolean; website?: string | null } = {},
): { confidence: Confidence; note?: GradeNote } {
  if (claimed === 'unknown') return { confidence: 'unknown' }
  if (context.disagree) return { confidence: 'assumed', note: 'sources disagree' }
  if (claimed === 'assumed') return { confidence: 'assumed' }
  if (context.key === 'competitors') return { confidence: 'assumed', note: 'to confirm' }
  const counted = sources.filter(
    (source) => (source.result === 'read' || source.result === 'stated') && source.kind !== 'competitor',
  )
  const own = qualifiesAsFactSource(counted, context.website ?? null)
  const hosts = new Set(
    counted.map((source) => registrableDomain(source.address)).filter((host) => host !== null),
  )
  if (own || hosts.size >= 2) return { confidence: 'found' }
  return { confidence: 'assumed', note: 'one source' }
}
