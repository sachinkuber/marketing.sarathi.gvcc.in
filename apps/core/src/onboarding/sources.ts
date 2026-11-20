// The kinds of source an agent can read or an owner can give (database enum app.source_kind).
export const SOURCE_KINDS = ['site', 'social', 'search', 'document', 'competitor', 'owner_statement'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

// What can stand behind a verified fact: the brand's own site, a document the owner uploaded, or the owner's
// own word. Social posts, search results and competitor pages can suggest a fact but never support one alone.
const QUALIFYING: readonly SourceKind[] = ['site', 'document', 'owner_statement']

export function qualifiesAsFactSource(kinds: SourceKind[]): boolean {
  return kinds.some((kind) => QUALIFYING.includes(kind))
}

// A source as the grading reads it: what it is, where it was read, and whether it could be read.
export interface GradedSource {
  kind: SourceKind
  address: string | null
  result: string
}
export type GradeNote = 'one source' | 'sources disagree'
type Confidence = 'found' | 'assumed' | 'unknown'

// The host of a web address, without case and a leading "www."; null for anything that is not a web address
// (a document, a file name), which therefore never counts as a second host.
function hostOf(address: string | null): string | null {
  if (address === null) return null
  try {
    const host = new URL(address).hostname.toLowerCase().replace(/^www\./, '')
    return host === '' ? null : host
  } catch {
    return null
  }
}

// Spec 8.2 and rulings R22, R22a: the confidence a suggestion may keep, given the sources it cites. It only
// ever lowers what the agent claimed:
// - `found` stays only when a read source is the brand's own site or document, or the owner's statement, or
//   two read sources at different hosts agree (the sources a suggestion cites are taken to agree unless told
//   otherwise). A page that could not be read supports nothing, and a competitor page never counts.
// - The `competitors` key is never `found` from research: the owner confirms who the competitors are.
// - Sources that disagree make it `assumed`, noted "sources disagree"; any other lowering is noted "one source".
// - `assumed` stays `assumed`, and `unknown` stays `unknown`.
export function gradeConfidence(
  sources: readonly GradedSource[],
  claimed: Confidence,
  context: { key?: string; disagree?: boolean } = {},
): { confidence: Confidence; note?: GradeNote } {
  if (claimed === 'unknown') return { confidence: 'unknown' }
  if (context.disagree) return { confidence: 'assumed', note: 'sources disagree' }
  if (claimed === 'assumed') return { confidence: 'assumed' }
  const counted = sources.filter(
    (source) => (source.result === 'read' || source.result === 'stated') && source.kind !== 'competitor',
  )
  const own = counted.some((source) => QUALIFYING.includes(source.kind))
  const hosts = new Set(counted.map((source) => hostOf(source.address)).filter((host) => host !== null))
  if (context.key !== 'competitors' && (own || hosts.size >= 2)) return { confidence: 'found' }
  return { confidence: 'assumed', note: 'one source' }
}
