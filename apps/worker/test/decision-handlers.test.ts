import { describe, expect, it } from 'vitest'
import { BASELINE_NEEDED, CHOICE_KEYS, QUESTION_KEYS, SAFETY_KEYS } from '@mkt/shared'
import { ModelStopped, type ModelRequest } from '../src/model.ts'
import { JobWaiting, type JobContext } from '../src/runner.ts'
import type { AgentQuestion } from '../src/core-client.ts'
import { questionnaireHandler, withoutLoneOptions } from '../src/agents/questionnaire.ts'
import { factsRulesHandler } from '../src/agents/facts-rules.ts'
import { briefChoicesHandler } from '../src/agents/brief-choices.ts'
import { strategistHandler } from '../src/agents/strategist.ts'
import { NO_DOCUMENTS } from './no-documents.ts'

const SRC = '11111111-1111-4111-8111-111111111111'
const ANSWER_SRC = '22222222-2222-4222-8222-222222222222'
const ask = { text: 'Which city?', why: 'Needed for local copy.', options: ['A', 'B'], suggested: 'A' }
const answered = {
  question: 'Which city?',
  why: 'w',
  options: ['A', 'B'],
  answer: 'Pune <b>',
  sourceId: ANSWER_SRC,
}

const questionnaireInput = {
  brandName: 'Aztek',
  profile: [],
  open: [],
  gaps: [],
  unreadable: [],
  competitors: [],
}
const factsRulesInput = {
  today: '2026-11-21',
  brandName: 'Aztek',
  sources: [{ id: SRC, kind: 'site', address: null, documentName: null, extract: 'We open at 9.' }],
  profile: [],
  answers: [],
}

function questions() {
  const keys = [...new Set([...SAFETY_KEYS, ...QUESTION_KEYS])].slice(0, 12)
  return keys.map((key) => ({ key, text: `About ${key}?`, why: 'w', options: [], suggestedAnswer: null }))
}
const questionnaireOk = { questions: questions(), ask: null }
const questionnaireAsk = { questions: [], ask }
const factsOk = {
  facts: [{ statement: 'Opens at 9.', why: 'w', sourceIds: [SRC], reviewDate: '2027-01-01' }],
  rules: [],
  ask: null,
}
const factsAsk = { facts: [], rules: [], ask }
const briefChoicesInput = {
  brandName: 'Aztek',
  profile: [],
  facts: [{ id: SRC, statement: 'We open at 9.' }],
  rules: [],
  answers: [],
}
const briefChoicesOk = {
  choices: CHOICE_KEYS.slice(0, 3).map((key) => ({
    key,
    question: `About ${key}?`,
    why: 'w',
    options: [
      { value: 'A', tradeOff: 'Reaches many, costs more.', recommended: true },
      { value: 'B', tradeOff: 'Reaches few, costs less.', recommended: false },
    ],
  })),
  ask: null,
}
const briefChoicesAsk = { choices: [], ask }
const strategistInput = {
  ...briefChoicesInput,
  today: '2026-11-22',
  picks: [{ key: 'lead_audience', question: 'Who first?', picked: 'Installers', notTaken: ['Car owners'] }],
  baseline: null,
  changeRequest: null,
}
const strategistOk = {
  brief: {
    positioning: {
      statement: 'Open at 9, every day.',
      paragraph: 'We open at 9 and serve installers first.',
    },
    audiences: [
      { name: 'Installers', needs: 'Reliable stock', message: 'We open at 9.', where: 'Instagram' },
    ],
    themes: ['A', 'B', 'C', 'D'].map((name) => ({ name, why: 'w', topics: ['t1', 't2'] })),
    channels: [{ channel: 'Instagram', audiences: ['Installers'], why: 'They look there.' }],
    cadence: [{ channel: 'Instagram', postsPerWeek: 3 }],
    goals: [{ metric: 'Enquiries a month', from: BASELINE_NEEDED, to: '20' }],
    choicesMade: [{ key: 'lead_audience', picked: 'Installers', notTaken: ['Car owners'] }],
    factIds: [SRC],
  },
  ask: null,
}
const strategistAsk = { brief: null, ask }

