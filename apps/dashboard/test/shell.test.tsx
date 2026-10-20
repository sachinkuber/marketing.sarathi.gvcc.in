import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  popupKeyAction,
  popupTarget,
  shouldPollOverdue,
  stopTarget,
  switcherBrands,
} from '../src/frame/gating'
import { isUuid } from '../src/api/ids'
import { apiRouting } from '../api-routing'
import { OverduePopup } from '../src/frame/OverduePopup'
import { StatusBanner } from '../src/frame/StatusBanner'
import { BackupCodes } from '../src/auth/BackupCodes'
import { EnrolSetup } from '../src/auth/EnrolSetup'
import { SignInForm } from '../src/auth/SignInForm'
import { RecoverForm } from '../src/auth/RecoverForm'
import { InviteForm } from '../src/auth/InviteForm'
import { LoadError } from '../src/frame/LoadError'
import { enrolMessage, signInMessage } from '../src/api/auth'
import { ApiError } from '../src/api/client'

const noop = () => {}
const owner = { platformOwner: true, memberships: [] }
const member = (role: 'brand_admin' | 'approver' | 'sales_contact' | 'viewer') => ({
  platformOwner: false,
  memberships: [{ brandId: 'b1', role }],
})

describe('who the shell asks about overdue items, and who gets the switcher', () => {
  it('polls only for people who can approve somewhere', () => {
    expect(shouldPollOverdue(owner)).toBe(true)
    expect(shouldPollOverdue(member('approver'))).toBe(true)
    expect(shouldPollOverdue(member('brand_admin'))).toBe(true)
    expect(shouldPollOverdue(member('viewer'))).toBe(false)
    expect(shouldPollOverdue(member('sales_contact'))).toBe(false)
    expect(shouldPollOverdue({ platformOwner: false, memberships: [] })).toBe(false)
  })

  it('gives the brand list to the platform owner only', () => {
    const brands = [{ id: 'b1', name: 'Aztek', slug: 'aztek', status: 'active', role: 'platform_owner' }]
    expect(switcherBrands(owner, brands)).toEqual(brands)
    expect(switcherBrands(member('brand_admin'), brands)).toBeNull()
    expect(switcherBrands(member('approver'), brands)).toBeNull()
    expect(switcherBrands(member('viewer'), brands)).toBeNull()
  })

  it('opens the pop-up for the first brand whose pop-up is due', () => {
    const entry = (brandId: string, popupDue: boolean) => ({
      brandId,
      brandName: brandId,
      count: 1,
      popupDue,
      firstRequestId: 'r',
      firstItemId: 'i',
      items: [],
    })
    expect(popupTarget(null)).toBeNull()
    expect(popupTarget({ brands: [] })).toBeNull()
    expect(popupTarget({ brands: [entry('a', false), entry('b', true), entry('c', true)] })?.brandId).toBe(
      'b',
    )
    expect(popupTarget({ brands: [entry('a', false)] })).toBeNull()
  })

  it('sends the stop button of a brand-less screen to the right place', () => {
    expect(stopTarget(owner)).toBe('/brands')
    expect(stopTarget(member('brand_admin'))).toBe('/b/b1/settings/safety')
    expect(stopTarget(member('approver'))).toBeNull()
    expect(stopTarget(member('viewer'))).toBeNull()
    expect(
      stopTarget({
        platformOwner: false,
        memberships: [
          { brandId: 'a', role: 'brand_admin' },
          { brandId: 'b', role: 'brand_admin' },
        ],
      }),
    ).toBe('/brands')
  })

  it('accepts only a uuid as a brand id from the address', () => {
    expect(isUuid('6c77c301-7cb4-4c81-8551-1a0fbe6dce41')).toBe(true)
    for (const bad of ['..%2F..%2Fx', '../x', 'abc', '', '6c77c301-7cb4-4c81-8551-1a0fbe6dce41/x']) {
      expect(isUuid(bad)).toBe(false)
    }
  })
})

describe('the pop-up keyboard rules', () => {
  it('ignores Escape (and swallows it) so it cannot be dismissed', () => {
    expect(popupKeyAction('Escape', false, 'first', 2)).toEqual({ prevent: true, focus: null })
  })
  it('cycles Tab inside the dialog', () => {
    expect(popupKeyAction('Tab', false, 'last', 2)).toEqual({ prevent: true, focus: 'first' })
    expect(popupKeyAction('Tab', true, 'first', 2)).toEqual({ prevent: true, focus: 'last' })
    expect(popupKeyAction('Tab', false, 'first', 2)).toEqual({ prevent: false, focus: null })
    expect(popupKeyAction('Tab', false, 'other', 2)).toEqual({ prevent: true, focus: 'first' })
  })
  it('keeps focus on the dialog itself while the buttons are disabled', () => {
    expect(popupKeyAction('Tab', false, 'none', 0)).toEqual({ prevent: true, focus: 'dialog' })
    expect(popupKeyAction('Tab', true, 'none', 0)).toEqual({ prevent: true, focus: 'dialog' })
  })
  it('leaves other keys alone', () => {
    expect(popupKeyAction('a', false, 'first', 2)).toEqual({ prevent: false, focus: null })
  })
})

