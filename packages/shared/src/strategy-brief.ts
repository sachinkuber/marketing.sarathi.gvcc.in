import { z } from 'zod'
import { askSchema } from './agent-question.ts'
import { BASELINE_NEEDED, briefChoicesInputSchema, CHOICE_KEYS } from './brief-choices.ts'
import { type BodyBlock, type ContentPayload, PAYLOAD_SCHEMA } from './content-payload.ts'
import { given } from './input-text.ts'
import { shown } from './visible-text.ts'

const choiceKey = z.enum(CHOICE_KEYS)

// ---- The strategist job's input: the choices' input, the owner's picks, and a change request if there is one. ----

export const strategistInputSchema = briefChoicesInputSchema.extend({
  today: z.iso.date(),
  picks: z
    .array(
      z.strictObject({
        key: choiceKey,
        question: given(300),
        picked: given(300),
        notTaken: z.array(given(300)).max(2),
      }),
    )
    .min(1)
    .max(CHOICE_KEYS.length),
  // The owner's own word on where they start from; null while none is given.
  baseline: given(2000).nullable(),
  changeRequest: z.strictObject({ comment: given(2000), previous: given(30000) }).nullable(),
})
export type StrategistInput = z.infer<typeof strategistInputSchema>

// ---- Its result (strategy_brief.v1). ----

const briefSchema = z.strictObject({
  positioning: z.strictObject({ statement: shown(200), paragraph: shown(1200) }),
  audiences: z
    .array(z.strictObject({ name: shown(120), needs: shown(400), message: shown(400), where: shown(300) }))
    .min(1)
    .max(5),
  themes: z
    .array(
      z.strictObject({
        name: shown(120),
        why: shown(300),
        topics: z.array(shown(200)).min(2).max(6),
      }),
    )
    .min(4)
    .max(6),
  channels: z
    .array(
      z.strictObject({
        channel: shown(80),
        audiences: z.array(shown(120)).min(1).max(5),
        why: shown(300),
      }),
    )
    .min(1)
    .max(8),
  cadence: z
    .array(z.strictObject({ channel: shown(80), postsPerWeek: z.int().min(0).max(21) }))
    .min(1)
    .max(8),
  goals: z
    .array(z.strictObject({ metric: shown(120), from: shown(80), to: shown(80) }))
    .min(1)
    .max(6),
  choicesMade: z
    .array(z.strictObject({ key: choiceKey, picked: shown(300), notTaken: z.array(shown(300)).max(2) }))
    .max(CHOICE_KEYS.length),
  // Every fact the brief relies on, cited by id (spec 10).
  factIds: z
    .array(z.uuid())
    .min(1)
    .max(40)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'a fact is cited once' }),
})
export type StrategyBrief = z.infer<typeof briefSchema>

// Ruling R7: one strict object; exactly one of `brief` and `ask` is set.
export const strategyBriefResultSchema = z
  .strictObject({
    brief: briefSchema.nullable(),
    ask: askSchema.nullable(),
  })
  .superRefine((result, ctx) => {
    if ((result.brief === null) === (result.ask === null))
      ctx.addIssue({
        code: 'custom',
        path: ['brief'],
        message: 'a result holds either a brief or a question, not both and not neither',
      })
  })
export type StrategyBriefResult = z.infer<typeof strategyBriefResultSchema>

// What the result says that its input does not bear out.
export function strategyBriefAgainstInput(
  result: StrategyBriefResult,
  input: StrategistInput,
): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = []
  const brief = result.brief
  if (brief === null) return errors
  const facts = new Set(input.facts.map((fact) => fact.id))
  brief.factIds.forEach((id, i) => {
    if (!facts.has(id)) errors.push({ path: `brief.factIds.${i}`, message: 'this fact is not in the input' })
  })
  const picked = new Set<string>(input.picks.map((pick) => pick.key))
  brief.choicesMade.forEach((choice, i) => {
    if (!picked.has(choice.key))
      errors.push({ path: `brief.choicesMade.${i}.key`, message: 'the owner made no pick on this key' })
  })
  if (input.baseline === null)
    brief.goals.forEach((goal, i) => {
      if (goal.from !== BASELINE_NEEDED)
        errors.push({
          path: `brief.goals.${i}.from`,
          message: `no baseline is given, so the starting value is "${BASELINE_NEEDED}"`,
        })
    })
  return errors
}

const heading = (level: 2 | 3, text: string): BodyBlock => ({ type: 'heading', level, text })
const paragraph = (text: string): BodyBlock => ({ type: 'paragraph', text })
const list = (items: string[]): BodyBlock => ({ type: 'list', ordered: false, items })

// The brief as the content version the owner approves (spec 6, 10). Pure: the same brief gives the same payload.
export function strategyBriefPayload(
  brief: StrategyBrief,
  ctx: {
    brandId: string
    contentItemId: string
    brandName: string
    facts: { id: string; statement: string; factHash: string }[]
  },
): ContentPayload {
  const facts = new Map(ctx.facts.map((fact) => [fact.id, fact]))
  const cited = brief.factIds.map((id) => {
    const fact = facts.get(id)
    if (fact === undefined) throw new Error(`fact ${id} is not in the context`)
    return fact
  })
  const body: BodyBlock[] = [
    heading(2, 'Positioning'),
    paragraph(brief.positioning.paragraph),
    heading(2, 'Audiences'),
    ...brief.audiences.flatMap((a) => [
      heading(3, a.name),
      list([`Needs: ${a.needs}`, `Tell them: ${a.message}`, `Where: ${a.where}`]),
    ]),
    heading(2, 'Content themes'),
    ...brief.themes.flatMap((t) => [heading(3, t.name), paragraph(t.why), list(t.topics)]),
    heading(2, 'Channels'),
    list(brief.channels.map((c) => `${c.channel}: ${c.audiences.join(', ')}. ${c.why}`)),
    heading(2, 'Plan: posts per week'),
    list(brief.cadence.map((c) => `${c.channel}: ${c.postsPerWeek} a week`)),
    heading(2, '90-day goals'),
    list(brief.goals.map((g) => `${g.metric}: from ${g.from} to ${g.to}`)),
    ...(brief.choicesMade.length === 0
      ? []
      : [
          heading(2, 'Choices made'),
          list(
            brief.choicesMade.map((c) =>
              c.notTaken.length === 0 ? c.picked : `${c.picked} (not taken: ${c.notTaken.join('; ')})`,
            ),
          ),
        ]),
    heading(2, 'Facts used'),
    list(cited.map((fact) => fact.statement)),
  ]
  return {
    schema: PAYLOAD_SCHEMA,
    brand_id: ctx.brandId,
    content_item_id: ctx.contentItemId,
    kind: 'strategy_brief',
    language: 'en',
    title: `Strategy brief: ${ctx.brandName}`,
    summary: brief.positioning.statement,
    body,
    fact_refs: cited.map((fact) => ({ fact_id: fact.id, text_hash: 'sha256:' + fact.factHash })),
  }
}
