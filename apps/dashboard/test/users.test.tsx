// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CodeForm } from '../src/screens/CodeForm'
import { INVITE_ROLES, UsersScreen } from '../src/screens/Users'
import { Dom, ME, T, brandId, failure, sessionAs } from './dom-support'

const meera = 'c0000000-0000-4000-8000-000000000002'
const anil = 'c0000000-0000-4000-8000-000000000003'

const member = (userId: string, name: string, role: string, twoFactorEnabled = true) => ({
  userId,
  email: `${name.toLowerCase()}@example.test`,
  name,
  role,
  twoFactorEnabled,
  since: T,
})

const users = {
  members: [
    member(ME, 'Me', 'brand_admin'),
    member(meera, 'Meera', 'brand_admin'),
    member(anil, 'Anil', 'approver'),
  ],
  pendingInvites: [
    {
      id: 'f0000000-0000-4000-8000-000000000001',
      email: 'priya@example.test',
      role: 'approver',
      expiresAt: '2026-10-23T10:00:00.000Z',
      expired: false,
    },
  ],
}

describe('the code form for sensitive actions', () => {
  it('renders the 6-digit code field, and its submit button starts disabled', () => {
    const html = renderToStaticMarkup(
      <CodeForm
        id="t"
        title="Remove Anil"
        explain="Anil loses access to this brand."
        submitLabel="Remove"
        busy={false}
        error={null}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    )
    const code = html.indexOf('id="t-code"')
    const submit = html.indexOf('>Remove</button>')
    expect(code).toBeGreaterThan(-1)
    expect(submit).toBeGreaterThan(code)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Remove<\/button>/)
    expect(html).toMatch(/autocomplete="one-time-code"/i)
    expect(html).not.toMatch(/\sstyle=/)
  })

  it('offers the four brand roles to invite, never the platform owner (app-flow 5.3)', () => {
    expect(INVITE_ROLES.map((r) => r.value)).toEqual(['approver', 'brand_admin', 'sales_contact', 'viewer'])
  })
})

