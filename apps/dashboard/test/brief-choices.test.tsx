// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BriefChoicesScreen } from '../src/screens/BriefChoices'
import { FactsRulesScreen } from '../src/screens/FactsRules'
import { OnboardingScreen, POLL_MS as OVERVIEW_POLL_MS } from '../src/screens/Onboarding'
import { Dom, brandId, sessionAs } from './dom-support'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => '/b/x/onboarding/brief-choices',
}))

const base = `/api/v1/brands/${brandId}/onboarding`
const T = '2026-11-22T10:00:00.000Z'
// Said when the strategist job failed: a fact may have changed mid-run (422 unknown_fact), or no release.
const BRIEF_FAILED_WORDS =
  'The brief could not be written. A fact may have changed while it was being written, or the agent is not released. Write it again.'
const itemId = 'b1111111-1111-4111-8111-111111111111'

const choice = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  key: `key-${id}`,
  question: `Question ${id}`,
  why: `Why ${id}`,
  options: [
    { value: `Alpha ${id}`, tradeOff: `Alpha costs ${id}`, recommended: true },
    { value: `Beta ${id}`, tradeOff: `Beta costs ${id}`, recommended: false },
  ],
  decision: null,
  picked: null,
  ...over,
})
const choices = (list: unknown[], job: unknown = { state: 'done' }) => ({ job, choices: list })
const overview = (over: Record<string, unknown> = {}) => ({
  step: 'brief_choices',
  intake: null,
  documents: 0,
  research: null,
  openSuggestions: 0,
  questionnaire: null,
  factsRules: null,
  briefChoices: null,
  brief: null,
  briefJob: null,
  gate1: false,
  cost: { usdMicros: '0', inrMicros: '0' },
  ...over,
})
const brief = (over: Record<string, unknown> = {}) => ({
  itemId,
  versionId: 'v1',
  number: 1,
  state: 'awaiting_approval',
  revision: 0,
  needsDecision: false,
  ...over,
})

function radio(dom: Dom, id: string): HTMLInputElement {
  const el = dom.field(id) as HTMLInputElement | null
  if (!el) throw new Error(`no radio #${id} in: ${dom.text()}`)
  return el
}
async function choose(dom: Dom, id: string) {
  act(() => radio(dom, id).click())
  await dom.settle()
}

