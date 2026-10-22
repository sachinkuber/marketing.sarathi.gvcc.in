import { words } from './format'

// The audit actions the core writes, in the screen's words. The audit filter offers exactly these (the core
// matches an action exactly); an action not listed here still shows, as its code in words.
export const ACTIONS: Record<string, string> = {
  'agent.run_started': 'Run started',
  'approval.approved': 'Approved an item',
  'approval.rejected': 'Rejected an item',
  'approval.commented': 'Commented on an item',
  'approval.popup_acknowledged': 'Answered the overdue pop-up',
  'approval.no_recipient': 'Found no one to ask for approval',
  'approval_settings.updated': 'Changed the approval settings',
  'content.version_created': 'Made a new version of an item',
  'content.state_changed': 'Moved an item to a new state',
  'alerts.acknowledged': 'Acknowledged an alert',
  'killswitch.set': 'Set a kill switch',
  'killswitch.released': 'Released a kill switch',
  'brand.shadow_mode_changed': 'Changed shadow mode',
  'jobs.dead': 'Moved a job to dead letters',
  'jobs.requeued': 'Requeued a dead job',
  'jobs.cancelled': 'Cancelled a dead job',
  'jobs.held_result_discarded': 'Discarded a held result',
  'users.invited': 'Invited a user',
  'users.invite_withdrawn': 'Withdrew an invite',
  'users.role_changed': 'Changed a role',
  'users.removed': 'Removed a user',
  'users.second_factor_reset': 'Reset a second factor',
  'auth.invite_accepted': 'Accepted an invite',
  'audit.read': 'Read the audit log',
  'audit.verified': 'Checked the audit chain',
}

export function actionLabel(action: string): string {
  return ACTIONS[action] ?? words(action.replace(/\./g, ' '))
}

const ACTOR_KINDS: Record<string, string> = {
  agent: 'An agent',
  system: 'The platform',
  n8n: 'The workflow runner (n8n)',
}

// Who did it: a person by name when the screen knows them, "You" for the reader.
export function actorLabel(
  entry: { actorKind: string; actorId: string | null },
  me: string,
  names: Map<string, string>,
): string {
  if (entry.actorKind !== 'user') return ACTOR_KINDS[entry.actorKind] ?? words(entry.actorKind)
  if (entry.actorId === null) return 'Someone not signed in'
  if (entry.actorId === me) return 'You'
  return names.get(entry.actorId) ?? 'Someone outside this brand'
}

// The before and after, or whatever else the entry carries, as short text.
export function detailText(detail: unknown): string {
  if (detail === null || detail === undefined) return ''
  if (typeof detail !== 'object') return String(detail)
  const record = detail as Record<string, unknown>
  if ('from' in record && 'to' in record) return `${String(record['from'])} → ${String(record['to'])}`
  const text = Object.entries(record)
    .map(
      ([key, value]) => `${words(key)}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
    )
    .join(', ')
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}
