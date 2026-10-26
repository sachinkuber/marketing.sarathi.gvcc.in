import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { InboxList, inboxFilter, inboxOrder, inboxQuery } from '../src/screens/Inbox'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const brandId = '6c77c301-7cb4-4c81-8551-1a0fbe6dce41'

const row = (id: string, title: string, requestedAt: string, overdue = false) => ({
  id,
  kind: 'summary',
  currentVersionId: `${id.slice(0, 35)}f`,
  number: 1,
  state: 'awaiting_approval' as const,
  title,
  overdue,
  requestedAt,
  createdAt: requestedAt,
})

// The core answers newest first; the inbox shows the oldest first.
const reply = [
  row('a0000000-0000-4000-8000-000000000001', 'Newest', '2026-10-20T09:00:00.000Z'),
  row('a0000000-0000-4000-8000-000000000002', 'Oldest', '2026-10-15T12:00:00.000Z', true),
  row('a0000000-0000-4000-8000-000000000003', 'Middle', '2026-10-19T12:00:00.000Z'),
]

describe('the approval inbox', () => {
  it('lists the oldest first', () => {
    expect(inboxOrder(reply).map((r) => r.title)).toEqual(['Oldest', 'Middle', 'Newest'])
    const html = renderToStaticMarkup(
      <InboxList brandId={brandId} filter="waiting" items={reply} now={NOW} />,
    )
    const order = ['Oldest', 'Middle', 'Newest'].map((t) => html.indexOf(t))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('shows the kind, the wait and an overdue tag on overdue rows only', () => {
    const html = renderToStaticMarkup(
      <InboxList brandId={brandId} filter="waiting" items={reply} now={NOW} />,
    )
    expect(html.match(/Overdue · /g)).toHaveLength(1)
    expect(html).toContain('Overdue · 5 days')
    expect(html).toContain('Waiting · 3 hours')
    expect(html).toContain('Summary')
    expect(html).toContain(`href="/b/${brandId}/inbox/a0000000-0000-4000-8000-000000000002"`)
    expect(html).not.toMatch(/\sstyle=/)
  })

  it('has the three filters, and asks the core for the right list for each', () => {
    const html = renderToStaticMarkup(
      <InboxList brandId={brandId} filter="overdue" items={reply} now={NOW} />,
    )
    expect(html).toMatch(/<a(?=[^>]*aria-current="page")(?=[^>]*\?filter=overdue")[^>]*>Overdue</)
    expect(html).toMatch(/href="\/b\/[^"]*\/inbox"[^>]*>Waiting</)
    expect(html).toMatch(/href="[^"]*\?filter=check_failed"[^>]*>Checks failed</)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    // The core is asked for the oldest first, so its 200-row cap never drops the oldest items.
    expect(inboxQuery('waiting')).toBe('?state=awaiting_approval&order=oldest')
    expect(inboxQuery('overdue')).toBe('?state=awaiting_approval&overdue=true&order=oldest')
    expect(inboxQuery('check_failed')).toBe('?state=check_failed&order=oldest')
    expect(inboxFilter('overdue')).toBe('overdue')
    expect(inboxFilter('nonsense')).toBe('waiting')
    expect(inboxFilter(undefined)).toBe('waiting')
  })

  it('shows how long a row whose checks failed has been there', () => {
    const failed = {
      ...row('a0000000-0000-4000-8000-000000000004', 'Failed', '2026-10-20T07:00:00.000Z'),
      state: 'check_failed' as const,
      requestedAt: null,
    }
    const html = renderToStaticMarkup(
      <InboxList brandId={brandId} filter="check_failed" items={[failed]} now={NOW} />,
    )
    expect(html).toContain('Checks failed · 5 hours')
  })

  it('says what will appear when nothing waits', () => {
    const html = renderToStaticMarkup(<InboxList brandId={brandId} filter="waiting" items={[]} now={NOW} />)
    expect(html).toContain('Nothing is waiting for approval')
    expect(html).toContain('Items appear here when an agent has produced them and their checks have passed.')
    const overdue = renderToStaticMarkup(
      <InboxList brandId={brandId} filter="overdue" items={[]} now={NOW} />,
    )
    expect(overdue).toContain('Nothing is overdue')
  })
})
