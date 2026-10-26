'use client'
import { useState } from 'react'
import { ErrorLine } from './AuthShell'

export function VerifyForm(props: {
  useBackup: boolean
  busy: boolean
  error: string | null
  onSubmit: (code: string) => void
  onToggle: () => void
}) {
  const [code, setCode] = useState('')
  return (
    <>
      <div>
        <h1>Enter your code</h1>
        <p className="muted">
          {props.useBackup
            ? 'Type one of your backup codes. Each works once.'
            : 'Open your authenticator app and type the 6-digit code for this platform.'}
        </p>
      </div>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          props.onSubmit(code.trim())
        }}
      >
        <div className="field">
          <label htmlFor="code">{props.useBackup ? 'Backup code' : '6-digit code'}</label>
          <input
            className="input"
            id="code"
            required
            autoComplete="one-time-code"
            {...(props.useBackup ? {} : { inputMode: 'numeric' as const, pattern: '[0-9]{6}', maxLength: 6 })}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <ErrorLine error={props.error} />
        <button className="btn primary block" type="submit" disabled={props.busy}>
          Verify
        </button>
        <button className="btn ghost" type="button" onClick={props.onToggle}>
          {props.useBackup ? 'Use the authenticator code instead' : 'Use a backup code instead'}
        </button>
      </form>
      <p className="muted small">A backup code works once. You are told by email when one is used.</p>
    </>
  )
}