describe('the brief choices screen, driven', () => {
  const dom = new Dom()
  beforeEach(() => dom.start())
  afterEach(() => dom.stop())

  const open = async (
    list: unknown,
    over: Record<string, unknown> = {},
    extra: Array<{ status: number; body?: unknown }> = [],
  ) => {
    dom.replies.push({ status: 200, body: list }, { status: 200, body: overview(over) }, ...extra)
    await dom.mount(<BriefChoicesScreen brandId={brandId} />, sessionAs('owner'))
  }

  it('the recommended option is pre-selected and Save my picks sends one decision per choice', async () => {
    await open(
      choices([choice('c1'), choice('c2'), choice('c3', { decision: 'accepted', picked: 'Alpha c3' })]),
    )
    expect(dom.text()).toContain('Question c1')
    expect(dom.text()).toContain('Why c1')
    expect(dom.text()).toContain('Alpha costs c1')
    expect(dom.text()).toContain('Recommended')
    expect(radio(dom, 'choice-c1-opt-0').checked).toBe(true)
    expect(radio(dom, 'choice-c2-opt-0').checked).toBe(true)
    // A decided choice shows its pick, not radios.
    expect(dom.text()).toContain('Alpha c3')
    expect(dom.field('choice-c3-opt-0')).toBeNull()
    await choose(dom, 'choice-c2-opt-1')
    dom.replies.push(
      { status: 200, body: { createdId: null } },
      { status: 200, body: { createdId: null } },
      { status: 200, body: choices([]) },
      { status: 200, body: overview() },
    )
    await dom.click('Save my picks')
    expect(dom.writes()).toEqual([
      { url: `${base}/suggestions/c1/decision`, method: 'POST', body: { decision: 'accepted' } },
      {
        url: `${base}/suggestions/c2/decision`,
        method: 'POST',
        body: { decision: 'edited', value: { value: 'Beta c2' } },
      },
    ])
    expect(dom.text()).toContain('Picks saved.')
  })

  it("Other sends the owner's words as an edit", async () => {
    await open(choices([choice('c1')]))
    await choose(dom, 'choice-c1-other-radio')
    dom.type('choice-c1-other', 'Neither, we sell only to schools')
    dom.replies.push(
      { status: 200, body: { createdId: null } },
      { status: 200, body: choices([]) },
      { status: 200, body: overview() },
    )
    await dom.click('Save my picks')
    expect(dom.writes()).toEqual([
      {
        url: `${base}/suggestions/c1/decision`,
        method: 'POST',
        body: { decision: 'edited', value: { value: 'Neither, we sell only to schools' } },
      },
    ])
  })

  it('finds the choices, then writes the brief once every choice is decided', async () => {
    await open(choices([], null))
    dom.replies.push(
      { status: 202, body: { runId: 'r1', jobId: 'j1' } },
      { status: 200, body: choices([choice('c1', { decision: 'accepted', picked: 'Alpha c1' })]) },
      { status: 200, body: overview() },
    )
    await dom.click('Find the open choices')
    expect(dom.writes()[0]).toMatchObject({ url: `${base}/brief-choices`, method: 'POST' })
    expect(dom.text()).toContain('Alpha c1')
    dom.replies.push(
      { status: 202, body: { runId: 'r2', jobId: 'j2', revision: 0 } },
      { status: 200, body: choices([choice('c1', { decision: 'accepted', picked: 'Alpha c1' })]) },
      { status: 200, body: overview({ briefJob: { state: 'running' } }) },
    )
    await dom.click('Write the strategy brief')
    expect(dom.writes()[1]).toMatchObject({ url: `${base}/brief`, method: 'POST' })
    expect(dom.text()).toContain('Writing the brief…')
  })

  it('shows the refusal in plain words', async () => {
    await open(choices([], null))
    dom.replies.push({
      status: 409,
      body: { error: { code: 'facts_rules_open', message: 'Decide the open facts and rules first.' } },
    })
    await dom.click('Find the open choices')
    expect(dom.text()).toContain('Decide the open facts and rules first.')
  })

  it('a decided pick that is one of the options says Your pick; typed text says Your own words', async () => {
    await open(
      choices([
        choice('c1', { decision: 'edited', picked: 'Beta c1' }),
        choice('c2', { decision: 'edited', picked: 'Neither, schools only' }),
        choice('c3', { decision: 'accepted', picked: 'Alpha c3' }),
      ]),
    )
    const tags = [...dom.host.querySelectorAll('.tag.ok')].map((t) => t.textContent)
    expect(tags).toEqual(['Your pick', 'Your own words', 'Accepted'])
  })

  it('a failed strategist job says so and offers Write the strategy brief', async () => {
    await open(choices([choice('c1', { decision: 'accepted', picked: 'Alpha c1' })]), {
      briefJob: { state: 'failed' },
    })
    expect(dom.text()).toContain(BRIEF_FAILED_WORDS)
    dom.replies.push(
      { status: 202, body: { runId: 'r', jobId: 'j', revision: 0 } },
      { status: 200, body: choices([choice('c1', { decision: 'accepted', picked: 'Alpha c1' })]) },
      { status: 200, body: overview({ briefJob: { state: 'running' } }) },
    )
    await dom.click('Write the strategy brief')
    expect(dom.writes()[0]).toMatchObject({ url: `${base}/brief`, method: 'POST' })
  })

  it('Write the brief again shows for a rejected, invalidated or revision-limit brief while nothing is being written', async () => {
    const decided = [choice('c1', { decision: 'accepted', picked: 'Alpha c1' })]
    const shows = async (over: Record<string, unknown>) => {
      dom.stop()
      dom.start()
      await open(choices(decided), over)
      return dom.buttons('Write the brief again').length === 1
    }
    // Rejected by the owner, or closed by a change request whose rewrite could not start: no job going.
    expect(await shows({ brief: brief({ state: 'rejected' }) })).toBe(true)
    expect(dom.text()).toContain('The brief was closed and no new version is being written.')
    expect(await shows({ brief: brief({ state: 'rejected' }), briefJob: { state: 'done' } })).toBe(true)
    // A rewrite is queued, running or waiting on a question: nothing to offer.
    for (const state of ['waiting', 'running', 'waiting_for_answer'])
      expect(await shows({ brief: brief({ state: 'rejected' }), briefJob: { state } }), state).toBe(false)
    expect(await shows({ brief: brief({ state: 'invalidated' }) })).toBe(true)
    expect(await shows({ brief: brief({ state: 'invalidated' }), briefJob: { state: 'running' } })).toBe(
      false,
    )
    expect(await shows({ brief: brief({ state: 'rejected', revision: 3, needsDecision: true }) })).toBe(true)
    expect(dom.text()).toContain('The brief was revised three times. Write it again from onboarding.')
    // Waiting for approval or approved: nothing to write again.
    expect(await shows({ brief: brief() })).toBe(false)
    expect(await shows({ brief: brief({ state: 'approved' }) })).toBe(false)
  })

  it('Write the brief again on a rejected brief starts the strategist', async () => {
    const decided = [choice('c1', { decision: 'accepted', picked: 'Alpha c1' })]
    await open(choices(decided), { step: 'brief', brief: brief({ state: 'rejected' }) })
    dom.replies.push(
      { status: 202, body: { runId: 'r', jobId: 'j', revision: 0 } },
      { status: 200, body: choices(decided) },
      {
        status: 200,
        body: overview({
          step: 'brief',
          brief: brief({ state: 'rejected' }),
          briefJob: { state: 'waiting' },
        }),
      },
    )
    await dom.click('Write the brief again')
    expect(dom.writes()).toHaveLength(1)
    expect(dom.writes()[0]).toMatchObject({ url: `${base}/brief`, method: 'POST' })
    expect(dom.text()).toContain('Writing the brief…')
    expect(dom.buttons('Write the brief again')).toHaveLength(0)
  })

  it('links to the brief while it waits for approval', async () => {
    await open(choices([choice('c1', { decision: 'accepted', picked: 'Alpha c1' })]), {
      brief: brief(),
      briefJob: { state: 'done' },
    })
    expect(dom.text()).toContain('The brief is waiting for your approval.')
    const link = [...dom.host.querySelectorAll('a')].find((a) => a.textContent === 'Review the brief')
    expect(link?.getAttribute('href')).toBe(`/b/${brandId}/inbox/${itemId}`)
  })

  it('an edited suggestion can be added as a case', async () => {
    const edited = {
      id: 'f1',
      step: 'fact',
      key: 'k-f1',
      proposed: { statement: 'Old wording', reviewDate: '2027-03-01' },
      why: 'Why f1',
      confidence: 'found',
      options: null,
      decision: 'edited',
      decidedValue: { statement: 'New wording', reviewDate: '2027-03-01' },
      decidedReason: null,
      decidedAt: T,
      createdAt: T,
      sources: [],
    }
    dom.replies.push({
      status: 200,
      body: {
        job: { state: 'done' },
        facts: { suggestions: [edited], active: [] },
        rules: { suggestions: [], active: [] },
      },
    })
    await dom.mount(<FactsRulesScreen brandId={brandId} />, sessionAs('owner'))
    dom.replies.push({ status: 201, body: { caseId: 'case1' } })
    await dom.click('Add as a case')
    expect(dom.writes()).toEqual([{ url: `${base}/suggestions/f1/case`, method: 'POST', body: {} }])
    expect(dom.text()).toContain('Added as a candidate case.')
  })

  it('says Already added when the case exists', async () => {
    const dropped = {
      id: 'r1',
      step: 'rule',
      key: 'k-r1',
      proposed: { kind: 'forbidden_claim', text: 'No claims' },
      why: 'Why r1',
      confidence: 'found',
      options: null,
      decision: 'rejected',
      decidedValue: null,
      decidedReason: null,
      decidedAt: T,
      createdAt: T,
      sources: [],
    }
    dom.replies.push({
      status: 200,
      body: {
        job: { state: 'done' },
        facts: { suggestions: [], active: [] },
        rules: { suggestions: [dropped], active: [] },
      },
    })
    await dom.mount(<FactsRulesScreen brandId={brandId} />, sessionAs('owner'))
    dom.replies.push({
      status: 409,
      body: { error: { code: 'already_added', message: 'It was already added.' } },
    })
    await dom.click('Add as a case')
    expect(dom.text()).toContain('Already added.')
  })
})

