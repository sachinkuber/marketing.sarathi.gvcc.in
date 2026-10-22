// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RunScreen, RunView, type RunDetail } from '../src/screens/RunDetail'
import { Dom, T, brandId, sessionAs } from './dom-support'

const runId = 'd0000000-0000-4000-8000-000000000001'
const jobId = 'd1000000-0000-4000-8000-000000000001'

const call = (
  id: string,
  extra: Partial<RunDetail['modelCalls'][number]> = {},
): RunDetail['modelCalls'][number] => ({
  id,
  runId,
  jobId,
  step: 'draft',
  model: 'claude-opus-5-5',
  status: 'succeeded',
  possibleDuplicate: false,
  inputTokens: 2140,
  outputTokens: 610,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  cost: { usdMicros: '31000', inrMicros: '2580000' },
  startedAt: T,
  finishedAt: T,
  ...extra,
})

const detail = {
  run: {
    id: runId,
    agent: 'summary',
    state: 'running' as const,
    startedByKind: 'user' as const,
    startedAt: T,
    finishedAt: null,
    cost: { usdMicros: '1234567', inrMicros: '102469061' },
  },
  jobs: [
    {
      id: jobId,
      jobClass: 'interactive' as const,
      state: 'finished' as const,
      expectedResultType: 'summary.v1',
      resultType: 'summary.v1',
      createdAt: T,
      finishedAt: T,
      attempts: [
        { number: 1, workerId: 'w1', state: 'failed' as const, startedAt: T, endedAt: T },
        { number: 2, workerId: 'w2', state: 'succeeded' as const, startedAt: T, endedAt: T },
      ],
    },
  ],
  modelCalls: [
    call('e0000000-0000-4000-8000-000000000001'),
    call('e0000000-0000-4000-8000-000000000002', { possibleDuplicate: true }),
    call('e0000000-0000-4000-8000-000000000003', { status: 'unknown', cost: null, outputTokens: null }),
  ],
  cost: { usdMicros: '1234567', inrMicros: '102469061' },
  audit: [
    {
      seq: 7,
      at: T,
      actorKind: 'user' as const,
      actorId: null,
      action: 'agent.run_started',
      outcome: 'success' as const,
      subject: runId,
      detail: { briefLength: 29 },
      hash: 'sha256:aa',
    },
  ],
  auditTruncated: false,
}

describe('the run detail', () => {
  it('shows jobs with their attempts, model calls with their flags, the cost in both currencies and the audit', () => {
    const html = renderToStaticMarkup(<RunView brandId={brandId} detail={detail} />)
    expect(html).toContain('$1.234567')
    expect(html).toContain('₹102.469061')
    expect(html).toContain('$0.031000')
    expect(html).toContain('Attempt 1')
    expect(html).toContain('Attempt 2')
    expect(html).toContain('Possible duplicate')
    expect(html).toContain('Outcome unknown')
    expect(html).toContain('No cost recorded')
    expect(html).toContain('Run started')
    expect(html).toContain(`href="/b/${brandId}/agents"`)
    expect(html).not.toMatch(/\sstyle=/)
  })

  it('says when the audit list was cut short', () => {
    const html = renderToStaticMarkup(
      <RunView brandId={brandId} detail={{ ...detail, audit: [], auditTruncated: true }} />,
    )
    expect(html).toContain('Older entries about this run may exist')
  })
})

describe('the run screen, driven', () => {
  const dom = new Dom()
  beforeEach(() => dom.start())
  afterEach(() => dom.stop())

  it('loads the run by its address and offers a retry when that fails', async () => {
    dom.replies.push({ status: 500, body: { error: { code: 'internal_error', message: 'x' } } })
    dom.replies.push({ status: 200, body: detail })
    await dom.mount(<RunScreen brandId={brandId} runId={runId} />, sessionAs('brand_admin'))
    expect(dom.calls[0]?.url).toBe(`/api/v1/brands/${brandId}/runs/${runId}`)
    expect(dom.text()).toContain('Could not load this run')
    await dom.click('Try again')
    expect(dom.text()).toContain('₹102.469061')
  })
})
