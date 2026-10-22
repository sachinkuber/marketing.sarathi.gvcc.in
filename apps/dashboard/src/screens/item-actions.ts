import type { z } from 'zod'
import { ApiError, api } from '../api/client'
import {
  commentReply,
  contentItemReply,
  decisionReply,
  versionCreatedReply,
  type contentPayload,
} from '../api/schemas'

export type ContentItem = z.infer<typeof contentItemReply>
export type Version = ContentItem['versions'][number]
export type Payload = z.infer<typeof contentPayload>

export const STALE_MESSAGE = 'This item changed. Review the new version.'
// The longest reason or comment the core takes.
export const TEXT_MAX = 2000

// What a refused decision means to the person, by the core's code. Each is answered by reloading the item.
const CONFLICTS: Record<string, string> = {
  stale_hash: STALE_MESSAGE,
  already_decided: 'This version has already been decided. The item has been reloaded.',
  not_awaiting_approval: 'This version is no longer waiting for approval. The item has been reloaded.',
}

// `reloaded` carries the fresh item, or null when the reload itself failed: the decision's answer still stands.
export type Outcome<K extends string> =
  | { kind: K }
  | { kind: 'reloaded'; item: ContentItem | null; notice: string }
  | { kind: 'invalid'; message: string }

// Said after a write that succeeded when the item could not be read again afterwards.
export const RELOAD_HINT = 'The screen could not load the latest state; reload the page to see it.'

const itemPath = (brandId: string, itemId: string) => `/brands/${brandId}/content/${itemId}`
const versionPath = (brandId: string, itemId: string, versionId: string) =>
  `${itemPath(brandId, itemId)}/versions/${versionId}`

export function loadItem(brandId: string, itemId: string): Promise<ContentItem> {
  return api(contentItemReply, 'GET', itemPath(brandId, itemId))
}

// The read after a write. Its failure must not turn the write into a failure (the person would repeat it), so
// it answers null and the screen says to reload.
export async function reloadAfterWrite(brandId: string, itemId: string): Promise<ContentItem | null> {
  try {
    return await loadItem(brandId, itemId)
  } catch {
    return null
  }
}

// A 409 from a decision: the screen no longer shows what the core holds, so it reloads and says why. Nothing
// is retried: a decision applies only to the version the person saw.
async function onConflict(error: unknown, brandId: string, itemId: string) {
  if (error instanceof ApiError && error.status === 409 && CONFLICTS[error.code]) {
    const item = await reloadAfterWrite(brandId, itemId)
    return { kind: 'reloaded' as const, item, notice: CONFLICTS[error.code] as string }
  }
  throw error
}

function textProblem(text: string, missing: string): string | null {
  if (text.trim().length === 0) return missing
  if (text.trim().length > TEXT_MAX) return `Keep it under ${TEXT_MAX} characters.`
  return null
}

// Approves exactly the version on screen: its id and the hash the screen shows. If the core holds a newer
// version (409 stale_hash) the item is reloaded and nothing is approved (app-flow 5.6 step 4).
export async function approveShown(
  brandId: string,
  itemId: string,
  shown: Pick<Version, 'id' | 'hash' | 'hashScheme'>,
): Promise<Outcome<'approved'>> {
  try {
    await api(decisionReply, 'POST', `${versionPath(brandId, itemId, shown.id)}/approve`, {
      hash: shown.hash,
      hash_scheme: shown.hashScheme,
    })
    return { kind: 'approved' }
  } catch (error) {
    return onConflict(error, brandId, itemId)
  }
}

export async function rejectShown(
  brandId: string,
  itemId: string,
  shown: Pick<Version, 'id'>,
  reason: string,
): Promise<Outcome<'rejected'>> {
  const problem = textProblem(reason, 'Give a reason for rejecting.')
  if (problem) return { kind: 'invalid', message: problem }
  try {
    await api(decisionReply, 'POST', `${versionPath(brandId, itemId, shown.id)}/reject`, {
      reason: reason.trim(),
    })
    return { kind: 'rejected' }
  } catch (error) {
    return onConflict(error, brandId, itemId)
  }
}

export async function commentOn(
  brandId: string,
  itemId: string,
  shown: Pick<Version, 'id'>,
  text: string,
): Promise<Outcome<'commented'>> {
  const problem = textProblem(text, 'Write the comment first.')
  if (problem) return { kind: 'invalid', message: problem }
  await api(commentReply, 'POST', `${versionPath(brandId, itemId, shown.id)}/comments`, { text: text.trim() })
  return { kind: 'commented' }
}

export interface EditValues {
  title: string
  summary: string
  // One keyword per line.
  keywords: string
}

// The fields the server sets itself; the edit route refuses a payload that carries them.
const SERVER_FIELDS = new Set(['schema', 'brand_id', 'content_item_id'])

// Where an item keeps its keywords: the body's first list (the summary agent's shape), else its hashtags.
function keywordSource(payload: Payload): 'list' | 'hashtags' {
  if (payload.body?.some((block) => block.type === 'list')) return 'list'
  return payload.hashtags ? 'hashtags' : 'list'
}

export function keywordsOf(payload: Payload): string[] {
  if (keywordSource(payload) === 'hashtags') return payload.hashtags ?? []
  const items = payload.body?.find((block) => block.type === 'list')?.['items']
  return Array.isArray(items) ? items.filter((k): k is string => typeof k === 'string') : []
}

export function editValues(payload: Payload): EditValues {
  return {
    title: payload.title ?? '',
    summary: payload.summary ?? '',
    keywords: keywordsOf(payload).join('\n'),
  }
}

// The next version: the current payload with the edited title, summary and keywords, and everything the form
// does not cover kept as it was. The summary is also the body's first paragraph. The keywords go back where
// they came from: the body's first list (as the summary agent writes them), or the hashtags.
export function editedPayload(current: Payload, values: EditValues): Record<string, unknown> {
  const kept = Object.fromEntries(Object.entries(current).filter(([key]) => !SERVER_FIELDS.has(key)))
  const title = values.title.trim()
  const summary = values.summary.trim()
  const keywords = values.keywords
    .split('\n')
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
  const body: Array<Record<string, unknown>> = [...(current.body ?? [])]
  const paragraph = body.findIndex((block) => block.type === 'paragraph')
  if (paragraph >= 0) body[paragraph] = { type: 'paragraph', text: summary }
  else body.unshift({ type: 'paragraph', text: summary })
  const next: Record<string, unknown> = { ...kept, summary, body }
  if (keywordSource(current) === 'hashtags') {
    next['hashtags'] = keywords
  } else {
    const list = body.findIndex((block) => block.type === 'list')
    const listBlock = { type: 'list', ordered: false, items: keywords }
    if (list >= 0) body[list] = listBlock
    else body.push(listBlock)
  }
  if (title) next['title'] = title
  else delete next['title']
  return next
}

export async function saveEdit(
  brandId: string,
  itemId: string,
  current: Payload,
  values: EditValues,
): Promise<{ number: number; item: ContentItem | null }> {
  const created = await api(
    versionCreatedReply,
    'POST',
    `${itemPath(brandId, itemId)}/versions`,
    editedPayload(current, values),
  )
  return { number: created.number, item: await reloadAfterWrite(brandId, itemId) }
}
