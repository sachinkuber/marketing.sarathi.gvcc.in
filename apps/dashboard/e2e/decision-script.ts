// What the stand-in model answers when the browser checks prepare the questionnaire, ask for facts and rules, find
// the brief choices and write the strategy brief (spec 7, 8.2, 9, 10). Every reply is fixed and valid against
// questionnaire.v1, facts_rules.v1, brief_choices.v1 and strategy_brief.v1 (the worker and the core check them
// strictly). The facts and rules agent asks the owner first, through `ask`; once the answer is in the request (an
// "earlier questions" section), it replies with the result, citing real source ids from the request. The strategist
// cites the fact ids and records the picks it finds in the request, and follows a change request.
import type {
  BriefChoicesResult,
  ChoiceKey,
  FactsRulesResult,
  QuestionnaireResult,
  StrategyBrief,
  StrategyBriefResult,
} from '@mkt/shared'

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

// The brief choices: three open choices, each with its recommended option first.
export const CHOICE_AUDIENCE = 'Who should the plan speak to first?'
export const CHOICE_CHANNELS = 'Which channels should come first?'
export const CHOICE_RHYTHM = 'How often should Aztek post?'
export const RECOMMENDED_AUDIENCE = 'Car owners'
export const RECOMMENDED_CHANNELS = 'Instagram and Facebook'
export const RECOMMENDED_RHYTHM = 'Twice a week'

type Choice = BriefChoicesResult['choices'][number]
const option = (value: string, tradeOff: string, recommended = false) => ({ value, tradeOff, recommended })
const CHOICES: Choice[] = [
  {
    key: 'lead_audience',
    question: CHOICE_AUDIENCE,
    why: 'The first posts are written for one group.',
    options: [
      option(RECOMMENDED_AUDIENCE, 'The larger group, and the site speaks to them most.', true),
      option('Bike owners', 'A smaller group that rides daily and needs care more often.'),
    ],
  },
  {
    key: 'first_channels',
    question: CHOICE_CHANNELS,
    why: 'Starting on fewer channels keeps the work small.',
    options: [
      option(RECOMMENDED_CHANNELS, 'Reaches car and bike owners where they already look.', true),
      option('Instagram only', 'Less work, but fewer people see it.'),
    ],
  },
  {
    key: 'posting_rhythm',
    question: CHOICE_RHYTHM,
    why: 'A steady rhythm matters more than a busy one.',
    options: [
      option(RECOMMENDED_RHYTHM, 'Easy to keep up while the workshop is busy.', true),
      option('Every weekday', 'Seen more often, and needs much more content.'),
      option('Once a week', 'Little work, and slow to build a following.'),
    ],
  },
]

const briefChoices = (): BriefChoicesResult => ({ choices: CHOICES, ask: null })

// The strategy brief. Its Instagram cadence moves from 2 to 3 a week when the owner asks for changes.
export const AUDIENCE_NAME = 'Car owners who care for their paint'
export const FIRST_CADENCE = 'Instagram: 2 a week'
export const CHANGED_CADENCE = 'Instagram: 3 a week'
// What a goal's starting value says while no baseline is given (BASELINE_NEEDED in @mkt/shared, written out here
// because a spec process loads no package code). The worker refuses a brief whose goals say anything else.
const BASELINE_NEEDED = 'baseline needed (B1)'

// The ids of the request's `<fact id="...">` blocks: the facts in force the job was given.
function factIds(step: string): string[] {
  return [...new Set([...step.matchAll(/<fact id="([0-9a-f-]{36})">/g)].map((match) => match[1]!))]
}

// The owner's picks in the request (`<pick key="...">` blocks holding JSON), as the brief records them.
function picks(step: string): StrategyBrief['choicesMade'] {
  return [...step.matchAll(/<pick key="(\w+)"[^>]*>\n([^\n]*)\n<\/pick>/g)].map((match) => {
    const pick = JSON.parse(match[2]!) as { picked: string; notTaken: string[] }
    return { key: match[1] as ChoiceKey, picked: pick.picked, notTaken: pick.notTaken.slice(0, 2) }
  })
}

function strategist(step: string): StrategyBriefResult {
  const facts = factIds(step)
  if (facts.length === 0) throw new Error('The scripted model found no fact in the strategist request.')
  const changed = step.includes('<change_request>')
  const theme = (name: string, why: string, topics: string[]) => ({ name, why, topics })
  return {
    brief: {
      positioning: {
        statement: 'Ceramic protection for cars and bikes, fitted with care.',
        paragraph: 'Aztek protects the paint of cars and bikes with ceramic coatings, and shows the work.',
      },
      audiences: [
        {
          name: AUDIENCE_NAME,
          needs: 'Paint that stays glossy through the monsoon.',
          message: 'A coating keeps the shine with less washing.',
          where: 'Instagram and Facebook',
        },
        {
          name: 'Daily bike riders',
          needs: 'Protection from road grime.',
          message: 'A coated bike cleans in minutes.',
          where: 'Instagram',
        },
      ],
      themes: [
        theme('Before and after', 'Results persuade most.', [
          'A car after coating',
          'A bike after a monsoon',
        ]),
        theme('Care tips', 'Owners want to keep the shine.', ['Washing a coated car', 'What to avoid']),
        theme('In the workshop', 'People trust what they can see.', ['How a coating is fitted', 'The team']),
        theme('Certified work', 'Proof matters.', ['The ISO 9001 certification', 'What the warranty covers']),
      ],
      channels: [
        {
          channel: 'Instagram',
          audiences: [AUDIENCE_NAME, 'Daily bike riders'],
          why: 'Pictures show results.',
        },
        { channel: 'Facebook', audiences: [AUDIENCE_NAME], why: 'Car owners ask questions there.' },
      ],
      cadence: [
        { channel: 'Instagram', postsPerWeek: changed ? 3 : 2 },
        { channel: 'Facebook', postsPerWeek: 1 },
      ],
      goals: [{ metric: 'Enquiries a month', from: BASELINE_NEEDED, to: '30' }],
      choicesMade: picks(step),
      factIds: facts,
    },
    ask: null,
  }
}

// The reply to a questionnaire, facts and rules, brief choices or strategist request, or null when the request is
// none of them. Each agent's request has its own fixed first line, so `startsWith` tells them apart: the
// strategist's second line ("Today is ...") never reaches the facts and rules check.
export function decisionReplyFor(step: string): string | null {
  if (step.startsWith('Find the open strategic choices.')) return JSON.stringify(briefChoices())
  if (step.startsWith('Write the strategy brief.')) return JSON.stringify(strategist(step))
  if (step.startsWith('<brand_name>')) return JSON.stringify(questionnaire())
  if (step.startsWith('Today is ')) return JSON.stringify(factsRules(step))
  return null
}