function stub(
  reply: { text: string; stopReason?: string | null },
  input: unknown,
  answers: JobContext['answers'] = [],
) {
  const requests: { step: string; request: ModelRequest }[] = []
  const asked: AgentQuestion[] = []
  const ctx: JobContext = {
    jobId: 'j',
    jobClass: 'production',
    input,
    deadline: new Date(8.64e15),
    answers,
    async ask(question) {
      asked.push(question)
      throw new JobWaiting('q1')
    },
    async modelStep(step, request) {
      requests.push({ step, request })
      return reply
    },
    async checkStop() {},
    ...NO_DOCUMENTS,
  }
  return { ctx, requests, asked }
}
const end = (value: unknown) => ({ text: JSON.stringify(value), stopReason: 'end_turn' })

const cases = [
  {
    name: 'questionnaire',
    step: 'questionnaire',
    type: 'questionnaire.v1',
    handler: questionnaireHandler,
    input: questionnaireInput,
    ok: questionnaireOk,
    asks: questionnaireAsk,
  },
  {
    name: 'facts and rules',
    step: 'facts_rules',
    type: 'facts_rules.v1',
    handler: factsRulesHandler,
    input: factsRulesInput,
    ok: factsOk,
    asks: factsAsk,
  },
  {
    name: 'brief choices',
    step: 'brief_choices',
    type: 'brief_choices.v1',
    handler: briefChoicesHandler,
    input: briefChoicesInput,
    ok: briefChoicesOk,
    asks: briefChoicesAsk,
  },
  {
    name: 'strategist',
    step: 'strategist',
    type: 'strategy_brief.v1',
    handler: strategistHandler,
    input: strategistInput,
    ok: strategistOk,
    asks: strategistAsk,
  },
] as const

for (const c of cases) {
  describe(`the ${c.name} handler`, () => {
    it(`sends no tools and the output schema, and returns ${c.type}`, async () => {
      const { ctx, requests } = stub(end(c.ok), c.input)
      expect(await c.handler(ctx)).toEqual({ type: c.type, result: c.ok })
      expect(requests).toHaveLength(1)
      const { step, request } = requests[0]!
      expect(step).toBe(c.step)
      expect(request.tools).toBeUndefined()
      expect(request.outputSchema).toBeDefined()
      expect(request.model).toBe('claude-sonnet-5-5')
      expect(request.effort).toBe('medium')
      expect(request.maxTokens).toBe(16000)
    })

    it('a reply that asks becomes ctx.ask and no result', async () => {
      const { ctx, asked } = stub(end(c.asks), c.input)
      await expect(c.handler(ctx)).rejects.toBeInstanceOf(JobWaiting)
      expect(asked).toEqual([
        { question: ask.text, why: ask.why, options: ask.options, suggested: ask.suggested },
      ])
    })

    it('earlier answers to agent questions reach the request as owner answers', async () => {
      const first = stub(end(c.ok), c.input)
      await c.handler(first.ctx)
      const resumed = stub(end(c.ok), c.input, [answered])
      await c.handler(resumed.ctx)
      const text = JSON.stringify(resumed.requests[0]!.request.messages)
      expect(text).toContain('owner_answer')
      expect(text).toContain('Pune')
      expect(JSON.stringify(resumed.requests[0]!.request)).not.toBe(
        JSON.stringify(first.requests[0]!.request),
      )
    })

    it.each([
      ['not JSON', { text: 'nope', stopReason: 'end_turn' }],
      ['a result of the wrong shape', end({ nothing: true })],
      ['a result that asks and holds items', end({ ...c.ok, ask })],
    ])('an invalid reply fails the attempt: %s', async (_n, reply) => {
      const { ctx, asked } = stub(reply, c.input)
      await expect(c.handler(ctx)).rejects.toThrow(/not a valid result/)
      expect(asked).toEqual([])
    })

    it('a reply that stopped early fails the attempt', async () => {
      const { ctx } = stub({ text: JSON.stringify(c.ok), stopReason: 'max_tokens' }, c.input)
      await expect(c.handler(ctx)).rejects.toBeInstanceOf(ModelStopped)
    })

    it('an invalid job input fails before any model call', async () => {
      const { ctx, requests } = stub(end(c.ok), { wrong: true })
      await expect(c.handler(ctx)).rejects.toThrow(/input/i)
      expect(requests).toEqual([])
    })
  })
}

