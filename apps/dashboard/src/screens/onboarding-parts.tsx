'use client'
import { useRef, useState } from 'react'
import type { z } from 'zod'
import { ApiError, api } from '../api/client'
import { caseAddedReply, type suggestionSource } from '../api/schemas'
import { SOURCE_KIND_WORD, dayOn, failureWords } from './onboarding-words'
import { registrableDomain } from './registrable-domain'

type Source = z.infer<typeof suggestionSource>

export const CASE_ADDED = 'Added as a candidate case.'

// "Add as a case" on a suggestion the owner edited or dropped: the correction becomes a candidate evaluation case.
export function AddAsCase({ base, suggestionId }: { base: string; suggestionId: string }) {
  const sending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function add() {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setError(null)
    try {
      await api(caseAddedReply, 'POST', `${base}/suggestions/${suggestionId}/case`, {})
      setDone(CASE_ADDED)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'already_added') setDone('Already added.')
      else setError(failureWords(e, 'The case was not added. Try again.'))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  if (done)
    return (
      <p className="sub" role="status">
        {done}
      </p>
    )
  return (
    <div>
      {error ? (
        <p className="errtext" role="alert">
          {error}
        </p>
      ) : null}
      <button className="btn sm onb-touch" type="button" disabled={busy} onClick={() => void add()}>
        Add as a case
      </button>
    </div>
  )
}

// A source as the owner reads it: what kind it is, where it was read (an address, a document's name, or the
// owner's own word), when, and what it said.
//
// The model picks a source's kind, so a page labelled site is the brand's own only when its registrable domain is
// the intake website's (the core's rule, ruling R41); otherwise it is shown as "Web page". `website` is the intake
// website: a string, null when the brand has none, and undefined while it is not known (the kind is then shown as
// it came).
export function SourceRow({ source, website }: { source: Source; website?: string | null }) {
  const offDomain =
    source.kind === 'site' &&
    website !== undefined &&
    (registrableDomain(website) === null || registrableDomain(source.address) !== registrableDomain(website))
  const kindWord = offDomain ? 'Web page' : (SOURCE_KIND_WORD[source.kind] ?? source.kind)
  const where =
    source.kind === 'owner_statement'
      ? "Owner's statement"
      : source.kind === 'document'
        ? (source.documentName ?? source.address ?? 'A document')
        : (source.address ?? 'No address')
  return (
    <li className="onb-group">
      <div className="wrap-row">
        <div className="grow onb-wrap">{where}</div>
        {source.kind !== 'owner_statement' ? <span className="tag plain">{kindWord}</span> : null}
        {source.flagged ? <span className="tag warn">{`Flagged: ${source.flagged.reason}`}</span> : null}
      </div>
      <div className="muted small">{`${source.kind === 'owner_statement' ? 'Stated' : 'Read'} ${dayOn(source.readAt)}`}</div>
      <p className="dp-extract small">{source.extract}</p>
    </li>
  )
}

// Asks once, then does it.
export function Ask(props: {
  label: string
  question: string
  yes: string
  danger?: boolean
  busy: boolean
  onYes: () => void
}) {
  const [asking, setAsking] = useState(false)
  if (!asking)
    return (
      <button
        className={`btn onb-touch${props.danger ? ' danger' : ''}`}
        type="button"
        disabled={props.busy}
        onClick={() => setAsking(true)}
      >
        {props.label}
      </button>
    )
  return (
    <div className="stack">
      <p className="onb-wrap">{props.question}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button
          className="btn danger onb-touch"
          type="button"
          disabled={props.busy}
          onClick={() => {
            props.onYes()
            setAsking(false)
          }}
        >
          {props.yes}
        </button>
        <button className="btn onb-touch" type="button" onClick={() => setAsking(false)}>
          Keep it
        </button>
      </div>
    </div>
  )
}
