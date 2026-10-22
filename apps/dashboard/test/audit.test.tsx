// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AuditScreen, VerifyResult } from '../src/screens/Audit'
import { Dom, ME, T, brandId, sessionAs } from './dom-support'

const other = 'c0000000-0000-4000-8000-000000000002'

const entry = (seq: number, extra: Record<string, unknown> = {}) => ({
  seq,
  at: T,
  actorKind: 'user',
  actorId: other,
  action: 'users.role_changed',
  outcome: 'success',
  subject: 'x',
  detail: { from: 'viewer', to: 'approver' },
  hash: 'sha256:aa',
  ...extra,
})

const users = {
  members: [
    {
      userId: other,
      email: 'meera@example.test',
      name: 'Meera',
      role: 'brand_admin',
      twoFactorEnabled: true,
      since: T,
    },
  ],
  pendingInvites: [],
}

describe('the verify result', () => {
  it('shows a verified chain with the time of the last export', () => {
    const html = renderToStaticMarkup(
      <VerifyResult
        result={{
          ok: true,
          checkedAt: '2026-10-20T11:00:00.000Z',
          findings: [],
          lastExport: { throughSeq: 40, exportedAt: '2026-10-20T00:00:00.000Z' },
        }}
      />,
    )
    expect(html).toContain('Verified')
    expect(html).toContain('Every entry links to the one before it')
    expect(html).toContain('Last export')
    expect(html).toMatch(/datetime="2026-10-20T00:00:00.000Z"/i)
    expect(html).not.toMatch(/\sstyle=/)
  })

  it('shows a failed check with each finding, and says when there has been no export', () => {
    const html = renderToStaticMarkup(
      <VerifyResult
        result={{
          ok: false,
          checkedAt: '2026-10-20T11:00:00.000Z',
          findings: [
            { kind: 'broken_chain', seq: 12 },
            { kind: 'export_mismatch', seq: 40 },
          ],
          lastExport: null,
        }}
      />,
    )
    expect(html).toContain('Problem found')
    expect(html).toContain('The chain breaks at entry 12')
    expect(html).toContain('The export up to entry 40 does not match the log')
    expect(html).toContain('No export yet')
    expect(html).not.toContain('Every entry links to the one before it')
  })
})

describe('the audit screen, driven', () => {
  const dom = new Dom()
  beforeEach(() => dom.start())
  afterEach(() => dom.stop())

  it('names the people, filters by person, action and time, and loads older entries', async () => {
    dom.replies.push(
      { status: 200, body: users },
      {
        status: 200,
        body: { items: [entry(60), entry(59, { actorId: ME, action: 'killswitch.set' })], nextBefore: 59 },
      },
    )
    await dom.mount(<AuditScreen brandId={brandId} />, sessionAs('brand_admin'))
    expect(dom.calls.map((c) => c.url)).toEqual([
      `/api/v1/brands/${brandId}/users`,
      `/api/v1/brands/${brandId}/audit`,
    ])
    expect(dom.text()).toContain('Meera')
    expect(dom.text()).toContain('You')
    expect(dom.text()).toContain('Changed a role')

    dom.replies.push({ status: 200, body: { items: [entry(58)], nextBefore: null } })
    await dom.click('Load older')
    expect(dom.calls.at(-1)?.url).toBe(`/api/v1/brands/${brandId}/audit?before=59`)
    expect(dom.host.querySelectorAll('tbody tr')).toHaveLength(3)
    expect(dom.buttons('Load older')).toHaveLength(0)

    dom.type('f-person', other)
    dom.type('f-action', 'users.role_changed')
    dom.type('f-from', '2026-10-01')
    dom.type('f-to', '2026-10-20')
    dom.replies.push({ status: 200, body: { items: [entry(60)], nextBefore: null } })
    await dom.submit('Apply')
    const url = new URL(`http://x${dom.calls.at(-1)?.url}`)
    expect(url.pathname).toBe(`/api/v1/brands/${brandId}/audit`)
    expect(url.searchParams.get('actor')).toBe(other)
    expect(url.searchParams.get('action')).toBe('users.role_changed')
    expect(Date.parse(url.searchParams.get('from') ?? '')).toBe(new Date(2026, 9, 1).getTime())
    expect(Date.parse(url.searchParams.get('to') ?? '')).toBe(new Date(2026, 9, 21).getTime() - 1)
    expect(dom.host.querySelectorAll('tbody tr')).toHaveLength(1)
  })

  it('verifies now and shows both outcomes, and says when it was checked a moment ago', async () => {
    dom.replies.push({ status: 200, body: users }, { status: 200, body: { items: [], nextBefore: null } })
    await dom.mount(<AuditScreen brandId={brandId} />, sessionAs('brand_admin'))
    expect(dom.text()).toContain('No entries match')
    dom.replies.push({
      status: 200,
      body: { ok: false, checkedAt: T, findings: [{ kind: 'chain_missing', seq: null }], lastExport: null },
    })
    await dom.click('Verify now')
    expect(dom.writes()[0]).toEqual({
      url: `/api/v1/brands/${brandId}/audit/verify`,
      method: 'POST',
      body: {},
    })
    expect(dom.text()).toContain('Problem found')
    dom.replies.push({ status: 429, body: { error: { code: 'verify_rate_limited', message: 'x' } } })
    await dom.click('Verify now')
    expect(dom.text()).toContain('checked a moment ago')
  })
})
