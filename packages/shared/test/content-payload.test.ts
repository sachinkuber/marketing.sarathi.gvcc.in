import { describe, expect, it } from 'vitest'
import { contentPayloadSchema } from '../src/index.ts'

const BRAND = '00000000-0000-4000-8000-00000000000a'
const ITEM = '00000000-0000-4000-8000-0000000000c1'

function minimal(): Record<string, unknown> {
  return {
    schema: 'content-version/1',
    brand_id: BRAND,
    content_item_id: ITEM,
    kind: 'summary',
    language: 'en',
    body: [{ type: 'paragraph', text: 'Hello' }],
  }
}

function rejects(mutate: (payload: Record<string, unknown>) => void): boolean {
  const payload = minimal()
  mutate(payload)
  return !contentPayloadSchema.safeParse(payload).success
}

describe('content payload schema', () => {
  it('accepts the smallest payload, with optional fields absent', () => {
    expect(contentPayloadSchema.safeParse(minimal()).success).toBe(true)
  })

  it('accepts a payload that uses every field', () => {
    const payload = {
      ...minimal(),
      targets: [{ platform: 'linkedin', connection_id: ITEM, format: 'post' }],
      title: 'A title',
      summary: 'A summary',
      caption: 'A caption',
      hashtags: ['one', 'two'],
      call_to_action: 'Read more',
      links: [{ url: 'https://example.com/a', role: 'source' }],
      assets: [
        {
          asset_id: ITEM,
          sha256: 'sha256:' + 'a'.repeat(64),
          byte_length: 10,
          media_type: 'image/png',
          role: 'hero',
          alt: 'A chart',
        },
      ],
      fact_refs: [{ fact_id: ITEM, text_hash: 'sha256:' + 'b'.repeat(64) }],
      disclosures: ['ai_generated_visuals'],
      publish_window: { earliest: '2026-10-04T06:30:00Z', latest: '2026-10-05T06:30:00Z' },
    }
    expect(contentPayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('refuses null, an empty string and an empty optional list', () => {
    expect(rejects((p) => (p.title = null))).toBe(true)
    expect(rejects((p) => (p.title = ''))).toBe(true)
    expect(rejects((p) => (p.hashtags = []))).toBe(true)
    expect(rejects((p) => (p.body = []))).toBe(true)
  })

  it('refuses a decimal anywhere, and an unknown field', () => {
    expect(rejects((p) => (p.body = [{ type: 'heading', level: 1.5, text: 'x' }]))).toBe(true)
    expect(rejects((p) => (p.extra = 1))).toBe(true)
    expect(rejects((p) => (p.kind_specific = {}))).toBe(true)
  })

  it('accepts a time only in the form 2026-10-04T06:30:00Z', () => {
    const ok = (earliest: string) =>
      contentPayloadSchema.safeParse({ ...minimal(), publish_window: { earliest } }).success
    expect(ok('2026-10-04T06:30:00Z')).toBe(true)
    expect(ok('2026-10-04T06:30:00.000Z')).toBe(false)
    expect(ok('2026-10-04T06:30:00+05:30')).toBe(false)
    expect(ok('2026-10-04 06:30:00Z')).toBe(false)
    expect(ok('2026-02-31T06:30:00Z')).toBe(false)
  })

  it('refuses a publish window that is empty or runs backwards', () => {
    const win = (w: Record<string, string>) =>
      contentPayloadSchema.safeParse({ ...minimal(), publish_window: w }).success
    expect(win({})).toBe(false)
    expect(win({ earliest: '2026-10-05T00:00:00Z', latest: '2026-10-04T00:00:00Z' })).toBe(false)
  })

  it('refuses a body block outside the permitted set', () => {
    expect(rejects((p) => (p.body = [{ type: 'html', text: '<b>x</b>' }]))).toBe(true)
    expect(rejects((p) => (p.body = [{ type: 'list', ordered: false, items: [] }]))).toBe(true)
  })
})
