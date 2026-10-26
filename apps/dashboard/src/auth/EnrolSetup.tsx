'use client'
import { useState } from 'react'
import { ErrorLine } from './AuthShell'

// No QR image (plan decision 12): the setup key to type into an authenticator app, and the otpauth link
// for apps that open it.
export function EnrolSetup(props: {
  totpUri: string
  secret: string
  busy: boolean
  error: string | null
  onVerify: (code: string) => void
}) {
  const [code, setCode] = useState('')
  return (
    <section className="stack" aria-labelledby="s1">
      <h2 className="stepno" id="s1">
        Add this account to your authenticator app
      </h2>
      <p className="small muted">
        In your authenticator app choose “enter a setup key” and type the key below, or open the link on the
        phone that has the app.
      </p>
      <div className="field">
        <span className="lab" id="setupkey-label">
          Setup key
        </span>
        <code className="setupkey" aria-labelledby="setupkey-label">
          {props.secret}
        </code>
      </div>
      <a className="small" href={props.totpUri}>
        Open in your authenticator app
      </a>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          props.onVerify(code.trim())
        }}
      >
        <div className="field">
          <label htmlFor="c">Enter the 6-digit code the app shows</label>
          <input
            className="input"
            id="c"
            required
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <ErrorLine error={props.error} />
        <button className="btn primary block" type="submit" disabled={props.busy}>
          Check code
        </button>
      </form>
    </section>
  )
}
