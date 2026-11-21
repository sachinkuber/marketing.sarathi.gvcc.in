// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FactsRulesScreen } from '../src/screens/FactsRules'
import { OnboardingScreen } from '../src/screens/Onboarding'
import { Dom, brandId, sessionAs } from './dom-support'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => '/b/x/onboarding/facts-rules',
}))

const base = `/api/v1/brands/${brandId}/onboarding`
const T = '2026-11-20T10:00:00.000Z'
const source = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'website_page',
  address: `https://aztek.example/${id}`,
  readAt: T,
  extract: `Extract of ${id}`,
  flagged: null,
  ...over,
})
const suggestion = (
  id: string,
  step: 'fact' | 'rule',
  proposed: unknown,
  over: Record<string, unknown> = {},
) => ({
  id,
  step,
  key: `k-${id}`,
  proposed,
  why: `Why ${id}`,
  confidence: 'found',
  options: null,
  decision: null,
  decidedValue: null,
  decidedReason: null,
  decidedAt: null,
  createdAt: T,
  sources: [source(`src-${id}`)],
  ...over,
})
const fact = (id: string, over: Record<string, unknown> = {}) =>
  suggestion(id, 'fact', { statement: `Statement ${id}`, reviewDate: '2027-03-01' }, over)
const rule = (id: string, over: Record<string, unknown> = {}) =>
  suggestion(id, 'rule', { kind: 'forbidden_claim', text: `Rule ${id}` }, over)
const reply = (
  over: {
    facts?: unknown[]
    rules?: unknown[]
    active?: unknown[]
    activeRules?: unknown[]
    job?: unknown
  } = {},
) => ({
  job: over.job === undefined ? { state: 'done' } : over.job,
  facts: { suggestions: over.facts ?? [], active: over.active ?? [] },
  rules: { suggestions: over.rules ?? [], active: over.activeRules ?? [] },
})
const err = (status: number, code: string, message: string) => ({
  status,
  body: { error: { code, message } },
})