describe('the facts and rules handler against its input', () => {
  it('fails a reply that cites an unknown source', async () => {
    const bad = {
      ...factsOk,
      facts: [{ ...factsOk.facts[0]!, sourceIds: ['33333333-3333-4333-8333-333333333333'] }],
    }
    const { ctx } = stub(end(bad), factsRulesInput)
    await expect(factsRulesHandler(ctx)).rejects.toThrow(/not a valid result/)
  })

  it('accepts a reply that cites an answered question statement', async () => {
    const cites = { ...factsOk, facts: [{ ...factsOk.facts[0]!, sourceIds: [ANSWER_SRC] }] }
    const { ctx } = stub(end(cites), factsRulesInput, [answered])
    expect((await factsRulesHandler(ctx)).type).toBe('facts_rules.v1')
  })
})

describe('a question with one option (seen in the milestone 10 production evaluation)', () => {
  const lone = (options: string[], suggestedAnswer: string | null) => {
    const [first, ...rest] = questions()
    return { questions: [{ ...first!, options, suggestedAnswer }, ...rest], ask: null }
  }

  it('is stored with no options and that option as its suggestion', async () => {
    const { ctx } = stub(end(lone(['Baner, Pune'], null)), questionnaireInput)
    const done = (await questionnaireHandler(ctx)) as { result: typeof questionnaireOk }
    expect(done.result.questions[0]).toMatchObject({ options: [], suggestedAnswer: 'Baner, Pune' })
  })

  it('keeps a suggestion it already has', async () => {
    const { ctx } = stub(end(lone(['Gloss Co; Shine Ltd'], 'Gloss Co; Shine Ltd')), questionnaireInput)
    const done = (await questionnaireHandler(ctx)) as { result: typeof questionnaireOk }
    expect(done.result.questions[0]).toMatchObject({ options: [], suggestedAnswer: 'Gloss Co; Shine Ltd' })
  })

  it('leaves no options, two to six, and anything that is not a questionnaire as they are', () => {
    const two = lone(['A', 'B'], 'A')
    expect(withoutLoneOptions(two)).toEqual(two)
    expect(withoutLoneOptions(questionnaireOk)).toEqual(questionnaireOk)
    for (const other of ['text', null, 3, { questions: 'x' }, { questions: [null, 'q'] }])
      expect(withoutLoneOptions(other)).toEqual(other)
  })

  it('still fails a reply the result check refuses for another reason', async () => {
    const bad = lone(['A'], null)
    bad.questions = bad.questions.slice(0, 3)
    const { ctx } = stub(end(bad), questionnaireInput)
    await expect(questionnaireHandler(ctx)).rejects.toThrow(/not a valid result/)
  })
})

describe('the strategist handler against its input', () => {
  it('a brief citing a fact outside its input fails the attempt', async () => {
    const bad = {
      ...strategistOk,
      brief: { ...strategistOk.brief, factIds: ['33333333-3333-4333-8333-333333333333'] },
    }
    const { ctx, asked } = stub(end(bad), strategistInput)
    await expect(strategistHandler(ctx)).rejects.toThrow(/not a valid result/)
    expect(asked).toEqual([])
  })

  it('a goal that starts anywhere but the baseline marker fails while no baseline is given', async () => {
    const bad = {
      ...strategistOk,
      brief: { ...strategistOk.brief, goals: [{ metric: 'Leads', from: '1000 leads', to: '2000' }] },
    }
    const { ctx } = stub(end(bad), strategistInput)
    await expect(strategistHandler(ctx)).rejects.toThrow(/not a valid result/)
  })

  it('sends the picks, the baseline and a change request as data', async () => {
    const { ctx, requests } = stub(end(strategistOk), {
      ...strategistInput,
      baseline: '12 enquiries a month',
      changeRequest: { comment: 'More Instagram', previous: 'old brief' },
    })
    await strategistHandler(ctx)
    const text = requests[0]!.request.messages[0]!.content as string
    expect(text.startsWith('Write the strategy brief.\n\nToday is 2026-11-22.\n\n')).toBe(true)
    expect(text).toContain('<baseline>')
    expect(text).toContain('<change_request>')
    expect(text).toContain('<previous_brief>')
    expect(text).toContain('Installers')
  })
})
