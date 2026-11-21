// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POLL_MS, QuestionnaireScreen, SAVE_MS } from '../src/screens/Questionnaire'
import { Dom, brandId, sessionAs } from './dom-support'

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {} }),
  usePathname: () => '/b/x/onboarding/questionnaire',
}))

const base = `/api/v1/brands/${brandId}/onboarding`
const question = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  key: `key_${id}`,
  position: 1,
  text: `Question ${id}?`,
  why: `Because of ${id}.`,
  options: [],
  suggestedAnswer: null,
  answer: null,
  ...over,
})
const asking = (questions: unknown[], over: Record<string, unknown> = {}) => ({
  questionnaire: { id: 'z1', finishedAt: null, questions },
  job: { state: 'done' },
  ...over,
})
const FINISHED_WORDS = 'This questionnaire is finished, so its answers cannot change.'

describe('the questionnaire screen, driven', () => {
  const dom = new Dom()
  beforeEach(() => {
    push.mockClear()
    dom.start()
  })
  afterEach(() => {
    vi.useRealTimers()
    dom.stop()
  })

  const radio = (id: string, value: string) =>
    dom.host.querySelector<HTMLInputElement>(`input[name="q-${id}"][value="${value}"]`)!
  const pick = (input: HTMLInputElement) => act(() => input.click())
  const tick = async (ms: number) => {
    await act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
  }
  const open = async (body: unknown) => {
    dom.replies.push({ status: 200, body })
    await dom.mount(<QuestionnaireScreen brandId={brandId} />, sessionAs('owner'))
  }
  const put = (id: string, value: string) => ({
    url: `${base}/questionnaire/answers/${id}`,
    method: 'PUT',
    body: { value },
  })

  it('the suggested answer is pre-selected and saving it is debounced', async () => {
    await open(
      asking([
        question('q1', { options: ['Aztek', 'Aztek Labs'], suggestedAnswer: 'Aztek' }),
        question('q2', { position: 2, suggestedAnswer: 'Pune' }),
      ]),
    )
    expect(radio('q1', 'Aztek').checked).toBe(true)
    expect(radio('q1', 'Aztek Labs').checked).toBe(false)
    expect(dom.field('a-q2')?.value).toBe('Pune')
    expect(dom.text()).toContain('Why we ask: Because of q1.')
    // Nothing is saved until the owner changes something.
    expect(dom.writes()).toEqual([])

    vi.useFakeTimers()
    dom.replies.push({ status: 200, body: { answered: true } })
    dom.type('a-q2', 'Pu')
    await tick(300)
    dom.type('a-q2', 'Pune')
    await tick(300)
    dom.type('a-q2', 'Pune city')
    await tick(SAVE_MS - 1)
    expect(dom.writes()).toEqual([])
    await tick(1)
    expect(dom.writes()).toEqual([put('q2', 'Pune city')])
    expect(dom.text()).toContain('Saved')

    // A radio choice saves the same way, once.
    dom.replies.push({ status: 200, body: { answered: true } })
    pick(radio('q1', 'Aztek Labs'))
    await tick(SAVE_MS)
    expect(dom.writes()).toEqual([put('q2', 'Pune city'), put('q1', 'Aztek Labs')])
  })

  it('an answer that cannot be saved shows the server words beside the question', async () => {
    await open(asking([question('q1')]))
    vi.useFakeTimers()
    dom.replies.push({
      status: 409,
      body: { error: { code: 'questionnaire_finished', message: FINISHED_WORDS } },
    })
    dom.type('a-q1', 'x')
    await tick(SAVE_MS)
    expect(dom.text()).toContain(FINISHED_WORDS)
    expect(dom.text()).not.toContain('Saved')
  })

  it('a typed answer survives a reload', async () => {
    await open(asking([question('q1')]))
    vi.useFakeTimers()
    dom.replies.push({ status: 200, body: { answered: true } })
    dom.type('a-q1', 'Our own words')
    await tick(SAVE_MS)
    expect(dom.writes()).toEqual([put('q1', 'Our own words')])
    vi.useRealTimers()
    dom.stop()
    dom.start()
    // The reload reads what the core kept.
    await open(asking([question('q1', { answer: 'Our own words', suggestedAnswer: 'Something else' })]))
    expect(dom.field('a-q1')?.value).toBe('Our own words')
  })

  it('finish shows answered and blank counts and is refused politely when already finished', async () => {
    await open(asking([question('q1', { answer: 'Aztek' }), question('q2', { position: 2 })]))
    await dom.click('Finish questionnaire')
    expect(dom.text()).toContain('1 answered by you, 0 suggested answers kept, 1 left blank.')
    expect(dom.writes()).toEqual([])

    // A save still waiting is sent before the finish, and the counts follow what is typed.
    dom.type('a-q2', 'Pune')
    expect(dom.text()).toContain('2 answered by you, 0 suggested answers kept, 0 left blank.')
    dom.replies.push(
      { status: 200, body: { answered: true } },
      { status: 200, body: { answered: 2, blank: 0 } },
    )
    await dom.click('Yes, finish')
    expect(dom.writes()).toEqual([
      put('q2', 'Pune'),
      { url: `${base}/questionnaire/finish`, method: 'POST', body: undefined },
    ])
    expect(push).toHaveBeenCalledWith(`/b/${brandId}/onboarding/facts-rules`)
  })

  it('finishing a questionnaire that is already finished says so and keeps the owner on the page', async () => {
    await open(asking([question('q1', { answer: 'Aztek' })]))
    await dom.click('Finish questionnaire')
    dom.replies.push(
      { status: 409, body: { error: { code: 'questionnaire_finished', message: FINISHED_WORDS } } },
      // The screen reads again and now shows the finished state.
      {
        status: 200,
        body: asking([question('q1', { answer: 'Aztek' })], {
          questionnaire: {
            id: 'z1',
            finishedAt: '2026-11-21T10:00:00.000Z',
            questions: [question('q1', { answer: 'Aztek' })],
          },
        }),
      },
    )
    await dom.click('Yes, finish')
    expect(dom.text()).toContain(FINISHED_WORDS)
    expect(dom.text()).toContain('This questionnaire is finished. Its answers are kept.')
    expect(push).not.toHaveBeenCalled()
  })

  it('finish states the owner answers, the kept suggestions and the blanks separately', async () => {
    await open(
      asking([
        question('q1', { answer: 'Aztek' }),
        question('q2', { position: 2, suggestedAnswer: 'Pune' }),
        question('q3', { position: 3, suggestedAnswer: 'Goa' }),
        question('q4', { position: 4 }),
      ]),
    )
    dom.type('a-q3', 'Goa, India')
    await dom.click('Finish questionnaire')
    expect(dom.text()).toContain(
      '2 answered by you, 1 suggested answer kept, 1 left blank. The kept suggestions become your answers.',
    )
    dom.replies.push(
      { status: 200, body: { answered: true } },
      { status: 200, body: { answered: true } },
      { status: 200, body: { answered: 3, blank: 1 } },
    )
    await dom.click('Yes, finish')
    expect(dom.writes().map((w) => w.url)).toEqual([
      `${base}/questionnaire/answers/q2`,
      `${base}/questionnaire/answers/q3`,
      `${base}/questionnaire/finish`,
    ])
  })

  it('the questionnaire is owner-only', async () => {
    dom.replies.push({ status: 403, body: { error: { code: 'forbidden', message: 'No.' } } })
    await dom.mount(<QuestionnaireScreen brandId={brandId} />, sessionAs('owner'))
    expect(dom.text()).toBe('Only the platform owner can use onboarding.')
    expect(dom.host.querySelector('button, input, textarea')).toBeNull()
  })

  it('a questionnaire that was never started offers to prepare it, then shows the job', async () => {
    await open({ questionnaire: null, job: null })
    dom.replies.push(
      { status: 200, body: { runId: 'r1', jobId: 'j1' } },
      { status: 200, body: { questionnaire: null, job: { state: 'waiting' } } },
    )
    await dom.click('Prepare the questionnaire')
    expect(dom.writes()).toEqual([{ url: `${base}/questionnaire`, method: 'POST', body: undefined }])
    expect(dom.text()).toContain('The questionnaire is queued.')
    expect(dom.host.textContent).not.toContain('Prepare the questionnaire')
  })

  it('an agent question shows at the top, is sent once, and a 409 shows the server words', async () => {
    const asked = {
      id: 'aq1',
      jobId: 'j1',
      runId: 'r1',
      agent: 'questionnaire',
      question: 'Which year did the business start?',
      why: 'The site shows two years.',
      options: ['2009', '2012'],
      suggested: '2012',
      createdAt: '2026-11-21T08:00:00.000Z',
      answer: null,
      answeredAt: null,
    }
    dom.replies.push(
      { status: 200, body: { questionnaire: null, job: { state: 'waiting_for_answer', questionId: 'aq1' } } },
      { status: 200, body: { questions: [asked] } },
    )
    await dom.mount(<QuestionnaireScreen brandId={brandId} />, sessionAs('owner'))
    expect(dom.text()).toContain('Which year did the business start?')
    expect(dom.text()).toContain('Why we ask: The site shows two years.')
    expect(dom.text()).not.toContain('could not be written')
    const suggested = dom.host.querySelector<HTMLInputElement>('input[name="aq-aq1"][value="2012"]')!
    expect(suggested.checked).toBe(true)

    const answerUrl = `${base}/agent-questions/aq1/answer`
    dom.replies.push({
      status: 409,
      body: {
        error: {
          code: 'already_answered',
          message: 'This question already has an answer. Reload to see it.',
        },
      },
    })
    await dom.click('Send answer')
    expect(dom.text()).toContain('This question already has an answer. Reload to see it.')
    expect(dom.button('Send answer').disabled).toBe(false)

    dom.type('aq-own-aq1', 'In 2010')
    dom.replies.push({ status: 200, body: { questionId: 'aq1', requeued: true } })
    await dom.click('Send answer')
    expect(dom.text()).toContain('Sent. The job starts again with your answer.')
    expect(dom.host.textContent).not.toContain('Send answer')
    expect(dom.writes()).toEqual([
      { url: answerUrl, method: 'POST', body: { answer: '2012' } },
      { url: answerUrl, method: 'POST', body: { answer: 'In 2010' } },
    ])
  })

  it('a typed answer still waiting is saved when the owner leaves the page', async () => {
    await open(asking([question('q1')]))
    dom.replies.push({ status: 200, body: { answered: true } })
    dom.type('a-q1', 'Typed just now')
    expect(dom.writes()).toEqual([])
    // Leave the page the way the screen sees it (unmount), keeping the stubbed platform for the late save.
    const internals = dom as unknown as { root: { unmount(): void } | null }
    act(() => internals.root?.unmount())
    internals.root = null
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(dom.writes()).toEqual([put('q1', 'Typed just now')])
  })

  it('a save refused because the questionnaire is finished re-reads, so the form becomes read-only', async () => {
    await open(asking([question('q1')]))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const done = question('q1', { answer: 'Kept' })
    dom.replies.push(
      { status: 409, body: { error: { code: 'questionnaire_finished', message: FINISHED_WORDS } } },
      {
        status: 200,
        body: asking([done], {
          questionnaire: { id: 'z1', finishedAt: '2026-11-21T10:00:00.000Z', questions: [done] },
        }),
      },
    )
    dom.type('a-q1', 'x')
    await tick(SAVE_MS)
    await tick(0)
    expect(dom.text()).toContain('This questionnaire is finished. Its answers are kept.')
    expect(dom.field('a-q1')?.disabled).toBe(true)
  })

  it('Finish sends once however often it is pressed', async () => {
    await open(asking([question('q1', { answer: 'Aztek' })]))
    await dom.click('Finish questionnaire')
    dom.replies.push({ status: 200, body: { answered: 1, blank: 0 } })
    const yes = dom.button('Yes, finish')
    act(() => {
      yes.click()
      yes.click()
    })
    await dom.settle()
    expect(dom.writes().filter((w) => w.url.endsWith('/finish'))).toHaveLength(1)
  })

  it('an answer refused as already given makes the screen read again', async () => {
    const asked = {
      id: 'aq1',
      jobId: 'j1',
      runId: 'r1',
      agent: 'questionnaire',
      question: 'Which year?',
      why: 'Two years show.',
      options: [],
      suggested: null,
      createdAt: '2026-11-21T08:00:00.000Z',
      answer: null,
      answeredAt: null,
    }
    dom.replies.push(
      { status: 200, body: { questionnaire: null, job: { state: 'waiting_for_answer', questionId: 'aq1' } } },
      { status: 200, body: { questions: [asked] } },
    )
    await dom.mount(<QuestionnaireScreen brandId={brandId} />, sessionAs('owner'))
    dom.type('aq-own-aq1', '2010')
    // The job has moved on: the re-read shows it running, so the question goes.
    dom.replies.push(
      {
        status: 409,
        body: {
          error: {
            code: 'already_answered',
            message: 'This question already has an answer. Reload to see it.',
          },
        },
      },
      { status: 200, body: { questionnaire: null, job: { state: 'running' } } },
    )
    const gets = () => dom.calls.filter((c) => c.method === 'GET').length
    const before = gets()
    await dom.click('Send answer')
    expect(gets()).toBe(before + 1)
    expect(dom.text()).not.toContain('Which year?')
    expect(dom.text()).toContain('The questionnaire is being written.')
  })

  describe('polling', () => {
    const flush = async () => {
      for (let i = 0; i < 10; i += 1) await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    }
    const gets = () => dom.calls.filter((c) => c.method === 'GET').length
    const running = { status: 200, body: { questionnaire: null, job: { state: 'running' } } }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      dom.settle = flush
    })

    it('a running job is read again after 5 seconds', async () => {
      expect(POLL_MS).toBe(5000)
      dom.replies.push(running, running)
      await dom.mount(<QuestionnaireScreen brandId={brandId} />, sessionAs('owner'))
      expect(gets()).toBe(1)
      await tick(4999)
      expect(gets()).toBe(1)
      await tick(1)
      await flush()
      expect(gets()).toBe(2)
    })

    it('a 404 stops the polling and says so', async () => {
      dom.replies.push(running, { status: 404, body: { error: { code: 'not_found', message: 'x' } } })
      await dom.mount(<QuestionnaireScreen brandId={brandId} />, sessionAs('owner'))
      await tick(5000)
      await flush()
      expect(dom.text()).toContain('This brand was not found.')
      const before = gets()
      await tick(20_000)
      expect(gets()).toBe(before)
    })

    it('there is no further read after the screen is left', async () => {
      dom.replies.push(running, running)
      await dom.mount(<QuestionnaireScreen brandId={brandId} />, sessionAs('owner'))
      // Unmount the root and keep the recording stub, so a poll that outlives the screen would be seen.
      const internals = dom as unknown as { root: { unmount(): void } | null }
      act(() => internals.root?.unmount())
      internals.root = null
      await tick(20_000)
      expect(gets()).toBe(1)
    })
  })
})