describe('the facts and rules screen, driven', () => {
  const dom = new Dom()
  beforeEach(() => dom.start())
  afterEach(() => dom.stop())

  const open = async (body: unknown, extra: Array<{ status: number; body?: unknown }> = []) => {
    dom.replies.push({ status: 200, body }, ...extra)
    await dom.mount(<FactsRulesScreen brandId={brandId} />, sessionAs('owner'))
  }
  const press = async (label: string, index = 0) => dom.click(label, index)

  it('a fact confirms, edits with a review date, and drops', async () => {
    await open(reply({ facts: [fact('f1'), fact('f2'), fact('f3')] }))
    expect(dom.text()).toContain('Statement f1')
    expect(dom.text()).toContain('https://aztek.example/src-f1')
    expect(dom.text()).toContain('Extract of src-f1')
    expect(dom.field('date-f1')?.value).toBe('2027-03-01')

    dom.replies.push(
      { status: 200, body: { createdId: 'x' } },
      { status: 200, body: reply({ facts: [fact('f2'), fact('f3')] }) },
    )
    await press('Confirm', 0)
    expect(dom.writes()).toEqual([
      { url: `${base}/suggestions/f1/decision`, method: 'POST', body: { decision: 'accepted' } },
    ])

    // Edit: the owner's wording and review date.
    await press('Edit', 0)
    dom.type('edit-f2', 'My own wording')
    dom.type('date-f2', '2027-06-30')
    dom.replies.push(
      { status: 200, body: { createdId: 'x' } },
      { status: 200, body: reply({ facts: [fact('f3')] }) },
    )
    await press('Save edit')
    expect(dom.writes()[1]).toEqual({
      url: `${base}/suggestions/f2/decision`,
      method: 'POST',
      body: { decision: 'edited', value: { statement: 'My own wording', reviewDate: '2027-06-30' } },
    })

    // Drop asks once, then sends.
    await press('Drop')
    expect(dom.writes()).toHaveLength(2)
    dom.replies.push({ status: 200, body: { createdId: null } }, { status: 200, body: reply() })
    await press('Yes, drop')
    expect(dom.writes()[2]).toEqual({
      url: `${base}/suggestions/f3/decision`,
      method: 'POST',
      body: { decision: 'rejected' },
    })
  })

  it('a changed review date on Confirm is sent as an edit', async () => {
    await open(reply({ facts: [fact('f1')] }))
    dom.type('date-f1', '2027-09-09')
    dom.replies.push({ status: 200, body: { createdId: 'x' } }, { status: 200, body: reply() })
    await press('Confirm')
    expect(dom.writes()[0]!.body).toEqual({
      decision: 'edited',
      value: { statement: 'Statement f1', reviewDate: '2027-09-09' },
    })
  })

  it('a fact needing a source offers edit', async () => {
    await open(reply({ facts: [fact('f1', { confidence: 'assumed', sources: [] })] }))
    expect(dom.text()).toContain('Needs your wording')
    dom.replies.push(
      err(
        422,
        'fact_needs_source',
        'This fact has no source that proves it. Edit it into your own words, then confirm.',
      ),
    )
    await press('Confirm')
    expect(dom.text()).toContain(
      'This fact has no source that proves it. Edit it into your own words, then confirm.',
    )
    expect(dom.field('edit-f1')).not.toBeNull()
    expect(dom.button('Save edit')).toBeTruthy()
  })

  it('a rule shows its kind in plain words and is decided like a fact', async () => {
    await open(reply({ rules: [rule('r1')] }))
    expect(dom.text()).toContain('forbidden claim')
    expect(dom.text()).toContain('Rule r1')
    expect(dom.text()).toContain('Why r1')
    dom.replies.push({ status: 200, body: { createdId: 'x' } }, { status: 200, body: reply() })
    await press('Confirm')
    expect(dom.writes()[0]).toEqual({
      url: `${base}/suggestions/r1/decision`,
      method: 'POST',
      body: { decision: 'accepted' },
    })
  })

  it('add your own fact and rule', async () => {
    await open(reply())
    await press('Add your own fact')
    dom.type('own-fact-statement', 'We are open 9 to 6')
    dom.type('own-fact-date', '2027-05-05')
    dom.replies.push(
      { status: 200, body: { factId: 'a', suggestionId: 'b' } },
      { status: 200, body: reply() },
    )
    await press('Add fact')
    expect(dom.writes()[0]).toEqual({
      url: `${base}/facts`,
      method: 'POST',
      body: { statement: 'We are open 9 to 6', reviewDate: '2027-05-05' },
    })

    await press('Add your own rule')
    dom.type('own-rule-kind', 'forbidden_word')
    dom.type('own-rule-text', 'cheapest')
    dom.type('own-rule-why', 'We cannot prove it')
    dom.replies.push(
      { status: 200, body: { ruleId: 'a', suggestionId: 'b' } },
      { status: 200, body: reply() },
    )
    await press('Add rule')
    expect(dom.writes()[1]).toEqual({
      url: `${base}/rules`,
      method: 'POST',
      body: { kind: 'forbidden_word', text: 'cheapest', why: 'We cannot prove it' },
    })
  })

  it('a confirmed fact can be replaced or retired, and a rule turned off', async () => {
    const active = {
      id: 'af1',
      statement: 'Open daily',
      reviewDate: '2027-01-01',
      sources: [source('s9')],
    }
    const activeRule = { id: 'ar1', kind: 'competitor_not_named', text: 'Never name Acme', why: 'Legal' }
    await open(reply({ active: [active], activeRules: [activeRule] }))
    expect(dom.text()).toContain('Open daily')
    expect(dom.text()).toContain('2027-01-01')
    expect(dom.text()).toContain('competitor not to name')

    await press('Replace')
    expect(dom.field('replace-af1-statement')?.value).toBe('Open daily')
    expect(dom.field('replace-af1-date')?.value).toBe('2027-01-01')
    dom.type('replace-af1-statement', 'Open Monday to Saturday')
    dom.type('replace-af1-date', '2027-08-01')
    dom.replies.push(
      { status: 200, body: { factId: 'af2' } },
      { status: 200, body: reply({ active: [active], activeRules: [activeRule] }) },
    )
    await press('Replace fact')
    expect(dom.writes()[0]).toEqual({
      url: `${base}/facts/af1/replace`,
      method: 'POST',
      body: { statement: 'Open Monday to Saturday', reviewDate: '2027-08-01' },
    })

    // Retire asks once.
    await press('Retire')
    expect(dom.writes()).toHaveLength(1)
    dom.replies.push(
      { status: 200, body: { factId: 'af1' } },
      { status: 200, body: reply({ activeRules: [activeRule] }) },
    )
    await press('Yes, retire')
    expect(dom.writes()[1]).toEqual({ url: `${base}/facts/af1/retire`, method: 'POST', body: undefined })

    await press('Turn off')
    expect(dom.writes()).toHaveLength(2)
    dom.replies.push({ status: 200, body: { ruleId: 'ar1' } }, { status: 200, body: reply() })
    await press('Yes, turn off')
    expect(dom.writes()[2]).toEqual({ url: `${base}/rules/ar1/turn-off`, method: 'POST', body: undefined })
  })

  it('an agent question is answered once and the button cannot be pressed twice', async () => {
    const asked = {
      id: 'aq1',
      jobId: 'j1',
      runId: 'r1',
      agent: 'facts_rules',
      question: 'Which year did you start?',
      why: 'Facts need a date.',
      options: ['2015', '2016'],
      suggested: '2015',
      createdAt: T,
      answer: null,
      answeredAt: null,
    }
    dom.replies.push(
      { status: 200, body: reply({ job: { state: 'waiting_for_answer', questionId: 'aq1' } }) },
      { status: 200, body: { questions: [asked] } },
    )
    await dom.mount(<FactsRulesScreen brandId={brandId} />, sessionAs('owner'))
    expect(dom.text()).toContain('Which year did you start?')
    dom.replies.push({ status: 200, body: { questionId: 'aq1', requeued: true } })
    const send = dom.button('Send answer')
    act(() => {
      send.click()
      send.click()
    })
    await dom.settle()
    expect(dom.writes()).toEqual([
      { url: `${base}/agent-questions/aq1/answer`, method: 'POST', body: { answer: '2015' } },
    ])
    expect(dom.text()).toContain('Sent. The job starts again with your answer.')
  })

  it('the overview lists open agent questions above Continue', async () => {
    const asked = {
      id: 'aq2',
      jobId: 'j1',
      runId: 'r1',
      agent: 'research',
      question: 'Is the Pune office open?',
      why: 'It changes the places served.',
      options: [],
      suggested: null,
      createdAt: T,
      answer: null,
      answeredAt: null,
    }
    dom.replies.push(
      {
        status: 200,
        body: {
          step: 'facts_rules',
          intake: null,
          documents: 0,
          research: null,
          openSuggestions: 0,
          questionnaire: null,
          factsRules: null,
          cost: { usdMicros: '0', inrMicros: '0' },
        },
      },
      {
        status: 200,
        body: {
          questions: [asked, { ...asked, id: 'aq3', question: 'Done one', answer: 'yes', answeredAt: T }],
        },
      },
    )
    await dom.mount(<OnboardingScreen brandId={brandId} />, sessionAs('owner'))
    const text = dom.text()
    expect(text).toContain('Is the Pune office open?')
    expect(text).not.toContain('Done one')
    expect(text.indexOf('Is the Pune office open?')).toBeLessThan(text.indexOf('Continue'))
  })

  it('facts and rules are owner-only', async () => {
    dom.replies.push(err(403, 'forbidden', 'x'))
    await dom.mount(<FactsRulesScreen brandId={brandId} />, sessionAs('brand_admin'))
    expect(dom.text()).toContain('Only the platform owner can use onboarding.')
    expect(dom.text()).not.toContain('Confirm')
  })
})
