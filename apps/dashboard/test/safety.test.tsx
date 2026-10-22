// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SafetyScreen } from '../src/screens/Safety'
import { Dom, ME, T, brandId, failure, sessionAs } from './dom-support'

const brandSwitch = {
  id: 'a1000000-0000-4000-8000-000000000001',
  scope: 'brand',
  target: null,
  active: true,
  setBy: ME,
  setAt: T,
}
const channelSwitch = {
  id: 'a1000000-0000-4000-8000-000000000002',
  scope: 'channel',
  target: 'instagram',
  active: true,
  setBy: ME,
  setAt: T,
}

const home = (held: number) => ({
  results: null,
  progress: { jobs: { waiting: 0, running: 0, held, dead: 0, finished: 4 } },
  waiting: null,
  problems: { deadJobs: 0, openAlerts: 0, reviewCalls: 0 },
})

describe('the safety screen, driven', () => {
  const dom = new Dom()
  beforeEach(() => dom.start())
  afterEach(() => dom.stop())

  const load = (switches: unknown[], held: number, shadowMode = false) =>
    dom.replies.push({ status: 200, body: { switches, shadowMode } }, { status: 200, body: home(held) })

  it('shows what is held now and which switches are on', async () => {
    load([brandSwitch], 3)
    await dom.mount(<SafetyScreen brandId={brandId} />, sessionAs('brand_admin'))
    expect(dom.calls.map((c) => c.url)).toEqual([
      `/api/v1/brands/${brandId}/kill-switch`,
      `/api/v1/brands/${brandId}/home`,
    ])
    expect(dom.text()).toContain('3 jobs are held')
    expect(dom.text()).toContain('Whole brand')
    expect(dom.buttons('Release')).toHaveLength(1)
  })

  it('says nothing is held when nothing is', async () => {
    load([], 0)
    await dom.mount(<SafetyScreen brandId={brandId} />, sessionAs('brand_admin'))
    expect(dom.text()).toContain('Nothing is held')
    expect(dom.text()).toContain('No switch is on')
  })

  it('needs the code to stop, sends scope, target and code, and keeps the result when the reload fails', async () => {
    load([], 0)
    await dom.mount(<SafetyScreen brandId={brandId} />, sessionAs('brand_admin'))
    expect(dom.field('ks-code')).not.toBeNull()
    expect(dom.button('Stop').disabled).toBe(true)
    dom.type('ks-scope', 'channel')
    dom.type('ks-channel', 'instagram')
    dom.type('ks-code', '123456')
    expect(dom.button('Stop').disabled).toBe(false)
    dom.replies.push({ status: 200, body: { switch: channelSwitch, held: 0, created: true } }, failure)
    await dom.submit('Stop')
    expect(dom.writes()).toEqual([
      {
        url: `/api/v1/brands/${brandId}/kill-switch`,
        method: 'POST',
        body: { scope: 'channel', target: 'instagram', code: '123456' },
      },
    ])
    expect(dom.text()).toContain('Stopped.')
    expect(dom.text()).toContain('reload the page')
    expect(dom.host.querySelector('[role="alert"]')).toBeNull()
    // The code is spent and the screen is out of date: the form is cleared and nothing more is sent from it.
    expect((dom.field('ks-code') as HTMLInputElement).value).toBe('')
    expect(dom.button('Stop').disabled).toBe(true)
  })

  it('stops a single agent by name', async () => {
    load([], 0)
    await dom.mount(<SafetyScreen brandId={brandId} />, sessionAs('brand_admin'))
    dom.type('ks-scope', 'agent')
    dom.type('ks-code', '123456')
    dom.replies.push({
      status: 200,
      body: { switch: { ...channelSwitch, scope: 'agent', target: 'summary' }, held: 2, created: true },
    })
    load([{ ...channelSwitch, scope: 'agent', target: 'summary' }], 2)
    await dom.submit('Stop')
    expect(dom.writes()[0]?.body).toEqual({ scope: 'agent', target: 'summary', code: '123456' })
    expect(dom.text()).toContain('2 waiting jobs were held')
    expect(dom.text()).toContain('2 jobs are held')
  })

  it('needs the code again to release, and says how much work resumes', async () => {
    load([brandSwitch], 3)
    await dom.mount(<SafetyScreen brandId={brandId} />, sessionAs('brand_admin'))
    await dom.click('Release')
    expect(dom.field('rel-code')).not.toBeNull()
    expect(dom.button('Release', 1).disabled).toBe(true)
    dom.type('rel-code', '654321')
    dom.replies.push({ status: 200, body: { released: true, unheld: 3 } })
    load([], 0)
    await dom.submit('Release', 1)
    expect(dom.writes()).toEqual([
      {
        url: `/api/v1/brands/${brandId}/kill-switch/release`,
        method: 'POST',
        body: { scope: 'brand', code: '654321' },
      },
    ])
    expect(dom.text()).toContain('Released. 3 held jobs resume.')
    expect(dom.text()).toContain('Nothing is held')
    expect(dom.field('rel-code')).toBeNull()
  })

  it('says so when the code is wrong, and sends nothing else', async () => {
    load([brandSwitch], 3)
    await dom.mount(<SafetyScreen brandId={brandId} />, sessionAs('brand_admin'))
    await dom.click('Release')
    dom.type('rel-code', '000000')
    dom.replies.push({ status: 403, body: { error: { code: 'second_factor_invalid', message: 'x' } } })
    await dom.submit('Release', 1)
    expect(dom.host.querySelector('[role="alert"]')?.textContent).toContain('The code is not right')
    expect(dom.calls).toHaveLength(3)
  })

  it('shows the shadow toggle to the platform owner only', async () => {
    load([], 0)
    await dom.mount(<SafetyScreen brandId={brandId} />, sessionAs('brand_admin'))
    expect(dom.text()).toContain('Shadow mode is off')
    expect(dom.buttons('Turn shadow mode on')).toHaveLength(0)
    expect(dom.text()).toContain('Only the platform owner can turn shadow mode on or off')
  })

  it('lets the platform owner turn shadow mode on', async () => {
    load([], 0)
    await dom.mount(<SafetyScreen brandId={brandId} />, sessionAs('owner'))
    dom.replies.push({ status: 200, body: { shadowMode: true } })
    await dom.click('Turn shadow mode on')
    expect(dom.writes()).toEqual([
      { url: `/api/v1/brands/${brandId}/shadow-mode`, method: 'PATCH', body: { shadow_mode: true } },
    ])
    expect(dom.text()).toContain('Shadow mode is on')
    expect(dom.buttons('Turn shadow mode off')).toHaveLength(1)
  })

  it('tells someone who cannot use the kill switch so, and asks the core nothing', async () => {
    await dom.mount(<SafetyScreen brandId={brandId} />, sessionAs('approver'))
    expect(dom.text()).toContain('Only the platform owner and the brand admin')
    expect(dom.calls).toHaveLength(0)
  })
})
