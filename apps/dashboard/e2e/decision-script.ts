// What the stand-in model answers when the browser checks prepare the questionnaire and ask for facts and rules
// (spec 7, 8.2, 9). Every reply is fixed and valid against questionnaire.v1 and facts_rules.v1 (the worker and the
// core check them strictly). The facts and rules agent asks the owner first, through `ask`; once the answer is in
// the request (an "earlier questions" section), it replies with the result, citing real source ids from the request.
import type { FactsRulesResult, QuestionnaireResult } from '@mkt/shared'

export const ASK_TEXT = 'Which price band should Aztek describe itself in?'
export const ASK_OPTIONS = ['Mid-range', 'Premium']
export const FACT_CONFIRMED = 'Aztek makes ceramic coatings for cars and bikes.'
export const FACT_EDITED = 'Aztek coatings are ISO 9001 certified.'
export const FACT_DROPPED = 'Aztek has workshops in three cities.'
export const RULE_SUGGESTED = 'Never promise a scratch-proof finish.'

type Question = QuestionnaireResult['questions'][number]
const q = (
  key: Question['key'],
  text: string,
  why: string,
  options: string[] = [],
  suggestedAnswer: string | null = null,
): Question => ({ key, text, why, options, suggestedAnswer })

// Ten questions, each safety key included. The first has options (radio), the second none (a text box).
export const QUESTIONS: Question[] = [
  q(
    'goals',
    'What should the next three months bring?',
    'Goals decide what the plan favours.',
    ['More enquiries', 'More walk-ins', 'More brand awareness'],
    'More enquiries',
  ),
  q('priority_audiences', 'Who matters most to you?', 'The plan speaks to them first.'),
  q(
    'proof_points',
    'What proof can you show?',
    'Claims need proof.',
    ['Warranty card', 'Customer photos'],
    null,
  ),
  q(
    'never_say',
    'What must never be said?',
    'These become safety rules.',
    ['Nothing special', 'Guaranteed results'],
    'Nothing special',
  ),
  q(
    'competitors_not_named',
    'Which competitors must never be named?',
    'These become safety rules.',
    ['None', 'Rival'],
    'None',
  ),
  q(
    'tone_limits',
    'How far may the tone go?',
    'These become safety rules.',
    ['Friendly', 'Formal'],
    'Friendly',
  ),
  q(
    'pause_dates',
    'When should posting pause?',
    'These become safety rules.',
    ['Never', 'Diwali week'],
    'Never',
  ),
  q('capacity', 'How many jobs a week can you take?', 'The plan must not promise more.'),
  q(
    'success_measures',
    'How will you judge success?',
    'It sets what is reported.',
    ['Enquiries', 'Sales'],
    'Enquiries',
  ),
  q(
    'price_position',
    'Where do your prices sit?',
    'The site shows no prices.',
    ['Mid-range', 'Premium'],
    null,
  ),
]

const questionnaire = (): QuestionnaireResult => ({ questions: QUESTIONS, ask: null })

// The ids of the request's `<source id="..." kind="...">` blocks, by kind.
function sourceIds(step: string, kind: string): string[] {
  const ids: string[] = []
  for (const match of step.matchAll(/<source id="([0-9a-f-]{36})" kind="(\w+)"/g))
    if (match[2] === kind) ids.push(match[1]!)
  return ids
}

function factsRules(step: string): FactsRulesResult {
  // The answer the spec chooses (Premium) must be in the request, so the test proves it reached the agent.
  if (
    !step.includes("The owner's answers to your earlier questions") ||
    !step.includes(`"answer":"${ASK_OPTIONS[1]}"`)
  )
    return {
      facts: [],
      rules: [],
      ask: {
        text: ASK_TEXT,
        why: 'The profile and your answers do not say.',
        options: ASK_OPTIONS,
        suggested: ASK_OPTIONS[0]!,
      },
    }
  const today = /^Today is (\d{4}-\d{2}-\d{2})\./.exec(step)?.[1]
  const site = sourceIds(step, 'site')[0]
  const owner = sourceIds(step, 'owner_statement')[0]
  if (!today || !site || !owner) throw new Error('The scripted model found no site source in the request.')
  const review = new Date(Date.parse(`${today}T00:00:00Z`) + 90 * 86_400_000).toISOString().slice(0, 10)
  const fact = (statement: string) => ({
    statement,
    why: 'The site says so.',
    sourceIds: [site],
    reviewDate: review,
  })
  return {
    facts: [fact(FACT_CONFIRMED), fact(FACT_EDITED), fact(FACT_DROPPED)],
    rules: [
      {
        kind: 'forbidden_claim',
        text: RULE_SUGGESTED,
        why: 'You asked for care with claims.',
        sourceIds: [owner],
      },
    ],
    ask: null,
  }
}

// The reply to a questionnaire or facts and rules request, or null when the request is not one.
export function decisionReplyFor(step: string): string | null {
  if (step.startsWith('<brand_name>')) return JSON.stringify(questionnaire())
  if (step.startsWith('Today is ')) return JSON.stringify(factsRules(step))
  return null
}
