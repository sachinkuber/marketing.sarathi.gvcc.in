import type { BodyBlock, ContentPayload } from '@mkt/shared'

export class PayloadRejected extends Error {
  readonly path: string
  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`)
    this.name = 'PayloadRejected'
    this.path = path
  }
}

// Control characters other than line feed and tab, the C1 controls, line and paragraph separators, byte-order
// marks, and invisible zero-width and direction characters. The joiner and non-joiner (U+200D, U+200C) stay:
// they carry meaning inside emoji and some scripts (plan decision 6).
// Written with escapes so no invisible character sits in the source: U+061C, U+200B, U+200E, U+200F, U+2028,
// U+2029, U+202A-202E, U+2060, U+2066-2069, U+FEFF.
const DISALLOWED =
  // eslint-disable-next-line no-control-regex -- the control characters are the point
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/

function clean(path: string, value: string, kind: 'line' | 'block'): string {
  if (!value.isWellFormed()) throw new PayloadRejected(path, 'contains an unpaired surrogate')
  let out = value.normalize('NFC').replace(/\r\n?/g, '\n')
  if (DISALLOWED.test(out)) throw new PayloadRejected(path, 'contains an invisible or control character')
  if (kind === 'line') {
    if (out.includes('\n')) throw new PayloadRejected(path, 'contains a line break')
    out = out.trim()
    if (out === '') throw new PayloadRejected(path, 'is empty after trimming')
  }
  return out
}

const line = (path: string, value: string) => clean(path, value, 'line')
const block = (path: string, value: string) => clean(path, value, 'block')

// Parsed and written back by the standard URL rules for the scheme and host; the path, query and fragment
// are kept as written (spec 10.4). Only https, and no user name or password.
function normaliseUrl(path: string, value: string): string {
  const text = line(path, value)
  const match = /^https:\/\/([^/?#]*)(.*)$/i.exec(text)
  if (!match) throw new PayloadRejected(path, 'must be an https address')
  if ((match[1] ?? '').includes('@'))
    throw new PayloadRejected(path, 'must not contain a user name or password')
  let host: string
  try {
    host = new URL(text).host
  } catch {
    throw new PayloadRejected(path, 'is not a valid address')
  }
  if (host === '') throw new PayloadRejected(path, 'has no host')
  return `https://${host}${match[2] ?? ''}`
}

function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// Sorted by a fixed key; a duplicate is refused rather than dropped.
function sortedUnique<T>(path: string, items: T[], key: (item: T) => string): T[] {
  const keyed = items.map((item) => ({ item, key: key(item) })).sort((a, b) => byKey(a.key, b.key))
  for (let i = 1; i < keyed.length; i += 1) {
    if (keyed[i]!.key === keyed[i - 1]!.key) throw new PayloadRejected(path, 'contains a duplicate')
  }
  return keyed.map((entry) => entry.item)
}

function normaliseBlock(path: string, value: BodyBlock): BodyBlock {
  switch (value.type) {
    case 'paragraph':
    case 'quote':
      return { ...value, text: block(`${path}.text`, value.text) }
    case 'heading':
      return { ...value, text: block(`${path}.text`, value.text) }
    case 'list':
      return { ...value, items: value.items.map((item, i) => block(`${path}.items[${i}]`, item)) }
    case 'image':
      return value
  }
}

export function normalisePayload(payload: ContentPayload): ContentPayload {
  const out: ContentPayload = {
    ...payload,
    body: payload.body.map((value, i) => normaliseBlock(`body[${i}]`, value)),
  }
  if (payload.title !== undefined) out.title = line('title', payload.title)
  if (payload.summary !== undefined) out.summary = block('summary', payload.summary)
  if (payload.caption !== undefined) out.caption = line('caption', payload.caption)
  if (payload.call_to_action !== undefined)
    out.call_to_action = line('call_to_action', payload.call_to_action)
  if (payload.hashtags) out.hashtags = payload.hashtags.map((tag, i) => line(`hashtags[${i}]`, tag))
  if (payload.links) {
    out.links = payload.links.map((link, i) => ({
      url: normaliseUrl(`links[${i}].url`, link.url),
      role: line(`links[${i}].role`, link.role),
    }))
  }
  if (payload.assets) {
    out.assets = payload.assets.map((asset, i) => {
      const next = {
        ...asset,
        media_type: line(`assets[${i}].media_type`, asset.media_type),
        role: line(`assets[${i}].role`, asset.role),
      }
      if (asset.alt !== undefined) next.alt = line(`assets[${i}].alt`, asset.alt)
      return next
    })
  }
  if (payload.targets) {
    const targets = payload.targets.map((t, i) => ({
      platform: line(`targets[${i}].platform`, t.platform),
      connection_id: t.connection_id,
      format: line(`targets[${i}].format`, t.format),
    }))
    out.targets = sortedUnique('targets', targets, (t) =>
      JSON.stringify([t.platform, t.connection_id, t.format]),
    )
  }
  if (payload.fact_refs) {
    out.fact_refs = sortedUnique('fact_refs', payload.fact_refs, (f) =>
      JSON.stringify([f.fact_id, f.text_hash]),
    )
  }
  if (payload.disclosures) {
    const flags = payload.disclosures.map((flag, i) => line(`disclosures[${i}]`, flag))
    out.disclosures = sortedUnique('disclosures', flags, (flag) => flag)
  }
  return out
}
