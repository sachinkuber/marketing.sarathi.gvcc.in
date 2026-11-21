import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { setCsrfToken } from '../src/api/client'
import { ItemReview, hashPrefix, shownVersion } from '../src/screens/ItemReview'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTIONS } from '../src/screens/audit-words'
import {
  approveShown,
  askForChanges,
  canDecideOn,
  changesNotice,
  editValues,
  editedPayload,
  rejectShown,
  STALE_MESSAGE,
  type ContentItem,
  type Version,
} from '../src/screens/item-actions'

type State = Version['state']

const brandId = '6c77c301-7cb4-4c81-8551-1a0fbe6dce41'
const itemId = 'a0000000-0000-4000-8000-000000000001'
const v1 = 'b0000000-0000-4000-8000-000000000001'
const v2 = 'b0000000-0000-4000-8000-000000000002'
const HASH1 = `sha256:${'1a2b3c4d5e6f'}${'0'.repeat(52)}`
const HASH2 = `sha256:${'9f8e7d6c5b4a'}${'1'.repeat(52)}`

const version = (id: string, number: number, hash: string, state: State, summary: string): Version => ({
  id,
  number,
  state,
  stateChangedAt: '2026-10-20T10:00:00.000Z',
  hash,
  hashScheme: 'cv1',
  payload: {
    kind: 'summary',
    language: 'en',
    title: 'Summary of the brief',
    summary,
    body: [
      { type: 'paragraph', text: summary },
      { type: 'list', ordered: false, items: ['film', 'coating', 'care'] },
    ],
  },
  createdBy: { kind: 'agent', userId: null, runId: 'c0000000-0000-4000-8000-000000000001' },
  createdAt: '2026-10-20T10:00:00.000Z',
  checks: [
    {
      name: 'placeholder_length',
      kind: 'blocking',
      passed: state !== 'check_failed',
      detail: { summaryLength: 120, longestKeyword: 7 },
      at: '2026-10-20T10:01:00.000Z',
    },
  ],
})

const item = (
  state: State,
  current = v1,
  versions = [version(v1, 1, HASH1, state, 'First text')],
): ContentItem => ({
  id: itemId,
  kind: 'summary',
  currentVersionId: current,
  createdAt: '2026-10-20T10:00:00.000Z',
  versions,
})

const noop = () => {}
const review = (state: State, extra: Partial<Parameters<typeof ItemReview>[0]> = {}) =>
  renderToStaticMarkup(
    <ItemReview
      brandId={brandId}
      item={item(state)}
      canDecide
      busy={false}
      notice={null}
      error={null}
      onApprove={noop}
      onReject={noop}
      onComment={noop}
      onAskChanges={noop}
      onEdit={noop}
      {...extra}
    />,
  )

const approveButton = (html: string) => html.match(/<button[^>]*>Approve<\/button>/)?.[0] ?? ''

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('audit words', () => {
  it('every action the core can record has a label', () => {
    const core = join(dirname(fileURLToPath(import.meta.url)), '../../core/src')
    const found = new Set<string>()
    for (const file of sourceFiles(core)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/action: '([a-z_]+\.[a-z_]+)'/g)) found.add(m[1]!)
    }
    expect(found.size).toBeGreaterThan(40)
    expect([...found].filter((action) => !ACTIONS[action])).toEqual([])
  })

  it('every new audit action has a label', () => {
    for (const action of [
      'onboarding.brief_choices_started',
      'onboarding.brief_started',
      'onboarding.gate_passed',
      'onboarding.brief_revision_not_started',
      'approval.changes_requested',
      'approval.invalidated',
      'evaluation.case_added',
    ]) {
      expect(ACTIONS[action], action).toBeTruthy()
    }
  })
})

