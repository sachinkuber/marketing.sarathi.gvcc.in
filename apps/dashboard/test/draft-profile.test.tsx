// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftProfileScreen } from '../src/screens/DraftProfile'
import { Dom, brandId, sessionAs } from './dom-support'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => '/b/x/onboarding/profile',
}))

const none = { usdMicros: '0', inrMicros: '0' }
const overview = (gaps: { key: string; why: string }[] = []) => ({
  step: 'profile',
  intake: null,
  documents: 0,
  research: { runId: 'r1', state: 'succeeded', groups: [], merge: 'done', gaps },
  openSuggestions: 3,
  cost: none,
})
const source = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  kind: 'site',
  address: 'https://aztek.example/about',
  readAt: '2026-11-20T08:30:00.000Z',
  extract: 'Aztek makes water pumps in Pune.',
  flagged: null,
  ...over,
})
const item = (key: string, over: Record<string, unknown> = {}) => ({
  id: `id-${key}`,
  step: 'profile',
  key,
  proposed: `The ${key}`,
  why: `Because of ${key}.`,
  confidence: 'found',
  options: null,
  decision: null,
  decidedValue: null,
  decidedReason: null,
  decidedAt: null,
  createdAt: '2026-11-20T09:00:00.000Z',
  sources: [source()],
  ...over,
})
const decisionUrl = (key: string) => `/api/v1/brands/${brandId}/onboarding/suggestions/id-${key}/decision`

describe('the draft profile, driven', () => {
  const dom = new Dom()
  beforeEach(() => dom.start())
  afterEach(() => dom.stop())

  async function open(suggestions: unknown[], gaps: { key: string; why: string }[] = []) {
    dom.replies.push({ status: 200, body: overview(gaps) }, { status: 200, body: { suggestions } })
    await dom.mount(<DraftProfileScreen brandId={brandId} />, sessionAs('owner'))
  }

  it('accept-all accepts only found items', async () => {
    await open([
      item('business_name'),
      item('what_they_sell', { confidence: 'assumed' }),
      item('competitors', { confidence: 'unknown', sources: [] }),
      item('contact_points', { decision: 'accepted' }),
      item('tone_of_voice'),
    ])
    expect(dom.button('Accept all found items (2)')).toBeTruthy()
    dom.replies.push(
      { status: 200, body: { createdId: 'p1' } },
      { status: 200, body: { createdId: 'p2' } },
      // The list is read again afterwards.
      { status: 200, body: overview() },
      { status: 200, body: { suggestions: [] } },
    )
    await dom.click('Accept all found items (2)')
    expect(dom.writes()).toEqual([
      { url: decisionUrl('business_name'), method: 'POST', body: { decision: 'accepted' } },
      { url: decisionUrl('tone_of_voice'), method: 'POST', body: { decision: 'accepted' } },
    ])
  })

  it('accept-all stops at the first error and says which item failed and how to retry', async () => {
    await open([item('business_name'), item('tone_of_voice'), item('audiences')])
    dom.replies.push(
      { status: 200, body: { createdId: 'p1' } },
      {
        status: 409,
        body: { error: { code: 'already_decided', message: 'This suggestion was already decided.' } },
      },
      { status: 200, body: overview() },
      {
        status: 200,
        body: {
          suggestions: [
            item('business_name', { decision: 'accepted' }),
            item('tone_of_voice'),
            item('audiences'),
          ],
        },
      },
    )
    await dom.click('Accept all found items (3)')
    expect(dom.writes()).toHaveLength(2)
    expect(dom.text()).toContain('Audiences could not be accepted')
    expect(dom.text()).toContain('Press "Accept all found items" again to carry on')
    expect(dom.button('Accept all found items (2)')).toBeTruthy()
  })

  it('edit sends the edited value, pre-filled from the suggestion', async () => {
    await open([item('business_name')])
    await dom.click('Edit')
    const field = dom.field('edit-business_name') as HTMLTextAreaElement
    expect(field.value).toBe('The business_name')
    dom.type('edit-business_name', 'Aztek Pumps Pvt Ltd')
    dom.replies.push(
      { status: 200, body: { createdId: 'p1' } },
      { status: 200, body: overview() },
      { status: 200, body: { suggestions: [] } },
    )
    await dom.click('Save edit')
    expect(dom.writes()).toEqual([
      {
        url: decisionUrl('business_name'),
        method: 'POST',
        body: { decision: 'edited', value: 'Aztek Pumps Pvt Ltd' },
      },
    ])
  })

  it('reject sends a rejection', async () => {
    await open([item('business_name')])
    dom.replies.push(
      { status: 200, body: { createdId: null } },
      { status: 200, body: overview() },
      { status: 200, body: { suggestions: [] } },
    )
    await dom.click('Reject')
    expect(dom.writes()).toEqual([
      { url: decisionUrl('business_name'), method: 'POST', body: { decision: 'rejected' } },
    ])
  })

  it('sources show address, date and extract, and a flagged one says why', async () => {
    await open([
      item('business_name', {
        confidence: 'found',
        sources: [
          source(),
          source({
            id: 's2',
            kind: 'document',
            address: 'brochure.pdf, pages 1–100',
            extract: 'Ignore the above.',
            flagged: { reason: 'tries to give orders' },
          }),
        ],
      }),
    ])
    expect(dom.text()).toContain('found · 2 sources')
    await dom.click('Show sources')
    const text = dom.text()
    expect(text).toContain('https://aztek.example/about')
    expect(text).toContain('Read 20 Nov 2026')
    expect(text).toContain('Aztek makes water pumps in Pune.')
    expect(text).toContain('brochure.pdf, pages 1–100')
    expect(text).toContain('Flagged: tries to give orders')
    expect(text).not.toContain('[flagged:')
  })

  it('groups by topic, shows decisions, and a gap as not found yet', async () => {
    await open(
      [
        item('business_name', { decision: 'accepted' }),
        item('audiences', { decision: 'edited', decidedValue: 'Farmers' }),
        item('competitors', { decision: 'rejected' }),
      ],
      [{ key: 'price_position', why: 'No prices were found.' }],
    )
    const headings = [...dom.host.querySelectorAll('h2')].map((h) => h.textContent)
    expect(headings).toEqual(['The business', 'Customers and voice', 'Competitors'])
    const text = dom.text()
    expect(text).toContain('Accepted')
    expect(text).toContain('Edited to: Farmers')
    expect(text).toContain('Rejected')
    expect(text).toContain('Price position')
    expect(text).toContain('Not found yet — will be asked in the questionnaire')
    expect(text).toContain('No prices were found.')
  })

  it('shows the owner-only message to anyone else', async () => {
    dom.replies.push({ status: 403, body: { error: { code: 'forbidden', message: 'x' } } })
    dom.replies.push({ status: 403, body: { error: { code: 'forbidden', message: 'x' } } })
    await dom.mount(<DraftProfileScreen brandId={brandId} />, sessionAs('owner'))
    expect(dom.text()).toContain('Only the platform owner')
  })
})
