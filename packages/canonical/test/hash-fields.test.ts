import { describe, expect, it } from 'vitest'
import { prepareVersion } from '../src/index.ts'

const BRAND = '00000000-0000-4000-8000-00000000000a'
const OTHER = '00000000-0000-4000-8000-00000000000b'
const ITEM = '00000000-0000-4000-8000-0000000000c1'
const SHA_A = 'sha256:' + 'a'.repeat(64)
const SHA_B = 'sha256:' + 'b'.repeat(64)

function full(): Record<string, unknown> {
  return {
    schema: 'content-version/1',
    brand_id: BRAND,
    content_item_id: ITEM,
    kind: 'article',
    language: 'en',
    targets: [{ platform: 'linkedin', connection_id: ITEM, format: 'post' }],
    title: 'Title',
    summary: 'Summary',
    body: [
      { type: 'heading', level: 2, text: 'Heading' },
      { type: 'paragraph', text: 'Text' },
    ],
    caption: 'Caption',
    hashtags: ['one', 'two'],
    call_to_action: 'Read more',
    links: [{ url: 'https://example.com/a', role: 'source' }],
    assets: [
      { asset_id: ITEM, sha256: SHA_A, byte_length: 10, media_type: 'image/png', role: 'hero', alt: 'Chart' },
    ],
    fact_refs: [{ fact_id: ITEM, text_hash: SHA_A }],
    disclosures: ['ai_generated_visuals'],
    publish_window: { earliest: '2026-10-04T06:30:00Z', latest: '2026-10-05T06:30:00Z' },
  }
}

function hashOf(mutate: (p: Record<string, unknown>) => void): string {
  const payload = full()
  mutate(payload)
  return prepareVersion(payload).hash
}

describe('every hashed field changes the hash (acceptance test 17)', () => {
  const baseline = hashOf(() => undefined)
  const changes: [string, (p: Record<string, unknown>) => void][] = [
    ['brand_id', (p) => (p.brand_id = OTHER)],
    ['content_item_id', (p) => (p.content_item_id = OTHER)],
    ['kind', (p) => (p.kind = 'social_post')],
    ['language', (p) => (p.language = 'fr')],
    ['targets', (p) => (p.targets = [{ platform: 'x', connection_id: ITEM, format: 'post' }])],
    ['title', (p) => (p.title = 'Other')],
    ['summary', (p) => (p.summary = 'Other')],
    ['body text', (p) => (p.body = [{ type: 'paragraph', text: 'Other' }])],
    ['body order', (p) => (p.body = (p.body as unknown[]).slice().reverse())],
    ['caption', (p) => (p.caption = 'Other')],
    ['hashtags order', (p) => (p.hashtags = ['two', 'one'])],
    ['call_to_action', (p) => (p.call_to_action = 'Other')],
    ['link address', (p) => (p.links = [{ url: 'https://example.com/b', role: 'source' }])],
    ['link role', (p) => (p.links = [{ url: 'https://example.com/a', role: 'other' }])],
    ['asset hash', (p) => ((p.assets as { sha256: string }[])[0]!.sha256 = SHA_B)],
    ['asset alt text', (p) => ((p.assets as { alt: string }[])[0]!.alt = 'Other')],
    ['fact hash', (p) => ((p.fact_refs as { text_hash: string }[])[0]!.text_hash = SHA_B)],
    ['disclosures removed', (p) => delete p.disclosures],
    [
      'publish window',
      (p) => (p.publish_window = { earliest: '2026-10-04T06:30:01Z', latest: '2026-10-05T06:30:00Z' }),
    ],
  ]
  for (const [name, mutate] of changes) {
    it(`${name}`, () => {
      expect(hashOf(mutate)).not.toBe(baseline)
    })
  }
})

describe('the same text in two Unicode forms hashes the same (Review Focus 7)', () => {
  it('treats precomposed and decomposed accents as one', () => {
    const composed = hashOf((p) => (p.title = 'Caf\u00e9'))
    const decomposed = hashOf((p) => (p.title = 'Cafe\u0301'))
    expect(decomposed).toBe(composed)
  })
})

describe('ordering rules', () => {
  it('keeps the order of an ordered list and sorts an unordered one', () => {
    expect(hashOf((p) => (p.disclosures = ['b', 'a']))).toBe(hashOf((p) => (p.disclosures = ['a', 'b'])))
    expect(hashOf((p) => (p.hashtags = ['b', 'a']))).not.toBe(hashOf((p) => (p.hashtags = ['a', 'b'])))
  })

  it('keeps whitespace inside the body exactly and trims a single-line field', () => {
    expect(hashOf((p) => (p.title = '  Title  '))).toBe(hashOf((p) => (p.title = 'Title')))
    const spaced = hashOf((p) => (p.body = [{ type: 'paragraph', text: ' Text ' }]))
    const plain = hashOf((p) => (p.body = [{ type: 'paragraph', text: 'Text' }]))
    expect(spaced).not.toBe(plain)
  })
})
