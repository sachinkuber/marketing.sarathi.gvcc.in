// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ShellContext } from '../src/frame/shell-context'
import { AgentTable, AgentsScreen } from '../src/screens/Agents'
import { formatMoney, formatMicros } from '../src/screens/format'
import { Dom, T, brandId, failure, sessionAs } from './dom-support'

const runId = 'd0000000-0000-4000-8000-000000000001'
const jobId = 'd1000000-0000-4000-8000-000000000001'

const summary = {
  agent: 'summary',
  version: 3,
  model: 'claude-opus-5-5',
  effort: 'low',
  state: 'idle' as const,
  costThisMonth: { usdMicros: '1234567', inrMicros: '102469061' },
}

const run = (id: string) => ({
  id,
  agent: 'summary',
  state: 'succeeded',
  startedByKind: 'user',
  startedAt: T,
  finishedAt: T,
  cost: { usdMicros: '1234567', inrMicros: '102469061' },
})

describe('cost in both currencies, from millionths', () => {
  it('formats 1234567 micros as $1.234567 and the rupee figure digit for digit', () => {
    expect(formatMicros('1234567', 'USD')).toBe('$1.234567')
    expect(formatMoney({ usdMicros: '1234567', inrMicros: '102469061' })).toBe('$1.234567 · ₹102.469061')
    // Past 2^53: a floating-point detour would change the last digits.
    expect(formatMoney({ usdMicros: '9007199254740993', inrMicros: '747597538143502419' })).toBe(
      '$9,007,199,254.740993 · ₹7,47,59,75,38,143.502419',
    )
  })

  it('lists each agent with its live version, state and this month’s cost in both currencies', () => {
    const html = renderToStaticMarkup(
      <AgentTable agents={[summary, { ...summary, agent: 'helper', state: 'blocked' }]} />,
    )
    expect(html).toContain('Summary')
    expect(html).toContain('v3')
    expect(html).toContain('Idle')
    expect(html).toContain('Blocked')
    expect(html).toContain('$1.234567')
    expect(html).toContain('₹102.469061')
    expect(html).not.toMatch(/\sstyle=/)
  })
})

describe('the start form', () => {
  const render = (role: 'owner' | 'brand_admin') =>
    renderToStaticMarkup(
      <ShellContext value={{ session: sessionAs(role), overdue: null, reload: async () => {} }}>
        <AgentsScreen brandId={brandId} />
      </ShellContext>,
    )

  it('is shown to the platform owner, with a 2000-character counter', () => {
    const html = render('owner')
    expect(html).toContain('Start the summary agent')
    expect(html).toContain('id="brief"')
    expect(html).toContain('0 / 2000')
  })

  it('is absent for a brand admin', () => {
    const html = render('brand_admin')
    expect(html).not.toContain('Start the summary agent')
    expect(html).not.toContain('id="brief"')
  })
})

describe('the agents screen, driven', () => {
  const dom = new Dom()
  beforeEach(() => dom.start())
  afterEach(() => dom.stop())

  const firstLoad = () =>
    dom.replies.push(
      { status: 200, body: { items: [summary] } },
      { status: 200, body: { items: [run('d0000000-0000-4000-8000-000000000009')], nextCursor: null } },
      { status: 200, body: { items: [], truncated: false } },
    )

  it('starts the summary agent on a brief and links to the run, even when the run list cannot be reloaded', async () => {
    firstLoad()
    dom.replies.push({ status: 201, body: { runId, jobId } }, failure)
    await dom.mount(<AgentsScreen brandId={brandId} />, sessionAs('owner'))
    expect(dom.text()).toContain('$1.234567')
    expect(dom.button('Start').disabled).toBe(true)
    dom.type('brief', 'Write about film for studios.')
    expect(dom.text()).toContain('29 / 2000')
    await dom.submit('Start')
    expect(dom.writes()).toEqual([
      {
        url: `/api/v1/brands/${brandId}/agents/summary/runs`,
        method: 'POST',
        body: { brief: 'Write about film for studios.' },
      },
    ])
    expect(dom.host.querySelector(`a[href="/b/${brandId}/agents/runs/${runId}"]`)).not.toBeNull()
    expect(dom.text()).toContain('Started.')
    expect(dom.text()).toContain('reload the page')
    expect(dom.host.querySelector('[role="alert"]')).toBeNull()
    // The brief was taken: the form is empty again, so the same run is not started twice by accident.
    expect((dom.field('brief') as HTMLTextAreaElement).value).toBe('')
  })

  it('refuses a brief over 2000 characters without sending it', async () => {
    firstLoad()
    await dom.mount(<AgentsScreen brandId={brandId} />, sessionAs('owner'))
    dom.type('brief', 'x'.repeat(2001))
    expect(dom.text()).toContain('2001 / 2000')
    expect(dom.button('Start').disabled).toBe(true)
    await dom.submit('Start')
    expect(dom.writes()).toHaveLength(0)
  })

  it('shows a brand admin the agents and runs with no start form', async () => {
    firstLoad()
    await dom.mount(<AgentsScreen brandId={brandId} />, sessionAs('brand_admin'))
    expect(dom.text()).toContain('Summary')
    expect(dom.field('brief')).toBeNull()
    expect(
      dom.host.querySelector(`a[href="/b/${brandId}/agents/runs/d0000000-0000-4000-8000-000000000009"]`),
    ).not.toBeNull()
  })

  it('loads older runs with the cursor the core gave', async () => {
    dom.replies.push(
      { status: 200, body: { items: [summary] } },
      { status: 200, body: { items: [run('d0000000-0000-4000-8000-000000000009')], nextCursor: 'c1' } },
      { status: 200, body: { items: [], truncated: false } },
      { status: 200, body: { items: [run('d0000000-0000-4000-8000-000000000008')], nextCursor: null } },
    )
    await dom.mount(<AgentsScreen brandId={brandId} />, sessionAs('brand_admin'))
    await dom.click('Load older runs')
    expect(dom.calls.at(-1)?.url).toBe(`/api/v1/brands/${brandId}/runs?cursor=c1`)
    expect(dom.host.querySelectorAll('a[href*="/agents/runs/"]')).toHaveLength(2)
    expect(dom.buttons('Load older runs')).toHaveLength(0)
  })
})
