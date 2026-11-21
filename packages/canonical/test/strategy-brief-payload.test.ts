import { describe, expect, it } from 'vitest'
import { BASELINE_NEEDED, strategyBriefPayload } from '@mkt/shared'
import { prepareVersion } from '../src/index.ts'

const F1 = '00000000-0000-4000-8000-0000000000f1'
const brief = () => ({
  positioning: { statement: 'Paint protection that lasts.', paragraph: 'Lumen Shield protects paint.' },
  audiences: [{ name: 'Car owners', needs: 'Shine', message: 'Warranty', where: 'Instagram' }],
  themes: [1, 2, 3, 4].map((n) => ({ name: `Theme ${n}`, why: 'Why.', topics: ['A', 'B'] })),
  channels: [{ channel: 'Instagram', audiences: ['Car owners'], why: 'They look there.' }],
  cadence: [{ channel: 'Instagram', postsPerWeek: 3 }],
  goals: [{ metric: 'Enquiries', from: BASELINE_NEEDED, to: '20' }],
  choicesMade: [],
  factIds: [F1],
})
const ctx = {
  brandId: '00000000-0000-4000-8000-00000000000a',
  contentItemId: '00000000-0000-4000-8000-0000000000c1',
  brandName: 'Lumen Shield Coatings',
  facts: [{ id: F1, statement: 'We coat cars in Pune.', factHash: '1'.repeat(64) }],
}

describe('strategy brief payload', () => {
  it('the payload is deterministic through prepareVersion', () => {
    const a = prepareVersion(strategyBriefPayload(brief(), ctx))
    const b = prepareVersion(strategyBriefPayload(brief(), ctx))
    expect(a.hash).toBe(b.hash)
    expect(a.hashScheme).toBe('cv1')
  })
})