describe('the pop-up markup', () => {
  const items = [
    {
      contentItemId: 'i1',
      versionId: 'v1',
      title: 'First',
      overdueSince: '2026-10-19T10:00:00Z',
      requestedAt: '2026-10-18T10:00:00Z',
    },
  ]
  it('names the brand, is focusable as a dialog, and has no backdrop handler or close control', () => {
    const html = renderToStaticMarkup(
      <OverduePopup
        open
        items={items}
        brandName="11oils"
        busy
        error={null}
        now={Date.parse('2026-10-20T10:00:00Z')}
        onChoice={noop}
      />,
    )
    expect(html).toContain('11oils')
    expect(html).toMatch(/tabindex="-1"/i)
    expect(html).toContain('1 item overdue for approval')
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).not.toMatch(/onclick|close|dismiss/i)
  })
})

describe('the kill-switch wording follows the scope', () => {
  const base = { shadowMode: false, canApprove: false, canStop: true }
  it('says the whole brand is stopped only for a brand scope', () => {
    const html = renderToStaticMarkup(
      <StatusBanner
        brandId="b1"
        brandName="Aztek"
        status={{ ...base, killSwitch: { active: true, scopes: [{ scope: 'brand', target: null }] } }}
        overdueCount={0}
      />,
    )
    expect(html).toContain('Kill switch is on for Aztek')
    expect(html).toContain('nothing is being sent')
  })
  it('names the channels and agents for a narrower scope and does not claim a full stop', () => {
    const html = renderToStaticMarkup(
      <StatusBanner
        brandId="b1"
        brandName="Aztek"
        status={{
          ...base,
          killSwitch: {
            active: true,
            scopes: [
              { scope: 'channel', target: 'linkedin' },
              { scope: 'agent', target: 'summary' },
            ],
          },
        }}
        overdueCount={0}
      />,
    )
    expect(html).toContain('linkedin')
    expect(html).toContain('summary')
    expect(html).not.toContain('nothing is being sent')
    expect(html).toContain('Other work continues')
  })
})

describe('copy and markup fixes', () => {
  it('the backup-codes note does not promise a return to this step, and the list is a labelled group', () => {
    const html = renderToStaticMarkup(<BackupCodes codes={['A-1']} onContinue={noop} />)
    expect(html).toContain('these codes cannot be shown again')
    expect(html).not.toContain('next sign-in returns here')
    expect(html).toMatch(/role="group"/)
  })
  it('the setup key is labelled for assistive technology', () => {
    const html = renderToStaticMarkup(
      <EnrolSetup totpUri="otpauth://x?secret=ABC" secret="ABC" busy={false} error={null} onVerify={noop} />,
    )
    expect(html).toMatch(/aria-labelledby="setupkey-label"/)
    expect(html).toContain('id="setupkey-label"')
  })
  it('no screen puts a style attribute in its markup (the production CSP would refuse it)', () => {
    const pages = [
      renderToStaticMarkup(<SignInForm busy={false} error={null} onSubmit={noop} />),
      renderToStaticMarkup(<RecoverForm sent={false} busy={false} error={null} onSubmit={noop} />),
      renderToStaticMarkup(<RecoverForm sent busy={false} error={null} onSubmit={noop} />),
      renderToStaticMarkup(
        <InviteForm
          state={{ kind: 'ready', invite: { email: 'a@b.test', role: 'viewer', brandName: 'X' } }}
          busy={false}
          error={null}
          onSubmit={noop}
        />,
      ),
      renderToStaticMarkup(<LoadError what="x" error={null} onRetry={noop} />),
    ]
    for (const html of pages) expect(html).not.toMatch(/\sstyle=/)
  })
})

describe('what a person is told when a sign-in step fails', () => {
  it('does not blame the password for a request-token failure', () => {
    const csrf = new ApiError(403, 'bad_csrf_token', 'x')
    expect(signInMessage(csrf)).not.toMatch(/password/i)
    expect(enrolMessage(csrf)).not.toMatch(/password is not right/i)
    expect(enrolMessage(new ApiError(0, 'network', 'x'))).not.toMatch(/password is not right/i)
  })
  it('still says the password is wrong when the library says so', () => {
    expect(enrolMessage(new ApiError(400, 'INVALID_PASSWORD', 'x'))).toMatch(/password is not right/i)
    expect(signInMessage(new ApiError(401, 'INVALID_EMAIL_OR_PASSWORD', 'x'))).toMatch(/email or password/i)
  })
})

describe('the /api routing guard for the build', () => {
  const build = 'phase-production-build'
  it('refuses a production build that says nothing about how /api is routed', () => {
    expect(() => apiRouting(build, {})).toThrow(/CORE_INTERNAL_URL/)
  })
  it('accepts a build with the core address, and bakes the rewrite', () => {
    expect(apiRouting(build, { CORE_INTERNAL_URL: 'http://core:3000' })).toEqual({ core: 'http://core:3000' })
  })
  it('accepts a build that states the reverse proxy routes /api', () => {
    expect(apiRouting(build, { DASHBOARD_PROXY_ROUTES_API: '1' })).toEqual({ core: null })
    expect(() => apiRouting(build, { DASHBOARD_PROXY_ROUTES_API: 'yes' })).toThrow()
  })
  it('needs the address in development and refuses a malformed one anywhere', () => {
    expect(() => apiRouting('phase-development-server', {})).toThrow(/CORE_INTERNAL_URL/)
    expect(() => apiRouting(build, { CORE_INTERNAL_URL: 'core:3000/x' })).toThrow()
  })
})
