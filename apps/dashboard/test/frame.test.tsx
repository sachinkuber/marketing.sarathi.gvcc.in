import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusBanner } from '../src/frame/StatusBanner'
import { OverduePopup } from '../src/frame/OverduePopup'
import { SideMenu, menuFor } from '../src/frame/SideMenu'
import { StopButton } from '../src/frame/StopButton'
import { BrandSwitcher } from '../src/frame/BrandSwitcher'
import { LoadError } from '../src/frame/LoadError'
import { Empty } from '../src/frame/Empty'
import { ApiError } from '../src/api/client'

const quiet = {
  killSwitch: { active: false, scopes: [] },
  shadowMode: false,
  canApprove: true,
  canStop: true,
}
const noop = () => {}

describe('the status banner', () => {
  it('says "1 item overdue for approval" and links to the overdue inbox', () => {
    const html = renderToStaticMarkup(
      <StatusBanner brandId="b1" brandName="Aztek" status={quiet} overdueCount={1} />,
    )
    expect(html).toContain('1 item overdue for approval')
    expect(html).toContain('href="/b/b1/inbox?filter=overdue"')
    expect(html).toContain('banner warn')
  })

  it('says "3 items overdue for approval"', () => {
    const html = renderToStaticMarkup(
      <StatusBanner brandId="b1" brandName="Aztek" status={quiet} overdueCount={3} />,
    )
    expect(html).toContain('3 items overdue for approval')
  })

  it('shows no bar when nothing is wrong', () => {
    const html = renderToStaticMarkup(
      <StatusBanner brandId="b1" brandName="Aztek" status={quiet} overdueCount={0} />,
    )
    expect(html).not.toContain('class="banner')
    expect(html).not.toContain('overdue for approval')
  })

  it('shows a red bar when the kill switch is on, linking to the safety screen', () => {
    const html = renderToStaticMarkup(
      <StatusBanner
        brandId="b1"
        brandName="Aztek"
        status={{ ...quiet, killSwitch: { active: true, scopes: [{ scope: 'brand', target: null }] } }}
        overdueCount={0}
      />,
    )
    expect(html).toContain('banner danger')
    expect(html).toContain('Kill switch is on for Aztek')
    expect(html).toContain('href="/b/b1/settings/safety"')
  })

  it('shows an amber bar when shadow mode is on', () => {
    const html = renderToStaticMarkup(
      <StatusBanner
        brandId="b1"
        brandName="Aztek"
        status={{ ...quiet, shadowMode: true }}
        overdueCount={0}
      />,
    )
    expect(html).toContain('banner warn')
    expect(html).toContain('Shadow mode is on')
    expect(html).not.toContain('banner danger')
  })

  it('stacks the bars when several things hold at once', () => {
    const html = renderToStaticMarkup(
      <StatusBanner
        brandId="b1"
        brandName="Aztek"
        status={{ ...quiet, shadowMode: true, killSwitch: { active: true, scopes: [] } }}
        overdueCount={2}
      />,
    )
    expect(html).toContain('Kill switch is on')
    expect(html).toContain('Shadow mode is on')
    expect(html).toContain('2 items overdue for approval')
  })
})

describe('the overdue pop-up', () => {
  const items = [
    {
      contentItemId: 'i1',
      versionId: 'v1',
      title: 'First post',
      overdueSince: '2026-10-19T10:00:00Z',
      requestedAt: '2026-10-18T10:00:00Z',
    },
    {
      contentItemId: 'i2',
      versionId: 'v2',
      overdueSince: '2026-10-19T11:00:00Z',
      requestedAt: '2026-10-18T11:00:00Z',
    },
  ]

  it('is a modal dialog with exactly two choices and no close control', () => {
    const html = renderToStaticMarkup(
      <OverduePopup
        open
        items={items}
        busy={false}
        error={null}
        onChoice={noop}
        now={Date.parse('2026-10-20T10:00:00Z')}
      />,
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).toContain('Review now')
    expect(html).toContain('>Later<')
    expect(html).not.toMatch(/close|dismiss|&times;|×/i)
    expect(html).toContain('2 items overdue for approval')
    expect(html).toContain('First post')
  })

  it('renders nothing while it is not due', () => {
    expect(
      renderToStaticMarkup(
        <OverduePopup open={false} items={items} busy={false} error={null} onChoice={noop} now={0} />,
      ),
    ).toBe('')
  })
})

describe('the side menu', () => {
  const labels = (role: Parameters<typeof menuFor>[0]) => menuFor(role).map((item) => item.label)

  it('lists exactly what each role may use (app-flow 6)', () => {
    expect(labels('owner')).toEqual(['Home', 'Approval inbox', 'Agents', 'Alerts and incidents', 'Settings'])
    expect(labels('brand_admin')).toEqual([
      'Home',
      'Approval inbox',
      'Agents',
      'Alerts and incidents',
      'Settings',
    ])
    expect(labels('approver')).toEqual(['Home', 'Approval inbox'])
    expect(labels('sales_contact')).toEqual(['Home'])
    expect(labels('viewer')).toEqual(['Home'])
  })

  it('renders only those items, under the brand’s own address', () => {
    const html = renderToStaticMarkup(<SideMenu brandId="b1" role="approver" current="/b/b1/inbox" />)
    expect(html).toContain('href="/b/b1/inbox"')
    expect(html).toContain('aria-current="page"')
    expect(html).not.toContain('Agents')
    expect(html).not.toContain('Settings')
  })
})

describe('the stop button and the brand switcher', () => {
  it('shows the stop button only when the person can stop, linking to the safety screen', () => {
    expect(renderToStaticMarkup(<StopButton brandId="b1" canStop />)).toContain(
      'href="/b/b1/settings/safety"',
    )
    expect(renderToStaticMarkup(<StopButton brandId="b1" canStop={false} />)).toBe('')
  })

  it('lists the brands for the switcher', () => {
    const html = renderToStaticMarkup(
      <BrandSwitcher
        currentId="b1"
        brands={[
          { id: 'b1', name: 'Aztek', slug: 'aztek', status: 'active', role: 'platform_owner' },
          { id: 'b2', name: '11oils', slug: '11oils', status: 'active', role: 'platform_owner' },
        ]}
        onSwitch={noop}
      />,
    )
    expect(html).toContain('Aztek')
    expect(html).toContain('11oils')
    expect(html).toContain('All brands')
  })
})

describe('empty and error states', () => {
  it('a failed load says what failed and offers a retry', () => {
    const html = renderToStaticMarkup(
      <LoadError what="the inbox" error={new ApiError(500, 'internal_error', 'x')} onRetry={noop} />,
    )
    expect(html).toContain('the inbox')
    expect(html).toContain('Try again')
    expect(html).toContain('role="alert"')
  })

  it('an empty list says what will appear', () => {
    const html = renderToStaticMarkup(
      <Empty title="Nothing waiting">Items appear here when an agent finishes one.</Empty>,
    )
    expect(html).toContain('Nothing waiting')
    expect(html).toContain('Items appear here')
  })
})
