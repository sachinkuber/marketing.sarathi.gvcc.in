// The kinds of source an agent can read or an owner can give (database enum app.source_kind).
export const SOURCE_KINDS = ['site', 'social', 'search', 'document', 'competitor', 'owner_statement'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

// What can stand behind a verified fact: the brand's own site, a document the owner uploaded, or the owner's
// own word. Social posts, search results and competitor pages can suggest a fact but never support one alone.
const QUALIFYING: readonly SourceKind[] = ['site', 'document', 'owner_statement']

export function qualifiesAsFactSource(kinds: SourceKind[]): boolean {
  return kinds.some((kind) => QUALIFYING.includes(kind))
}
