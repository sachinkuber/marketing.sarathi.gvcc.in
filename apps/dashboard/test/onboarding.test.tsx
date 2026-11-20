// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OnboardingIntakeScreen } from '../src/screens/OnboardingIntake'
import { OnboardingScreen } from '../src/screens/Onboarding'
import { ResearchProgressScreen } from '../src/screens/ResearchProgress'
import { SideMenu, menuFor } from '../src/frame/SideMenu'
import { Dom, brandId, sessionAs } from './dom-support'

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {} }),
  usePathname: () => '/b/x/onboarding',
}))

const none = { usdMicros: null, inrMicros: null }
const overview = (over: Record<string, unknown> = {}) => ({
  step: 'intake',
  intake: null,
  documents: 0,
  research: null,
  openSuggestions: 0,
  cost: { usdMicros: '0', inrMicros: '0' },
  ...over,
})
const intake = { website: 'https://aztek.example', socials: {}, competitors: [] }

// A stand-in for XMLHttpRequest: records the request and answers as the test says.
interface Answer {
  status: number
  body: unknown
}
let xhrs: FakeXhr[] = []
let xhrAnswer: Answer = { status: 201, body: {} }
class FakeXhr {
  method = ''
  url = ''
  headers: Record<string, string> = {}
  sent: unknown = null
  withCredentials = false
  status = 0
  responseText = ''
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } =
    {
      onprogress: null,
    }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  open(method: string, url: string) {
    this.method = method
    this.url = url
    xhrs.push(this)
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value
  }
  send(body: unknown) {
    this.sent = body
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 })
      this.status = xhrAnswer.status
      this.responseText = JSON.stringify(xhrAnswer.body)
      this.onload?.()
    }, 0)
  }
}

