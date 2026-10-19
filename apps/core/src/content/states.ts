// The states of a content version and the moves between them (architecture 8.2, spec 10.5). This is the same
// list the database holds in app.version_state_transition (migration 0014); a test asserts they are equal.
export const VERSION_STATES = [
  'draft',
  'in_checks',
  'check_failed',
  'awaiting_approval',
  'approved',
  'rejected',
  'superseded',
  'invalidated',
  'scheduled',
  'publish_unknown',
  'published',
  'withdrawn',
] as const
export type VersionState = (typeof VERSION_STATES)[number]

export const TRANSITIONS: readonly (readonly [VersionState, VersionState])[] = [
  ['draft', 'in_checks'],
  ['draft', 'superseded'],
  ['in_checks', 'check_failed'],
  ['in_checks', 'awaiting_approval'],
  ['in_checks', 'superseded'],
  ['check_failed', 'superseded'],
  ['awaiting_approval', 'approved'],
  ['awaiting_approval', 'rejected'],
  ['awaiting_approval', 'superseded'],
  ['approved', 'scheduled'],
  ['approved', 'superseded'],
  ['approved', 'invalidated'],
  ['scheduled', 'invalidated'],
  ['scheduled', 'published'],
  ['scheduled', 'publish_unknown'],
  ['publish_unknown', 'published'],
  ['publish_unknown', 'scheduled'],
  ['published', 'withdrawn'],
]

// The states in which a version is still being worked on, so that a newer version replaces it.
export const OPEN_STATES: readonly VersionState[] = [
  'draft',
  'in_checks',
  'awaiting_approval',
  'approved',
  'check_failed',
]

export function canMove(from: VersionState, to: VersionState): boolean {
  return TRANSITIONS.some(([a, b]) => a === from && b === to)
}
