// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OnboardingIntakeScreen } from '../src/screens/OnboardingIntake'
import { OnboardingScreen } from '../src/screens/Onboarding'
import { ResearchProgressScreen } from '../src/screens/ResearchProgress'
import { SideMenu, menuFor } from '../src/frame/SideMenu'
import { Dom, brandId, sessionAs } from './dom-support'
import { POLL_MS } from '../src/screens/ResearchProgress'

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
  questionnaire: null,
  factsRules: null,
  cost: { usdMicros: '0', inrMicros: '0' },
  ...over,
})
const intake = { website: 'https://aztek.example', socials: {}, competitors: [] }

// A stand-in for XMLHttpRequest: records the request and answers as the test says.
interface Answer {
  status: number
  body: unknown
  // Sent as the body text as it is (a proxy's HTML page), instead of `body` as JSON.
  raw?: string
  // The request fails before any answer, as a cut connection does.
  fail?: boolean
}
const FRESH: Answer = { status: 201, body: {} }
let xhrs: FakeXhr[] = []
let xhrAnswer: Answer = FRESH
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
      if (xhrAnswer.fail) {
        this.onerror?.()
        return
      }
      this.status = xhrAnswer.status
      this.responseText = xhrAnswer.raw ?? JSON.stringify(xhrAnswer.body)
      this.onload?.()
    }, 0)
  }
}