describe('the item review screen', () => {
  it('renders the version as it will appear, with the first 12 characters of its hash', () => {
    const html = review('awaiting_approval')
    expect(hashPrefix(HASH1)).toBe('1a2b3c4d5e6f')
    expect(html).toContain('1a2b3c4d5e6f')
    expect(html).not.toContain(HASH1.slice(7, 20))
    expect(html).toContain('Summary of the brief')
    expect(html).toContain('First text')
    for (const keyword of ['film', 'coating', 'care']) expect(html).toContain(`<li>${keyword}</li>`)
    expect(html).toContain('Length check')
    expect(html).toContain('Summary length: 120')
    expect(html).toContain('Version history')
    expect(html).not.toMatch(/\sstyle=/)
  })

  it('offers approve for a version awaiting approval and disables it when checks failed', () => {
    expect(approveButton(review('awaiting_approval'))).not.toMatch(/disabled/)
    const failed = review('check_failed')
    expect(approveButton(failed)).toMatch(/disabled/)
    expect(failed).toContain('Checks failed')
  })

  it('shows no decision controls to someone who cannot decide', () => {
    const html = review('awaiting_approval', { canDecide: false })
    expect(approveButton(html)).toBe('')
    expect(html).not.toContain('>Reject<')
  })

  it('shows the notice after a reload', () => {
    expect(review('awaiting_approval', { notice: STALE_MESSAGE })).toContain(
      'This item changed. Review the new version.',
    )
  })
})

interface Call {
  url: string
  method: string
  body: unknown
}
let calls: Call[]
let replies: Array<{ status: number; body: unknown }>

beforeEach(() => {
  calls = []
  replies = []
  setCsrfToken('tok-1')
  vi.stubGlobal('window', { location: { pathname: '/b/x/inbox/y', search: '', assign: vi.fn() } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; body?: string }) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
      const next = replies.shift() ?? { status: 500, body: {} }
      return new Response(JSON.stringify(next.body), { status: next.status })
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken(null)
})

describe('approving and rejecting', () => {
  it('approve sends the hash of the version on screen, for that version', async () => {
    const shown = shownVersion(item('awaiting_approval'))
    replies.push({ status: 201, body: { approvalId: 'd0000000-0000-4000-8000-000000000001' } })
    const outcome = await approveShown(brandId, itemId, shown!)
    expect(outcome.kind).toBe('approved')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe(`/api/v1/brands/${brandId}/content/${itemId}/versions/${v1}/approve`)
    expect(calls[0]?.body).toEqual({ hash: HASH1, hash_scheme: 'cv1' })
  })

  it('on 409 stale_hash, reloads the item, says it changed and approves nothing', async () => {
    const shown = shownVersion(item('awaiting_approval'))!
    const newer = item('superseded', v2, [
      version(v1, 1, HASH1, 'superseded', 'First text'),
      version(v2, 2, HASH2, 'awaiting_approval', 'Second text'),
    ])
    replies.push(
      { status: 409, body: { error: { code: 'stale_hash', message: 'The content has changed.' } } },
      { status: 200, body: newer },
    )
    const outcome = await approveShown(brandId, itemId, shown)
    expect(outcome).toMatchObject({ kind: 'reloaded', notice: 'This item changed. Review the new version.' })
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET'])
    expect(calls.filter((c) => c.url.endsWith('/approve'))).toHaveLength(1)
    expect(calls[1]?.url).toBe(`/api/v1/brands/${brandId}/content/${itemId}`)
    if (outcome.kind !== 'reloaded' || !outcome.item) throw new Error('expected a reloaded item')
    expect(shownVersion(outcome.item)?.hash).toBe(HASH2)
    const html = review('awaiting_approval', { item: outcome.item, notice: outcome.notice })
    expect(html).toContain('This item changed. Review the new version.')
    expect(html).toContain('9f8e7d6c5b4a')
  })

  it('on 409 stale_hash with a reload that fails, still says the item changed and gives no item', async () => {
    const shown = shownVersion(item('awaiting_approval'))!
    replies.push(
      { status: 409, body: { error: { code: 'stale_hash', message: 'The content has changed.' } } },
      { status: 500, body: { error: { code: 'internal_error', message: 'x' } } },
    )
    const outcome = await approveShown(brandId, itemId, shown)
    expect(outcome.kind).toBe('reloaded')
    if (outcome.kind !== 'reloaded') throw new Error('expected a reload')
    expect(outcome.item).toBeNull()
    expect(outcome.notice).toContain('This item changed. Review the new version.')
    expect(calls.filter((c) => c.url.endsWith('/approve'))).toHaveLength(1)
  })

  it('reject needs a reason and sends nothing without one', async () => {
    const shown = shownVersion(item('awaiting_approval'))!
    const blank = await rejectShown(brandId, itemId, shown, '   ')
    expect(blank).toEqual({ kind: 'invalid', message: 'Give a reason for rejecting.' })
    expect(calls).toHaveLength(0)
    replies.push({ status: 201, body: { approvalId: 'd0000000-0000-4000-8000-000000000002' } })
    const done = await rejectShown(brandId, itemId, shown, 'Off brand')
    expect(done.kind).toBe('rejected')
    expect(calls[0]?.url).toBe(`/api/v1/brands/${brandId}/content/${itemId}/versions/${v1}/reject`)
    expect(calls[0]?.body).toEqual({ reason: 'Off brand' })
  })
})

