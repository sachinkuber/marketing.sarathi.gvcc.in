'use client'
import { useState } from 'react'
import { ErrorLine } from './AuthShell'

const ROLE_LABEL: Record<string, string> = {
  brand_admin: 'Brand admin',
  approver: 'Brand approver',
  sales_contact: 'Sales contact',
  viewer: 'Viewer',
}

export type InviteState =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'ready'; invite: { email: string; role: string; brandName: string } }

export function InviteForm(props: {
  state: InviteState
  busy: boolean
  error: string | null
  onSubmit: (name: string, password: string) => void
}) {
  const [name, setName] = useState('')
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const { state } = props
  if (state.kind === 'loading') return <p className="muted">Checking your invite…</p>
  if (state.kind === 'invalid') {
    return (
      <>
        <h1>This invite link no longer works</h1>
        <div className="callout warn" role="alert">
          The link was used already, or it is more than 72 hours old. Nothing else can be done from this page.
        </div>
        <p className="muted small">Ask the person who invited you to send a new link.</p>
      </>
    )
  }
  const mismatch = p2.length > 0 && p1 !== p2
  return (
    <>
      <div>
        <h1>Join {state.invite.brandName}</h1>
        <p className="muted">You have been invited to the marketing platform for {state.invite.brandName}.</p>
      </div>
      <dl className="kv kv-narrow">
        <dt>Brand</dt>
        <dd>{state.invite.brandName}</dd>
        <dt>Your role</dt>
        <dd>
          <span className="tag info plain">{ROLE_LABEL[state.invite.role] ?? state.invite.role}</span>
        </dd>
        <dt>Email</dt>
        <dd>{state.invite.email}</dd>
      </dl>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          if (!mismatch) props.onSubmit(name.trim(), p1)
        }}
      >
        <div className="field">
          <label htmlFor="n">Your name</label>
          <input
            className="input"
            id="n"
            required
            maxLength={100}
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="p1">Choose a password</label>
          <input
            className="input"
            id="p1"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={p1}
            onChange={(e) => setP1(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="p2">Type it again</label>
          <input
            className={mismatch ? 'input err' : 'input'}
            id="p2"
            type="password"
            required
            autoComplete="new-password"
            value={p2}
            onChange={(e) => setP2(e.target.value)}
          />
          {mismatch ? <span className="errtext">The two passwords differ.</span> : null}
        </div>
        <div className="small">
          <b>Password rules</b>
          <ul className="bullets">
            <li>At least 12 characters</li>
            <li>Not a password that appears in known leaks</li>
            <li>Not your email address or name</li>
          </ul>
        </div>
        <ErrorLine error={props.error} />
        <button className="btn primary block" type="submit" disabled={props.busy || mismatch}>
          Continue to enrolment
        </button>
      </form>
      <p className="muted small">
        Next you will set up a second factor. This link is for one use and lasts 72 hours.
      </p>
    </>
  )
}