describe('the overview, brief and examples', () => {
  const dom = new Dom()
  beforeEach(() => dom.start())
  afterEach(() => dom.stop())

  const show = async (over: Record<string, unknown>) => {
    dom.replies.push({ status: 200, body: overview(over) }, { status: 200, body: { questions: [] } })
    await dom.mount(<OnboardingScreen brandId={brandId} />, sessionAs('owner'))
  }

  it('the overview shows Onboarded when gate 1 holds and re-approval when the brief is invalidated', async () => {
    await show({ step: 'done', gate1: true, brief: brief({ state: 'approved' }) })
    expect(dom.text()).toContain('Onboarded: the strategy brief is approved.')
    expect(dom.text()).not.toContain('needs re-approval')
    dom.stop()
    dom.start()
    await show({ step: 'brief', brief: brief({ state: 'invalidated' }) })
    expect(dom.text()).toContain('The brief needs re-approval: a fact it cites changed.')
    expect(dom.text()).not.toContain('Onboarded: the strategy brief is approved.')
    dom.replies.push(
      { status: 202, body: { runId: 'r', jobId: 'j', revision: 0 } },
      { status: 200, body: overview({ briefJob: { state: 'running' } }) },
      { status: 200, body: { questions: [] } },
    )
    await dom.click('Write the brief again')
    expect(dom.writes()[0]).toMatchObject({ url: `${base}/brief`, method: 'POST' })
  })

  it('a failed strategist job on the overview says so and offers Write the strategy brief', async () => {
    await show({ step: 'brief', briefJob: { state: 'failed' } })
    expect(dom.text()).toContain(BRIEF_FAILED_WORDS)
    expect(dom.text()).not.toContain("check the agents' releases")
    dom.replies.push(
      { status: 202, body: { runId: 'r', jobId: 'j', revision: 0 } },
      { status: 200, body: overview({ briefJob: { state: 'running' } }) },
      { status: 200, body: { questions: [] } },
    )
    await dom.click('Write the strategy brief')
    expect(dom.writes()[0]).toMatchObject({ url: `${base}/brief`, method: 'POST' })
  })

  it('a rejected brief that is being revised offers no Write the brief again on the overview', async () => {
    for (const state of ['waiting', 'running', 'waiting_for_answer']) {
      dom.stop()
      dom.start()
      await show({ step: 'brief', brief: brief({ state: 'rejected' }), briefJob: { state } })
      expect(dom.buttons('Write the brief again'), state).toHaveLength(0)
      expect(dom.text()).not.toContain('The brief was closed')
    }
  })

  it('a rejected brief with nothing being written offers Write the brief again on the overview', async () => {
    // The owner rejected it, or a change request closed it and its rewrite could not start.
    for (const briefJob of [null, { state: 'done' }]) {
      dom.stop()
      dom.start()
      await show({ step: 'brief', brief: brief({ state: 'rejected' }), briefJob })
      expect(dom.text()).toContain('The brief was closed and no new version is being written.')
      expect(dom.buttons('Write the brief again')).toHaveLength(1)
    }
    dom.replies.push(
      { status: 202, body: { runId: 'r', jobId: 'j', revision: 0 } },
      {
        status: 200,
        body: overview({
          step: 'brief',
          brief: brief({ state: 'rejected' }),
          briefJob: { state: 'waiting' },
        }),
      },
    )
    await dom.click('Write the brief again')
    expect(dom.writes()).toHaveLength(1)
    expect(dom.writes()[0]).toMatchObject({ url: `${base}/brief`, method: 'POST' })
    expect(dom.text()).toContain('Writing the brief…')
    expect(dom.buttons('Write the brief again')).toHaveLength(0)
  })

  it('shows the revision limit, offers Write the brief again, and Continue leads to the brief in the inbox', async () => {
    await show({ step: 'brief', brief: brief({ state: 'rejected', revision: 3, needsDecision: true }) })
    expect(dom.text()).toContain('The brief was revised three times. Write it again from onboarding.')
    expect(dom.text()).not.toContain('Approve it, reject it')
    expect(dom.text()).not.toContain('The brief was closed')
    expect(dom.buttons('Write the brief again')).toHaveLength(1)
    const cont = [...dom.host.querySelectorAll('a')].find((a) => a.textContent === 'Continue')
    expect(cont?.getAttribute('href')).toBe(`/b/${brandId}/inbox/${itemId}`)
  })

  it('Continue leads to the brief choices at that step', async () => {
    await show({ step: 'brief_choices' })
    const cont = [...dom.host.querySelectorAll('a')].find((a) => a.textContent === 'Continue')
    expect(cont?.getAttribute('href')).toBe(`/b/${brandId}/onboarding/brief-choices`)
    expect(dom.text()).toContain('Brief choices')
  })

  it('the examples form posts and confirms', async () => {
    await show({ step: 'done', gate1: true, brief: brief({ state: 'approved' }) })
    expect(dom.text()).toContain('Examples of good and bad posts')
    act(() => (dom.field('example-bad') as HTMLInputElement).click())
    dom.type('example-text', 'Buy now or never!!!')
    dom.type('example-note', 'Too pushy')
    dom.replies.push({ status: 201, body: { caseId: 'c9' } })
    await dom.submit('Add the example')
    expect(dom.writes()).toEqual([
      {
        url: `${base}/examples`,
        method: 'POST',
        body: { example: 'bad', text: 'Buy now or never!!!', note: 'Too pushy' },
      },
    ])
    expect(dom.text()).toContain('Added as a candidate case.')
  })

  describe('polling while the brief is being written', () => {
    const flush = async () => {
      for (let i = 0; i < 10; i += 1) await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    }
    const tick = async (ms: number) => {
      await act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
      await flush()
    }
    const overviewReads = () => dom.calls.filter((c) => c.method === 'GET' && c.url === base).length
    const typed = () => (dom.field('example-text') as HTMLTextAreaElement).value

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      dom.settle = flush
    })
    afterEach(() => vi.useRealTimers())

    it('reads the overview every 5 seconds in place, keeps a half-typed example, and stops once the job ends', async () => {
      expect(OVERVIEW_POLL_MS).toBe(5000)
      dom.replies.push(
        { status: 200, body: overview({ step: 'brief', briefJob: { state: 'running' } }) },
        { status: 200, body: { questions: [] } },
        { status: 200, body: overview({ step: 'brief', briefJob: { state: 'running' } }) },
        { status: 200, body: overview({ step: 'brief', brief: brief(), briefJob: { state: 'done' } }) },
      )
      await dom.mount(<OnboardingScreen brandId={brandId} />, sessionAs('owner'))
      expect(dom.text()).toContain('Writing the brief…')
      dom.type('example-text', 'Half typed')
      await tick(4999)
      expect(overviewReads()).toBe(1)
      await tick(1)
      expect(overviewReads()).toBe(2)
      expect(dom.text()).not.toContain('Loading…')
      await tick(5000)
      expect(overviewReads()).toBe(3)
      expect(dom.text()).not.toContain('Writing the brief…')
      expect(dom.text()).toContain('The brief is waiting for your approval.')
      // The examples form was never remounted.
      expect(typed()).toBe('Half typed')
      await tick(20_000)
      expect(overviewReads()).toBe(3)
    })

    it('starts after Write the brief again, without a reload, and stops when the job fails', async () => {
      dom.replies.push(
        { status: 200, body: overview({ step: 'brief', brief: brief({ state: 'rejected' }) }) },
        { status: 200, body: { questions: [] } },
      )
      await dom.mount(<OnboardingScreen brandId={brandId} />, sessionAs('owner'))
      dom.type('example-text', 'Half typed')
      dom.replies.push(
        { status: 202, body: { runId: 'r', jobId: 'j', revision: 0 } },
        {
          status: 200,
          body: overview({
            step: 'brief',
            brief: brief({ state: 'rejected' }),
            briefJob: { state: 'waiting' },
          }),
        },
        {
          status: 200,
          body: overview({
            step: 'brief',
            brief: brief({ state: 'rejected' }),
            briefJob: { state: 'failed' },
          }),
        },
      )
      await dom.click('Write the brief again')
      expect(overviewReads()).toBe(2)
      expect(dom.text()).toContain('Writing the brief…')
      expect(typed()).toBe('Half typed')
      await tick(5000)
      expect(overviewReads()).toBe(3)
      expect(dom.text()).toContain(BRIEF_FAILED_WORDS)
      await tick(20_000)
      expect(overviewReads()).toBe(3)
      expect(typed()).toBe('Half typed')
    })

    it('stops when the overview is left', async () => {
      dom.replies.push(
        { status: 200, body: overview({ step: 'brief', briefJob: { state: 'running' } }) },
        { status: 200, body: { questions: [] } },
      )
      await dom.mount(<OnboardingScreen brandId={brandId} />, sessionAs('owner'))
      dom.stop()
      // dom.stop removes the recording fetch; any read after leaving would reach this one.
      const after = vi.fn(async () => new Response('{}', { status: 500 }))
      vi.stubGlobal('fetch', after)
      await tick(20_000)
      expect(after).not.toHaveBeenCalled()
      expect(overviewReads()).toBe(1)
    })
  })
})