describe('the users screen, driven', () => {
  const dom = new Dom()
  beforeEach(() => dom.start())
  afterEach(() => dom.stop())

  it('lists people and pending invites; the person’s own row has no actions; only the owner may reset a second factor', async () => {
    dom.replies.push({ status: 200, body: users })
    await dom.mount(<UsersScreen brandId={brandId} />, sessionAs('brand_admin'))
    expect(dom.text()).toContain('Meera')
    expect(dom.text()).toContain('priya@example.test')
    expect(dom.text()).toContain('This is you')
    expect(dom.buttons('Change role')).toHaveLength(2)
    expect(dom.buttons('Remove')).toHaveLength(2)
    expect(dom.buttons('Reset second factor')).toHaveLength(0)
  })

  it('asks for the code before changing a role, sends it in the body, and keeps the change when the reload fails', async () => {
    dom.replies.push({ status: 200, body: users })
    await dom.mount(<UsersScreen brandId={brandId} />, sessionAs('brand_admin'))
    await dom.click('Change role', 1)
    expect(dom.field('act-code')).not.toBeNull()
    expect(dom.button('Change role', 2).disabled).toBe(true)
    // The picker starts at Anil's own role: with a full code, the same role still cannot be sent.
    dom.type('act-code', '123456')
    expect(dom.button('Change role', 2).disabled).toBe(true)
    dom.type('act-role', 'viewer')
    dom.type('act-code', '12345')
    expect(dom.button('Change role', 2).disabled).toBe(true)
    dom.type('act-code', '123456')
    expect(dom.button('Change role', 2).disabled).toBe(false)
    dom.replies.push({ status: 200, body: { userId: anil, role: 'viewer', changed: true } }, failure)
    await dom.submit('Change role', 2)
    expect(dom.writes()).toEqual([
      {
        url: `/api/v1/brands/${brandId}/users/${anil}`,
        method: 'PATCH',
        body: { role: 'viewer', code: '123456' },
      },
    ])
    expect(dom.text()).toContain('Anil is now a viewer.')
    expect(dom.text()).toContain('reload the page')
    expect(dom.host.querySelector('[role="alert"]')).toBeNull()
    expect(dom.field('act-code')).toBeNull()
    expect(dom.buttons('Remove').every((b) => b.disabled)).toBe(true)
  })

  it('keeps the form open and says so when the code is wrong', async () => {
    dom.replies.push({ status: 200, body: users })
    await dom.mount(<UsersScreen brandId={brandId} />, sessionAs('brand_admin'))
    await dom.click('Remove', 1)
    dom.type('act-code', '000000')
    dom.replies.push({ status: 403, body: { error: { code: 'second_factor_invalid', message: 'x' } } })
    await dom.submit('Remove', 2)
    expect(dom.writes()[0]).toEqual({
      url: `/api/v1/brands/${brandId}/users/${anil}`,
      method: 'DELETE',
      body: { code: '000000' },
    })
    expect(dom.host.querySelector('[role="alert"]')?.textContent).toContain('The code is not right')
    // The form stays open with the refused code cleared, so a retry needs a fresh code.
    expect((dom.field('act-code') as HTMLInputElement).value).toBe('')
    expect(dom.button('Remove', 2).disabled).toBe(true)
  })

  it('says nothing changed when the core reports the role was already set', async () => {
    dom.replies.push({ status: 200, body: users })
    await dom.mount(<UsersScreen brandId={brandId} />, sessionAs('brand_admin'))
    await dom.click('Change role', 1)
    dom.type('act-role', 'viewer')
    dom.type('act-code', '123456')
    dom.replies.push(
      { status: 200, body: { userId: anil, role: 'viewer', changed: false } },
      { status: 200, body: users },
    )
    await dom.submit('Change role', 2)
    expect(dom.text()).toContain('Nothing changed: Anil is already a viewer.')
    expect(dom.text()).not.toContain('Anil is now a viewer.')
  })

  it('lets the platform owner reset a second factor with the owner’s code', async () => {
    dom.replies.push({ status: 200, body: users })
    await dom.mount(<UsersScreen brandId={brandId} />, sessionAs('owner'))
    // The owner's own row has no actions: Meera's and Anil's rows have the button, then the form's own.
    expect(dom.buttons('Reset second factor')).toHaveLength(2)
    await dom.click('Reset second factor', 0)
    dom.type('act-code', '654321')
    dom.replies.push({ status: 204 }, { status: 200, body: users })
    await dom.submit('Reset second factor', 2)
    expect(dom.writes()[0]).toEqual({
      url: `/api/v1/users/${meera}/second-factor/reset`,
      method: 'POST',
      body: { code: '654321' },
    })
    expect(dom.text()).toContain('second factor was reset')
  })

  it('invites with an email and a role, no code, and shows the invite as pending', async () => {
    dom.replies.push({ status: 200, body: users })
    await dom.mount(<UsersScreen brandId={brandId} />, sessionAs('brand_admin'))
    dom.type('invite-email', 'not-an-email')
    await dom.submit('Send invite')
    expect(dom.writes()).toHaveLength(0)
    expect(dom.text()).toContain('Enter an email address')
    dom.type('invite-email', 'new@example.test')
    dom.type('invite-role', 'viewer')
    const fresh = {
      ...users,
      pendingInvites: [
        ...users.pendingInvites,
        {
          id: 'f0000000-0000-4000-8000-000000000002',
          email: 'new@example.test',
          role: 'viewer',
          expiresAt: T,
          expired: false,
        },
      ],
    }
    dom.replies.push(
      { status: 201, body: { id: 'f0000000-0000-4000-8000-000000000002', expiresAt: T } },
      { status: 200, body: fresh },
    )
    await dom.submit('Send invite')
    expect(dom.writes()).toEqual([
      {
        url: `/api/v1/brands/${brandId}/users/invites`,
        method: 'POST',
        body: { email: 'new@example.test', role: 'viewer' },
      },
    ])
    expect(dom.text()).toContain('Invite sent to new@example.test')
    expect(dom.text()).toContain('new@example.test')
  })
})