function pick(dom: Dom, ...files: File[]) {
  const input = dom.field('in-file') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: files, configurable: true })
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
    xhrAnswer = FRESH
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
    overview({
      step: 'research',
      intake,
      research: { runId: 'r1', state: 'running', groups, merge, gaps: [] },
    })

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

  // Every group died, so no merge job was ever made: the run has ended (failed) and nothing is still open.
  const failedRun = (merge: string) =>
    overview({
      step: 'research',
      intake,
      research: {
        runId: 'r1',
        state: 'failed',
        groups: [group('site', 'failed'), group('social', 'failed')],
        merge,
        gaps: [],
      },
    })

  it('a run that could not finish says what to do and links back to start it again', async () => {
    for (const merge of ['failed', 'waiting']) {
      dom.stop()
      dom.start()
      dom.replies.push({ status: 200, body: failedRun(merge) })
      await dom.mount(<ResearchProgressScreen brandId={brandId} />, sessionAs('owner'))
      expect(dom.text()).toContain(
        'Research could not finish. Check the agents’ releases, then start research again.',
      )
      expect(dom.host.querySelector(`a[href="/b/${brandId}/onboarding/intake"]`)).not.toBeNull()
      expect(dom.host.querySelector(`a[href="/b/${brandId}/onboarding/profile"]`)).toBeNull()
    }
  })

  it('Start research is enabled again once the run has failed, even if the merge never started', async () => {
    dom.replies.push({ status: 200, body: failedRun('waiting') }, { status: 200, body: { documents: [] } })
    await dom.mount(<OnboardingIntakeScreen brandId={brandId} />, sessionAs('owner'))
    expect(dom.button('Start research').disabled).toBe(false)
  })

  it('a removal refused while research reads the documents shows how to proceed', async () => {
    dom.replies.push(
      { status: 200, body: overview({ intake }) },
      {
        status: 200,
        body: {
          documents: [
            {
              id: 'd1',
              fileName: 'brochure.pdf',
              mediaType: 'application/pdf',
              sizeBytes: 2048,
              sha256: 'x',
              parts: 0,
              uploadedAt: '2026-11-20T08:00:00.000Z',
            },
          ],
        },
      },
    )
    await dom.mount(<OnboardingIntakeScreen brandId={brandId} />, sessionAs('owner'))
    dom.replies.push({
      status: 409,
      body: {
        error: {
          code: 'research_running',
          message: 'Research is reading the brand’s documents. Wait for it to finish, then delete the file.',
        },
      },
    })
    await dom.click('Remove')
    expect(dom.text()).toContain(
      'brochure.pdf: Research is reading the brand’s documents. Wait for it to finish, then delete the file.',
    )
    expect(dom.text()).toContain('brochure.pdf')
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

  it('Continue leads to the draft profile while suggestions are open, then to the questionnaire', async () => {
    const cases: [string, number, string][] = [
      ['profile', 3, 'profile'],
      ['profile', 0, 'questionnaire'],
      ['questionnaire', 0, 'questionnaire'],
    ]
    for (const [step, openSuggestions, where] of cases) {
      dom.replies.push({ status: 200, body: overview({ step, openSuggestions }) })
      await dom.mount(<OnboardingScreen brandId={brandId} />, sessionAs('owner'))
      expect(dom.host.querySelector(`a[href="/b/${brandId}/onboarding/${where}"]`)?.textContent).toBe(
        'Continue',
      )
      dom.stop()
      dom.start()
    }
  })

  const loadIntake = async (intakeBody: unknown = null) => {
    dom.replies.push(
      { status: 200, body: overview({ intake: intakeBody }) },
      { status: 200, body: { documents: [] } },
    )
    await dom.mount(<OnboardingIntakeScreen brandId={brandId} />, sessionAs('owner'))
  }
  const pdf = (name: string) => new File(['x'], name, { type: 'application/pdf' })

  it('a proxy 413 with an HTML page still says how to fix it', async () => {
    await loadIntake()
    xhrAnswer = { status: 413, body: null, raw: '<html><body>413 Request Entity Too Large</body></html>' }
    pick(dom, pdf('big.pdf'))
    await dom.settle()
    expect(dom.text()).toContain('over the size limit: PDF up to 100 MB, images up to 5 MB')
    expect(dom.text()).toContain('then upload it again')
  })

  it('a cut connection and a 502 say the upload was cut off', async () => {
    await loadIntake()
    xhrAnswer = { status: 0, body: null, fail: true }
    pick(dom, pdf('a.pdf'))
    await dom.settle()
    expect(dom.text()).toContain('Check your connection')
    xhrAnswer = { status: 502, body: null, raw: '<html>Bad gateway</html>' }
    pick(dom, pdf('b.pdf'))
    await dom.settle()
    expect(dom.text()).toContain(
      'The upload took too long or was cut off. Check your connection, then upload again.',
    )
  })

  it('several refused files each show their own error, and an empty name has its own copy', async () => {
    await loadIntake()
    pick(dom, pdf(`${'a'.repeat(201)}.pdf`), new File(['x'], 'notes.txt', { type: 'text/plain' }), pdf(' '))
    await dom.settle()
    const items = [...dom.host.querySelectorAll('.onb-errors li')].map((li) => li.textContent)
    expect(items).toHaveLength(3)
    expect(items[0]).toContain('Rename the file to 200 characters or fewer')
    expect(items[1]).toContain('notes.txt: Upload a PDF, PNG, JPEG or WebP file.')
    expect(items[2]).toBe('This file has no name. Rename it, then upload it again.')
    expect(xhrs).toHaveLength(0)
  })

  it('Start research is disabled while an upload is in progress', async () => {
    await loadIntake(intake)
    expect(dom.button('Start research').disabled).toBe(false)
    xhrAnswer = {
      status: 201,
      body: {
        id: 'd1',
        fileName: 'a.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 1,
        sha256: 'x',
        parts: 0,
      },
    }
    pick(dom, pdf('a.pdf'))
    expect(dom.button('Start research').disabled).toBe(true)
    await dom.settle()
    expect(dom.button('Start research').disabled).toBe(false)
  })

  it('a refusal to the owner-only screens shows one sentence and nothing to use', async () => {
    const refused = { status: 403, body: { error: { code: 'forbidden', message: 'No.' } } }
    dom.replies.push(refused, refused)
    await dom.mount(<OnboardingIntakeScreen brandId={brandId} />, sessionAs('owner'))
    expect(dom.text()).toBe('Only the platform owner can use onboarding.')
    expect(dom.host.querySelector('form, #in-file, button')).toBeNull()
  })

  it('the overview shows the same sentence on a 403', async () => {
    dom.replies.push({ status: 403, body: { error: { code: 'forbidden', message: 'No.' } } })
    await dom.mount(<OnboardingScreen brandId={brandId} />, sessionAs('owner'))
    expect(dom.text()).toBe('Only the platform owner can use onboarding.')
  })

  describe('polling', () => {
    const flush = async () => {
      for (let i = 0; i < 10; i += 1) await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    }
    const tick = async (ms: number) => {
      await act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
      await flush()
    }
    const groupOf = (state: string) => ({
      group: 'site',
      state,
      searches: 0,
      fetches: 0,
      cost: { usdMicros: '0', inrMicros: '0' },
      sources: [],
    })
    const reply = (state: string, merge: string) => ({
      status: 200,
      body: overview({
        step: 'research',
        intake,
        research: { runId: 'r1', state: 'running', groups: [groupOf(state)], merge, gaps: [] },
      }),
    })
    const gets = () => dom.calls.filter((c) => c.method === 'GET').length

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      dom.settle = flush
    })
    afterEach(() => vi.useRealTimers())

    it('asks again every 5 seconds while anything is open, and stops once all is settled', async () => {
      expect(POLL_MS).toBe(5000)
      dom.replies.push(reply('running', 'waiting'), reply('done', 'done'))
      await dom.mount(<ResearchProgressScreen brandId={brandId} />, sessionAs('owner'))
      expect(gets()).toBe(1)
      await tick(4999)
      expect(gets()).toBe(1)
      await tick(1)
      expect(gets()).toBe(2)
      await tick(20_000)
      expect(gets()).toBe(2)
    })

    it('stops once the run has failed, even when the merge never started', async () => {
      dom.replies.push({
        status: 200,
        body: overview({
          step: 'research',
          intake,
          research: { runId: 'r1', state: 'failed', groups: [groupOf('failed')], merge: 'waiting', gaps: [] },
        }),
      })
      await dom.mount(<ResearchProgressScreen brandId={brandId} />, sessionAs('owner'))
      await tick(20_000)
      expect(gets()).toBe(1)
    })

    it('stops when the screen is left', async () => {
      dom.replies.push(reply('running', 'waiting'), reply('running', 'waiting'))
      await dom.mount(<ResearchProgressScreen brandId={brandId} />, sessionAs('owner'))
      dom.stop()
      await tick(20_000)
      expect(gets()).toBe(1)
    })

    it('stops on a 403 or a 404 and says so', async () => {
      for (const [status, words] of [
        [403, 'Only the platform owner can use onboarding.'],
        [404, 'This brand was not found.'],
      ] as const) {
        dom.stop()
        dom.start()
        dom.replies.push(reply('running', 'waiting'), {
          status,
          body: { error: { code: 'x', message: 'x' } },
        })
        await dom.mount(<ResearchProgressScreen brandId={brandId} />, sessionAs('owner'))
        await tick(5000)
        expect(dom.text()).toContain(words)
        const before = gets()
        await tick(20_000)
        expect(gets()).toBe(before)
      }
    })
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
