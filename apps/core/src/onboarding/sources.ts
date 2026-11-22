import { registrableDomain, type SourceKind } from '@mkt/shared'

// The kinds of source an agent can read or an owner can give (database enum app.source_kind), from shared, so
// the facts and rules agent's input and the core name the same kinds.
export { SOURCE_KINDS, registrableDomain, type SourceKind } from '@mkt/shared'

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