const briefItem = (): ContentItem => {
  const base = item('awaiting_approval')
  const v = base.versions[0]!
  return {
    ...base,
    kind: 'strategy_brief',
    versions: [
      {
        ...v,
        payload: {
          kind: 'strategy_brief',
          title: 'Strategy brief',
          body: [
            // The levels strategyBriefPayload (packages/shared) writes: 2 for sections, 3 for audience
            // and theme names.
            { type: 'heading', level: 2, text: 'Positioning' },
            { type: 'paragraph', text: 'We sell coatings to schools.' },
            { type: 'heading', level: 3, text: 'Priorities' },
            { type: 'list', ordered: true, items: ['Win the district', 'Keep the care plan'] },
            { type: 'list', ordered: false, items: ['Films', 'Coatings'] },
          ],
        },
      },
    ],
  }
}

describe('a strategy brief', () => {
  it('a strategy brief shows its headings, paragraphs and lists', () => {
    const html = review('awaiting_approval', { item: briefItem() })
    expect(html).toContain('<h3>Positioning</h3>')
    expect(html).toContain('<h4>Priorities</h4>')
    expect(html).toContain('<p>We sell coatings to schools.</p>')
    expect(html).toContain('<ol><li>Win the district</li><li>Keep the care plan</li></ol>')
    expect(html).toContain('<ul><li>Films</li><li>Coatings</li></ul>')
    // Other kinds keep today's preview: the first list as Keywords.
    expect(review('awaiting_approval')).toContain('Keywords')
    expect(review('awaiting_approval')).not.toContain('<ol>')
  })

  it('a brief has no Edit and only the owner can decide', () => {
    const owner = review('awaiting_approval', { item: briefItem() })
    expect(owner).not.toContain('>Edit<')
    expect(owner).toContain('>Approve<')
    expect(owner).toContain('>Ask for changes<')
    expect(review('awaiting_approval')).toContain('>Edit<')
    const admin = review('awaiting_approval', { item: briefItem(), canDecide: false })
    expect(admin).toContain('Only the platform owner decides on the strategy brief.')
    expect(admin).not.toContain('>Approve<')
    expect(admin).not.toContain('>Ask for changes<')
    expect(review('awaiting_approval', { canDecide: false })).not.toContain('Only the platform owner')
    expect(canDecideOn('strategy_brief', 'owner')).toBe(true)
    for (const role of ['brand_admin', 'approver', 'viewer', null]) {
      expect(canDecideOn('strategy_brief', role)).toBe(false)
    }
    expect(canDecideOn('summary', 'approver')).toBe(true)
  })

  it('approving a brief whose fact changed reloads it and says so', async () => {
    const shown = shownVersion(briefItem())!
    replies.push(
      { status: 409, body: { error: { code: 'fact_changed', message: 'x' } } },
      { status: 200, body: briefItem() },
    )
    const outcome = await approveShown(brandId, itemId, shown)
    expect(outcome).toMatchObject({
      kind: 'reloaded',
      notice: 'A fact this brief cites changed. Write the brief again from onboarding.',
    })
  })
})

