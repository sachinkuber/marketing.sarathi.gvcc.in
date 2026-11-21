'use client'
import { useState } from 'react'
import type { z } from 'zod'
import type { suggestionSource } from '../api/schemas'
import { SOURCE_KIND_WORD, dayOn } from './onboarding-words'

type Source = z.infer<typeof suggestionSource>

// A source as the owner reads it: what kind it is, where it was read (an address, a document's name, or the
// owner's own word), when, and what it said.
export function SourceRow({ source }: { source: Source }) {
  const where =
    source.kind === 'owner_statement'
      ? 'Stated by you'
      : source.kind === 'document'
        ? (source.documentName ?? source.address ?? 'A document')
        : (source.address ?? 'No address')
  return (
    <li className="onb-group">
      <div className="wrap-row">
        <div className="grow onb-wrap">{where}</div>
        {source.kind !== 'owner_statement' ? (
          <span className="tag plain">{SOURCE_KIND_WORD[source.kind] ?? source.kind}</span>
        ) : null}
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
