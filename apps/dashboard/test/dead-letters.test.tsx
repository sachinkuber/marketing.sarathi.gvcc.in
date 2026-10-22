// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeadLetterList, DeadLettersScreen } from '../src/screens/DeadLetters'
import { HomeBlocks } from '../src/screens/HomeBlocks'
import { AlertList } from '../src/screens/Alerts'
import { Dom, T, brandId, failure, sessionAs } from './dom-support'

const job = (n: number) => ({
  jobId: `d1000000-0000-4000-8000-00000000000${n}`,
  runId: `d0000000-0000-4000-8000-00000000000${n}`,
  jobClass: 'interactive' as const,
  deadAt: T,
  attempts: 3,
})

describe('dead letters', () => {
  it('lists each dead job with its attempts, its run and the two actions', () => {
    const html = renderToStaticMarkup(
      <DeadLetterList
        brandId={brandId}
        jobs={[job(1), job(2)]}
        disabled={false}
        onRequeue={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(html).toContain('Failed after 3 attempts')
    expect(html).toContain(`href="/b/${brandId}/agents/runs/${job(1).runId}"`)
    expect(html.match(/>Requeue</g)).toHaveLength(2)
    expect(html.match(/>Cancel</g)).toHaveLength(2)
    expect(html).not.toMatch(/\sstyle=/)
  })

  it('says what appears there when nothing is dead', () => {
    const html = renderToStaticMarkup(
      <DeadLetterList
        brandId={brandId}
        jobs={[]}
        disabled={false}
        onRequeue={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(html).toContain('No jobs have used all their attempts')
  })

  it('links to dead letters from home and alerts only for the platform owner', () => {
    const home = {
      results: null,
      progress: null,
      waiting: null,
      problems: { deadJobs: 2, openAlerts: 0, reviewCalls: 0 },
    }
    const href = `href="/b/${brandId}/agents/dead-letters"`
    const owner = renderToStaticMarkup(<HomeBlocks brandId={brandId} home={home} now={0} canSeeDeadLetters />)
    expect(owner).toContain(href)
    const admin = renderToStaticMarkup(
      <HomeBlocks brandId={brandId} home={home} now={0} canSeeDeadLetters={false} />,
    )
    expect(admin).toContain('2 jobs are in dead letters')
    expect(admin).not.toContain(href)
    expect(admin).toContain('The platform owner deals with these')

    const alert = {
      id: 'e0000000-0000-4000-8000-000000000001',
      severity: 2,
      kind: 'dead_job',
      detail: {},
      raisedAt: T,
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolvedAt: null,
      delivered: true,
      deliveryAttempts: 1,
      deliveryStalled: false,
      deliveryIssue: null,
    }
    const list = (canSeeDeadLetters: boolean) =>
      renderToStaticMarkup(
        <AlertList
          brandId={brandId}
          alerts={[alert]}
          canAck
          canSeeDeadLetters={canSeeDeadLetters}
          busyId={null}
          error={null}
          onAck={() => {}}
        />,
      )
    expect(list(true)).toContain(href)
    expect(list(false)).not.toContain(href)
  })
})

describe('the dead-letters screen, driven', () => {
  const dom = new Dom()
  beforeEach(() => dom.start())
  afterEach(() => dom.stop())

  it('tells a brand admin it is the platform owner’s and asks the core nothing', async () => {
    await dom.mount(<DeadLettersScreen brandId={brandId} />, sessionAs('brand_admin'))
    expect(dom.text()).toContain('platform owner only')
    expect(dom.calls).toHaveLength(0)
  })

  it('requeues a job and reports it as done even when the list cannot be reloaded', async () => {
    dom.replies.push({ status: 200, body: [job(1), job(2)] }, { status: 204 }, failure)
    await dom.mount(<DeadLettersScreen brandId={brandId} />, sessionAs('owner'))
    await dom.click('Requeue')
    expect(dom.writes()).toEqual([
      { url: `/api/v1/brands/${brandId}/jobs/${job(1).jobId}/requeue`, method: 'POST', body: {} },
    ])
    expect(dom.text()).toContain('Requeued.')
    expect(dom.text()).toContain('reload the page')
    expect(dom.host.querySelector('[role="alert"]')).toBeNull()
    // The list on screen is out of date: nothing more may be sent from it.
    expect(dom.buttons('Requeue').every((b) => b.disabled)).toBe(true)
    expect(dom.buttons('Cancel').every((b) => b.disabled)).toBe(true)
  })

  it('cancels a job and shows the fresh list', async () => {
    dom.replies.push(
      { status: 200, body: [job(1), job(2)] },
      { status: 204 },
      { status: 200, body: [job(1)] },
    )
    await dom.mount(<DeadLettersScreen brandId={brandId} />, sessionAs('owner'))
    await dom.click('Cancel', 1)
    expect(dom.writes()[0]?.url).toBe(`/api/v1/brands/${brandId}/jobs/${job(2).jobId}/cancel`)
    expect(dom.text()).toContain('Cancelled.')
    expect(dom.buttons('Requeue')).toHaveLength(1)
    expect(dom.button('Requeue').disabled).toBe(false)
  })

  it('says why a refused action failed', async () => {
    dom.replies.push(
      { status: 200, body: [job(1)] },
      { status: 409, body: { error: { code: 'job_not_dead', message: 'x' } } },
    )
    await dom.mount(<DeadLettersScreen brandId={brandId} />, sessionAs('owner'))
    await dom.click('Requeue')
    expect(dom.host.querySelector('[role="alert"]')?.textContent).toContain('no longer in dead letters')
  })
})
