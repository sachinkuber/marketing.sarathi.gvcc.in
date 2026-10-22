import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import { setCsrfToken } from '../src/api/client'
import type { Session } from '../src/api/session'
import { ShellContext } from '../src/frame/shell-context'

// Renders a real screen in a DOM (the test file must run under happy-dom) and drives it with clicks and typing;
// the platform is a queue of replies, and every request is recorded.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export const brandId = '6c77c301-7cb4-4c81-8551-1a0fbe6dce41'
export const T = '2026-10-20T10:00:00.000Z'
export const failure = { status: 500, body: { error: { code: 'internal_error', message: 'x' } } }

export const ME = 'c0000000-0000-4000-8000-000000000001'

export function sessionAs(role: 'owner' | 'brand_admin' | 'approver', userId = ME): Session {
  return {
    user: { id: userId, email: 'me@example.test', name: 'Me' },
    twoFactorEnabled: true,
    needsSecondFactor: false,
    enrolmentRequired: false,
    platformOwner: role === 'owner',
    memberships: role === 'owner' ? [] : [{ brandId, role }],
    csrfToken: 'tok-1',
  }
}

export interface Call {
  url: string
  method: string
  body: unknown
}

export class Dom {
  calls: Call[] = []
  replies: Array<{ status: number; body?: unknown }> = []
  host!: HTMLElement
  private root: Root | null = null

  start(): void {
    this.calls = []
    this.replies = []
    this.root = null
    setCsrfToken('tok-1')
    this.host = document.createElement('div')
    document.body.append(this.host)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { method: string; body?: string }) => {
        this.calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
        const next = this.replies.shift() ?? failure
        // A 204 has no body at all.
        return new Response(next.status === 204 ? null : JSON.stringify(next.body), { status: next.status })
      }),
    )
  }

  stop(): void {
    act(() => this.root?.unmount())
    this.host.remove()
    vi.unstubAllGlobals()
    setCsrfToken(null)
  }

  async settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  async mount(ui: React.ReactNode, session: Session): Promise<void> {
    this.root = createRoot(this.host)
    act(() =>
      this.root!.render(
        <ShellContext value={{ session, overdue: null, reload: async () => {} }}>{ui}</ShellContext>,
      ),
    )
    await this.settle()
  }

  text(): string {
    return this.host.textContent ?? ''
  }

  buttons(label: string): HTMLButtonElement[] {
    return [...this.host.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label)
  }

  button(label: string, index = 0): HTMLButtonElement {
    const found = this.buttons(label)[index]
    if (!found) throw new Error(`no button "${label}" in: ${this.text()}`)
    return found
  }

  async click(label: string, index = 0): Promise<void> {
    const target = this.button(label, index)
    act(() => target.click())
    await this.settle()
  }

  field(id: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null {
    return this.host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`#${id}`)
  }

  type(id: string, value: string): void {
    const field = this.field(id)
    if (!field) throw new Error(`no field #${id} in: ${this.text()}`)
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set
    act(() => {
      setter?.call(field, value)
      field.dispatchEvent(
        new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
      )
    })
  }

  async submit(label: string, index = 0): Promise<void> {
    const form = this.button(label, index).closest('form')
    if (!form) throw new Error(`no form around "${label}"`)
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await this.settle()
  }

  writes(): Call[] {
    return this.calls.filter((c) => c.method !== 'GET')
  }
}
