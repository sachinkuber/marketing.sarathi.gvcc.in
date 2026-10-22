'use client'
import { useState } from 'react'
import { ApiError } from '../api/client'

const CODE = /^\d{6}$/

// The words for the core's refusals of a step-up code; null for anything else, which the screen words itself.
export function codeFailure(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  if (error.status === 0) return 'The platform could not be reached. Try again.'
  if (error.code === 'second_factor_invalid')
    return 'The code is not right. Enter the current code from your authenticator app.'
  if (error.code === 'too_many_attempts') return 'Too many attempts. Wait a few minutes, then try again.'
  return null
}

// A change that asks for the person's own fresh 6-digit code first (app-flow 5.3 and 5.11): the code field is
// part of the form from the start, and the submit button stays disabled until six digits are in it. The code is
// held only here and goes in the request body; a new form (a new `key`) starts empty.
export function CodeForm(props: {
  id: string
  title: string
  explain: string
  submitLabel: string
  danger?: boolean
  busy: boolean
  error: string | null
  children?: React.ReactNode
  onSubmit: (code: string) => void
  onCancel?: () => void
}) {
  const [code, setCode] = useState('')
  const ready = CODE.test(code)
  return (
    <form
      className="panel pad stack"
      noValidate
      aria-labelledby={`${props.id}-title`}
      onSubmit={(event) => {
        event.preventDefault()
        if (ready && !props.busy) props.onSubmit(code)
      }}
    >
      <h3 id={`${props.id}-title`} className="subhead">
        {props.title}
      </h3>
      <p className="sub small">{props.explain}</p>
      {props.children}
      <div className="field">
        <label htmlFor={`${props.id}-code`}>Your 6-digit code</label>
        <input
          id={`${props.id}-code`}
          className="input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          aria-describedby={`${props.id}-code-hint`}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        <span className="hint" id={`${props.id}-code-hint`}>
          From your authenticator app. It is asked for every change like this, even if you signed in a minute
          ago.
        </span>
      </div>
      {props.error ? (
        <p className="errtext" role="alert">
          {props.error}
        </p>
      ) : null}
      <div className="row wrap">
        <button
          className={props.danger ? 'btn danger' : 'btn primary'}
          type="submit"
          disabled={props.busy || !ready}
        >
          {props.submitLabel}
        </button>
        {props.onCancel ? (
          <button className="btn" type="button" disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  )
}