function pick(dom: Dom, file: File) {
  const input = dom.field('in-file') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('onboarding screens, driven', () => {
  const dom = new Dom()
  beforeEach(() => {
    dom.start()
    push.mockClear()
    xhrs = []
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
  })
  afterEach(() => dom.stop())

  it('the intake form saves and enables Start research', async () => {
    dom.replies.push({ status: 200, body: overview() }, { status: 200, body: { documents: [] } })
    await dom.mount(<OnboardingIntakeScreen brandId={brandId} />, sessionAs('owner'))
    expect(dom.button('Start research').disabled).toBe(true)
    dom.type('in-website', 'https://aztek.example')
    dom.type('in-instagram', 'https://instagram.com/aztek')
    dom.replies.push({
      status: 200,
      body: { intake: { ...intake, socials: { instagram: 'https://instagram.com/aztek' } } },
    })
    await dom.submit('Save intake')
    expect(dom.writes()).toEqual([
      {
        url: `/api/v1/brands/${brandId}/onboarding/intake`,
        method: 'PUT',
        body: {
          website: 'https://aztek.example',
          socials: { instagram: 'https://instagram.com/aztek' },
          competitors: [],
        },
      },
    ])
    expect(dom.button('Start research').disabled).toBe(false)
    dom.replies.push({ status: 200, body: { runId: 'r1', jobIds: [] } })
    await dom.click('Start research')
    expect(dom.writes()[1]).toMatchObject({
      url: `/api/v1/brands/${brandId}/onboarding/research`,
      method: 'POST',
    })
    expect(push).toHaveBeenCalledWith(`/b/${brandId}/onboarding/research`)
  })

  it('shows a refused field next to it, and the limits', async () => {
    dom.replies.push({ status: 200, body: overview() }, { status: 200, body: { documents: [] } })
    await dom.mount(<OnboardingIntakeScreen brandId={brandId} />, sessionAs('owner'))
    expect(dom.text()).toContain(
      'PDF up to 100 MB (large PDFs are prepared for the AI automatically), images up to 5 MB, 20 files, 500 MB in all',
    )
    await dom.click('Add a competitor')
    dom.type('in-website', 'https://aztek.example')
    dom.type('in-comp-0-name', 'Rival')
    dom.type('in-comp-0-website', 'http://rival.example')
    dom.replies.push({
      status: 400,
      body: {
        error: {
          code: 'invalid_request',
          message: 'The request is not valid.',
          details: [{ part: 'body', path: 'competitors.0.website', message: 'Use a full https:// address.' }],
        },
      },
    })
    await dom.submit('Save intake')
    const err = dom.host.querySelector('#in-comp-0-website-error')
    expect(err?.textContent).toBe('Use a full https:// address.')
  })

  it('an upload refused as too large shows how to fix it', async () => {
    dom.replies.push({ status: 200, body: overview() }, { status: 200, body: { documents: [] } })
    await dom.mount(<OnboardingIntakeScreen brandId={brandId} />, sessionAs('owner'))
    xhrAnswer = {
      status: 413,
      body: {
        error: {
          code: 'too_large',
          message: 'This PDF is 120 MB; the limit is 100 MB. Split it or compress it, then upload again.',
        },
      },
    }
    pick(dom, new File(['x'], 'big.pdf', { type: 'application/pdf' }))
    await dom.settle()
    expect(dom.text()).toContain('Split it or compress it, then upload again.')
    expect(xhrs[0]?.headers['content-type']).toBe('application/pdf')
    expect(xhrs[0]?.headers['x-file-name']).toBe('big.pdf')
    expect(xhrs[0]?.headers['x-csrf-token']).toBe('tok-1')
  })

  it('sends nothing for a name over 200 characters', async () => {
    dom.replies.push({ status: 200, body: overview() }, { status: 200, body: { documents: [] } })
    await dom.mount(<OnboardingIntakeScreen brandId={brandId} />, sessionAs('owner'))
    pick(dom, new File(['x'], `${'a'.repeat(201)}.pdf`, { type: 'application/pdf' }))
    await dom.settle()
    expect(xhrs).toHaveLength(0)
    expect(dom.text()).toContain('Rename the file to 200 characters or fewer, then upload it again.')
  })

  it('a large PDF shows how many parts it was prepared in', async () => {
    dom.replies.push({ status: 200, body: overview() }, { status: 200, body: { documents: [] } })
    await dom.mount(<OnboardingIntakeScreen brandId={brandId} />, sessionAs('owner'))
    xhrAnswer = {
      status: 201,
      body: {
        id: 'd1000000-0000-4000-8000-000000000001',
        fileName: 'catalogue.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 50_000_000,
        sha256: 'ab',
        parts: 7,
      },
    }
    pick(dom, new File(['x'], 'catalogue.pdf', { type: 'application/pdf' }))
    await dom.settle()
    expect(dom.text()).toContain('catalogue.pdf')
    expect(dom.text()).toContain('Prepared in 7 parts')
  })

  const group = (name: string, state: string, extra: Record<string, unknown> = {}) => ({
    group: name,
    state,
    searches: 0,
    fetches: 0,
    cost: { usdMicros: '0', inrMicros: '0' },
    sources: [],
    ...extra,
  })
  const running = (groups: unknown[], merge = 'waiting') =>
    overview({ step: 'research', intake, research: { runId: 'r1', state: 'running', groups, merge } })

  it('progress shows a failed group as Could not be read', async () => {
    dom.replies.push({
      status: 200,
      body: running([group('site', 'done'), group('social', 'failed')], 'done'),
    })
    await dom.mount(<ResearchProgressScreen brandId={brandId} />, sessionAs('owner'))
    expect(dom.text()).toContain('Could not be read')
    expect(dom.text()).toContain('Done')
    expect(dom.text()).toContain('Putting it together')
  })

  it('a group row shows its counts and cost, and expands to its sources with their results', async () => {
    dom.replies.push({
      status: 200,
      body: running([
        group('site', 'done', {
          searches: 12,
          fetches: 8,
          cost: { usdMicros: '210000', inrMicros: '17600000' },
          sources: [
            {
              id: 's1',
              kind: 'site',
              address: 'https://aztek.example/about',
              documentName: null,
              result: 'read',
              flagged: false,
            },
            {
              id: 's2',
              kind: 'site',
              address: 'https://aztek.example/x',
              documentName: null,
              result: 'blocked',
              flagged: false,
            },
            {
              id: 's3',
              kind: 'site',
              address: 'https://aztek.example/y',
              documentName: null,
              result: 'read',
              flagged: true,
            },
          ],
        }),
        group('documents', 'done', {
          cost: none,
          sources: [
            {
              id: 's4',
              kind: 'document',
              address: 'brochure.pdf, pages 1–100',
              documentName: 'brochure.pdf',
              result: 'empty',
              flagged: false,
            },
          ],
        }),
      ]),
    })
    await dom.mount(<ResearchProgressScreen brandId={brandId} />, sessionAs('owner'))
    expect(dom.text()).toContain('12 searches · 8 pages · $0.21 · ₹17.60')
    expect(dom.text()).toContain('cost not known yet')
    expect(dom.text()).not.toContain('https://aztek.example/about')
    await dom.click('Show sources', 0)
    expect(dom.text()).toContain('https://aztek.example/about')
    expect(dom.text()).toContain('Blocked')
    expect(dom.text()).toContain('Flagged')
  })

  it('shows document sources by name with their page range', async () => {
    dom.replies.push({
      status: 200,
      body: running([
        group('documents', 'done', {
          sources: [
            {
              id: 's4',
              kind: 'document',
              address: 'brochure.pdf, pages 1–100',
              documentName: 'brochure.pdf',
              result: 'empty',
              flagged: false,
            },
          ],
        }),
      ]),
    })
    await dom.mount(<ResearchProgressScreen brandId={brandId} />, sessionAs('owner'))
    await dom.click('Show sources')
    expect(dom.text()).toContain('brochure.pdf, pages 1–100')
    expect(dom.text()).toContain('Empty')
  })

  it('links to the draft profile once the merge is done', async () => {
    dom.replies.push({ status: 200, body: running([group('site', 'done')], 'done') })
    await dom.mount(<ResearchProgressScreen brandId={brandId} />, sessionAs('owner'))
    expect(dom.host.querySelector(`a[href="/b/${brandId}/onboarding/profile"]`)).not.toBeNull()
  })

  it('the overview shows the step, the cost and a Continue link', async () => {
    dom.replies.push({
      status: 200,
      body: overview({ step: 'research', cost: { usdMicros: '210000', inrMicros: '17600000' } }),
    })
    await dom.mount(<OnboardingScreen brandId={brandId} />, sessionAs('owner'))
    expect(dom.text()).toContain('$0.21 · ₹17.60')
    expect(dom.host.querySelector(`a[href="/b/${brandId}/onboarding/research"]`)?.textContent).toBe(
      'Continue',
    )
  })

  it('the menu shows Onboarding to the platform owner only', () => {
    const labels = (role: Parameters<typeof menuFor>[0]) => menuFor(role).map((item) => item.label)
    expect(labels('owner')).toContain('Onboarding')
    for (const role of ['brand_admin', 'approver', 'sales_contact', 'viewer'] as const) {
      expect(labels(role)).not.toContain('Onboarding')
    }
    expect(renderToStaticMarkup(<SideMenu brandId="b1" role="owner" />)).toContain('href="/b/b1/onboarding"')
  })
})
