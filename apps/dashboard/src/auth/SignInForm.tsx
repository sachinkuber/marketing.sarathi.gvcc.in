'use client'
import Link from 'next/link'
import { useState } from 'react'
import { ErrorLine } from './AuthShell'

export function SignInForm(props: {
  busy: boolean
  error: string | null
  onSubmit: (email: string, password: string) => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  return (
    <>
      <div>
        <h1>Sign in</h1>
        <p className="muted">Use the email address your invite was sent to.</p>
      </div>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          props.onSubmit(email.trim(), password)
        }}
      >
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            className="input"
            id="email"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="pw">Password</label>
          <input
            className="input"
            id="pw"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <ErrorLine error={props.error} />
        <button className="btn primary block" type="submit" disabled={props.busy}>
          Sign in
        </button>
        <Link className="small center" href="/recover">
          Forgot password
        </Link>
      </form>
      <p className="muted small">
        Viewers sign in with email and password only. Everyone else enters a 6-digit code next.
      </p>
    </>
  )
}
