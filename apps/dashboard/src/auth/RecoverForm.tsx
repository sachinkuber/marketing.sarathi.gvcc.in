'use client'
import Link from 'next/link'
import { useState } from 'react'
import { ErrorLine } from './AuthShell'

export function RecoverForm(props: {
  sent: boolean
  busy: boolean
  error: string | null
  onSubmit: (email: string) => void
}) {
  const [email, setEmail] = useState('')
  if (props.sent) {
    return (
      <>
        <h1>Check your email</h1>
        <p>If an account exists for that address, a recovery link is on its way.</p>
        <ul className="stack" style={{ listStyle: 'disc', paddingLeft: 20 }}>
          <li>The link works once and for 30 minutes.</li>
          <li>Using it ends all your sessions, on every device.</li>
          <li>You still need your second factor to sign in afterwards.</li>
        </ul>
        <Link className="btn block" href="/sign-in">
          Back to sign in
        </Link>
      </>
    )
  }
  return (
    <>
      <div>
        <h1>Recover your password</h1>
        <p className="muted">Enter your email. If an account exists, we send a recovery link.</p>
      </div>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          props.onSubmit(email.trim())
        }}
      >
        <div className="field">
          <label htmlFor="e">Email</label>
          <input
            className="input"
            id="e"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <ErrorLine error={props.error} />
        <button className="btn primary block" type="submit" disabled={props.busy}>
          Send recovery email
        </button>
        <Link className="small" href="/sign-in" style={{ textAlign: 'center' }}>
          Back to sign in
        </Link>
      </form>
    </>
  )
}
