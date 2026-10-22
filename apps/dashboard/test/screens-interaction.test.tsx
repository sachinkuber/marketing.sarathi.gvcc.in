// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { setCsrfToken } from '../src/api/client'
import type { Session } from '../src/api/session'
import { ShellContext } from '../src/frame/shell-context'
import { ItemScreen } from '../src/screens/ItemScreen'
import { BrandAlertsScreen } from '../src/screens/Alerts'

// Renders the real screens in a DOM and drives them with clicks and typing; the platform is a queue of replies.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const brandId = '6c77c301-7cb4-4c81-8551-1a0fbe6dce41'
const itemId = 'a0000000-0000-4000-8000-000000000001'
const v1 = 'b0000000-0000-4000-8000-000000000001'
const v2 = 'b0000000-0000-4000-8000-000000000002'
const HASH1 = `sha256:1a2b3c4d5e6f${'0'.repeat(52)}`
const HASH2 = `sha256:9f8e7d6c5b4a${'1'.repeat(52)}`
const T = '2026-10-20T10:00:00.000Z'

const session: Session = {
  user: { id: 'u1', email: 'a@example.test', name: 'Approver' },
  twoFactorEnabled: true,
  needsSecondFactor: false,
  enrolmentRequired: false,
  platformOwner: false,
  memberships: [{ brandId, role: 'approver' }],
  csrfToken: 'tok-1',
}

const version = (id: string, number: number, hash: string, state: string, summary: string) => ({
  id,
  number,
  state,
  stateChangedAt: T,
  hash,
  hashScheme: 'cv1',
  payload: {
    kind: 'summary',
    language: 'en',
    title: 'Summary of the brief',
    summary,
    body: [
      { type: 'paragraph', text: summary },
      { type: 'list', ordered: false, items: ['film'] },
    ],
  },
  createdBy: { kind: 'agent', userId: null, runId: null },
  createdAt: T,
  checks: [],
})
const itemV1 = {
  id: itemId,
  kind: 'summary',
  currentVersionId: v1,
  createdAt: T,
  versions: [version(v1, 1, HASH1, 'awaiting_approval', 'First text')],
}
const itemV2 = {
  ...itemV1,
  currentVersionId: v2,
  versions: [
    version(v1, 1, HASH1, 'superseded', 'First text'),
    version(v2, 2, HASH2, 'awaiting_approval', 'Second text'),
  ],
}
const failure = { status: 500, body: { error: { code: 'internal_error', message: 'x' } } }

interface Call {
  url: string
  method: string
  body: unknown
}
let calls: Call[]
let replies: Array<{ status: number; body: unknown }>
let root: Root | null
let host: HTMLElement

beforeEach(() => {
  calls = []
  replies = []
  root = null
  setCsrfToken('tok-1')
  host = document.createElement('div')
  document.body.append(host)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; body?: string }) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
      const next = replies.shift() ?? failure
      return new Response(JSON.stringify(next.body), { status: next.status })
    }),
  )
})
afterEach(() => {
  act(() => root?.unmount())
  host.remove()
  vi.unstubAllGlobals()
  setCsrfToken(null)
})

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(ui: React.ReactNode) {
  root = createRoot(host)
  act(() =>
    root!.render(
      <ShellContext value={{ session, overdue: null, reload: async () => {} }}>{ui}</ShellContext>,
    ),
  )
  await settle()
}

const button = (label: string) => {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`no button "${label}" in: ${host.textContent}`)
  return found
}

async function click(label: string) {
  act(() => button(label).click())
  await settle()
}

function type(id: string, value: string) {
  const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)
  if (!field) throw new Error(`no field #${id}`)
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set
  act(() => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit(label: string) {
  const form = button(label).closest('form')
  if (!form) throw new Error(`no form around "${label}"`)
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await settle()
}

const approves = () => calls.filter((c) => c.url.endsWith('/approve'))

describe('the item screen, driven', () => {
  it('approves the version on screen; on 409 it shows the new version and says so, approving nothing', async () => {
    replies.push(
      { status: 200, body: itemV1 },
      { status: 409, body: { error: { code: 'stale_hash', message: 'changed' } } },
      { status: 200, body: itemV2 },
    )
    await mount(<ItemScreen brandId={brandId} itemId={itemId} />)
    expect(host.textContent).toContain('1a2b3c4d5e6f')
    await click('Approve')
    expect(approves()).toHaveLength(1)
    expect(approves()[0]?.body).toEqual({ hash: HASH1, hash_scheme: 'cv1' })
    expect(host.textContent).toContain('This item changed. Review the new version.')
    expect(host.textContent).toContain('9f8e7d6c5b4a')
    expect(host.textContent).toContain('Second text')
    expect(button('Approve').disabled).toBe(false)
  })

  it('reports a successful approve as done even when the reload after it fails', async () => {
    replies.push({ status: 200, body: itemV1 }, { status: 201, body: { approvalId: 'x' } }, failure)
    await mount(<ItemScreen brandId={brandId} itemId={itemId} />)
    await click('Approve')
    expect(approves()).toHaveLength(1)
    expect(host.textContent).toContain('Approved.')
    expect(host.textContent).toContain('reload the page')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    // What is on screen is out of date: no second decision on it.
    expect(button('Approve').disabled).toBe(true)
  })

  it('still says the item changed when the reload after a 409 fails', async () => {
    replies.push(
      { status: 200, body: itemV1 },
      { status: 409, body: { error: { code: 'stale_hash', message: 'changed' } } },
      failure,
    )
    await mount(<ItemScreen brandId={brandId} itemId={itemId} />)
    await click('Approve')
    expect(host.textContent).toContain('This item changed. Review the new version.')
    expect(button('Approve').disabled).toBe(true)
  })

  it('checks the edit form before sending, then reports the new version number even if the reload fails', async () => {
    replies.push(
      { status: 200, body: itemV1 },
      { status: 201, body: { versionId: v2, number: 2, hash: HASH2 } },
      failure,
    )
    await mount(<ItemScreen brandId={brandId} itemId={itemId} />)
    await click('Edit')
    type('edit-title', '   ')
    type('edit-keywords', '')
    await submit('Save as a new version')
    expect(host.textContent).toContain('A title is needed.')
    expect(host.textContent).toContain('Give at least one keyword.')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)

    type('edit-title', 'New title')
    type('edit-keywords', 'one\ntwo')
    await submit('Save as a new version')
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.url).toBe(`/api/v1/brands/${brandId}/content/${itemId}/versions`)
    expect(posts[0]?.body).toMatchObject({ title: 'New title', summary: 'First text' })
    expect(host.textContent).toContain('Saved as version 2')
    expect(host.textContent).toContain('reload the page')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    // The form is closed, so the same edit cannot be sent twice.
    expect(host.querySelector('#edit-title')).toBeNull()
  })
})

describe('the alerts screen, driven', () => {
  it('replaces the acknowledged alert with the one the core sends back', async () => {
    const open = {
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
    replies.push(
      { status: 200, body: { alerts: [open] } },
      { status: 200, body: { ...open, acknowledgedBy: 'u1', acknowledgedAt: '2026-10-20T11:00:00.000Z' } },
    )
    await mount(<BrandAlertsScreen brandId={brandId} />)
    expect(host.textContent).toContain('A job is in dead letters')
    await click('Acknowledge')
    expect(calls[1]?.url).toBe(`/api/v1/brands/${brandId}/alerts/${open.id}/ack`)
    expect(host.textContent).toContain('No open alerts')
    expect(host.textContent).toContain('Acknowledged and resolved')
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Acknowledge')).toBe(false)
  })
})
