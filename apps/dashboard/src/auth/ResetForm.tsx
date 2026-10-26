'use client'
import { useState } from 'react'
import { ErrorLine } from './AuthShell'

export function ResetForm(props: {
  busy: boolean
  error: string | null
  onSubmit: (password: string) => void
}) {
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const mismatch = p2.length > 0 && p1 !== p2
  return (
    <>
      <h1>Choose a new password</h1>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          if (!mismatch) props.onSubmit(p1)
        }}
      >
        <div className="field">
          <label htmlFor="p1">New password</label>
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
        <ErrorLine error={props.error} />
        <button className="btn primary block" type="submit" disabled={props.busy || mismatch}>
          Set password
        </button>
      </form>
    </>
  )
}