describe('asking for changes', () => {
  it('says the right thing after an ask succeeded', () => {
    expect(changesNotice('strategy_brief', 'r1')).toBe(
      'Your comment was sent. A new version will come back to your inbox.',
    )
    expect(changesNotice('strategy_brief', null)).toBe(
      'Comment saved. The brief was revised three times; approve it, reject it, or write it again from onboarding.',
    )
    expect(changesNotice('summary', null)).toBe('Comment saved.')
    expect(changesNotice('summary', 'r1')).toBe('Comment saved.')
  })

  it('the Ask for changes button is disabled unless the version awaits approval', () => {
    const button = (html: string) => html.match(/<button[^>]*>Ask for changes<\/button>/)?.[0] ?? ''
    expect(button(review('awaiting_approval'))).not.toMatch(/disabled/)
    expect(button(review('rejected'))).toMatch(/disabled/)
    expect(button(review('check_failed'))).toMatch(/disabled/)
    expect(button(review('awaiting_approval', { canDecide: false }))).toBe('')
    expect(button(review('awaiting_approval', { busy: true }))).toMatch(/disabled/)
  })

  it('ask for changes needs a comment and posts it', async () => {
    const shown = shownVersion(item('awaiting_approval'))!
    expect(await askForChanges(brandId, itemId, shown, '   ')).toEqual({
      kind: 'invalid',
      message: 'Write what should change first.',
    })
    expect(await askForChanges(brandId, itemId, shown, 'x'.repeat(2001))).toMatchObject({ kind: 'invalid' })
    expect(calls).toHaveLength(0)
    replies.push({ status: 201, body: { approvalId: 'd0000000-0000-4000-8000-000000000003', runId: 'r1' } })
    expect(await askForChanges(brandId, itemId, shown, ' Shorter, please ')).toEqual({
      kind: 'changes_requested',
      runId: 'r1',
    })
    expect(calls[0]?.url).toBe(`/api/v1/brands/${brandId}/content/${itemId}/versions/${v1}/changes`)
    expect(calls[0]?.body).toEqual({ comment: 'Shorter, please' })
    replies.push({ status: 201, body: { approvalId: 'd0000000-0000-4000-8000-000000000004', runId: null } })
    expect(await askForChanges(brandId, itemId, shown, 'Again')).toEqual({
      kind: 'changes_requested',
      runId: null,
    })
  })

  it('a refused ask reloads the item', async () => {
    const shown = shownVersion(item('awaiting_approval'))!
    replies.push(
      { status: 409, body: { error: { code: 'already_decided', message: 'x' } } },
      { status: 200, body: item('awaiting_approval') },
    )
    expect((await askForChanges(brandId, itemId, shown, 'Fix it')).kind).toBe('reloaded')
  })
})

describe('editing', () => {
  it('builds the next version from the form, keeping what the form does not cover', () => {
    const current = shownVersion(item('awaiting_approval'))!
    // The stored payload carries the fields the server owns; the edit route refuses them.
    const stored = {
      ...current.payload,
      schema: 'content-version/1',
      brand_id: brandId,
      content_item_id: itemId,
    }
    const next = editedPayload(stored, {
      title: 'New title',
      summary: 'New text',
      keywords: 'one\n two \n\nthree',
    })
    expect(next).toEqual({
      kind: 'summary',
      language: 'en',
      title: 'New title',
      summary: 'New text',
      body: [
        { type: 'paragraph', text: 'New text' },
        { type: 'list', ordered: false, items: ['one', 'two', 'three'] },
      ],
    })
  })

  it('edits the hashtags when the keywords came from there, and adds no list block', () => {
    const tagged = {
      kind: 'social_post',
      language: 'en',
      title: 'Post',
      summary: 'Text',
      body: [{ type: 'paragraph', text: 'Text' }],
      hashtags: ['film', 'care'],
    }
    expect(editValues(tagged).keywords).toBe('film\ncare')
    expect(editedPayload(tagged, { title: 'Post', summary: 'Text', keywords: 'film\ncoating' })).toEqual({
      ...tagged,
      hashtags: ['film', 'coating'],
    })
  })

  it('leaves the hashtags alone when the keywords are a list block', () => {
    const both = { ...shownVersion(item('awaiting_approval'))!.payload, hashtags: ['tag'] }
    const next = editedPayload(both, { title: 'T', summary: 'S', keywords: 'x' })
    expect(next['hashtags']).toEqual(['tag'])
    expect(next['body']).toEqual([
      { type: 'paragraph', text: 'S' },
      { type: 'list', ordered: false, items: ['x'] },
    ])
  })
})
