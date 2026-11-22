// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentQuestion, SUGGESTED_WORDS } from '../src/screens/AgentQuestion'
import { Dom, brandId, sessionAs } from './dom-support'

const asked = (over: Record<string, unknown> = {}) => ({
  id: 'aq1',
  question: 'Which year did the business start?',
  why: 'The site shows two years.',
  options: [] as string[],
  suggested: 'In 2012' as string | null,
  ...over,
})

describe('the agent question, driven', () => {
  const dom = new Dom()
  beforeEach(() => dom.start())
  afterEach(() => dom.stop())

  const mount = (question: ReturnType<typeof asked>) =>
    dom.mount(<AgentQuestion brandId={brandId} question={question} />, sessionAs('owner'))

  it('a box pre-filled from the suggestion says it is the agent’s suggestion', async () => {
    await mount(asked())
    expect(dom.field('aq-own-aq1')?.value).toBe('In 2012')
    expect(dom.text()).toContain('Suggested by the agent; change it if it is wrong.')
    expect(dom.text()).toContain(SUGGESTED_WORDS)
    // The textarea is described by that note.
    const hint = dom.host.querySelector('#aq-hint-aq1')
    expect(dom.field('aq-own-aq1')?.getAttribute('aria-describedby')).toBe('aq-hint-aq1')
    expect(hint?.textContent).toBe(SUGGESTED_WORDS)
  })

  it('the note goes once the owner changes the text', async () => {
    await mount(asked())
    dom.type('aq-own-aq1', 'In 2010')
    expect(dom.text()).not.toContain(SUGGESTED_WORDS)
  })

  it('a box with no suggestion, or a question with options, carries no such note', async () => {
    await mount(asked({ suggested: null }))
    expect(dom.text()).not.toContain(SUGGESTED_WORDS)
    dom.stop()
    dom.start()
    await mount(asked({ options: ['In 2012', 'In 2010'] }))
    expect(dom.field('aq-own-aq1')?.value).toBe('')
    expect(dom.text()).not.toContain(SUGGESTED_WORDS)
  })
})
