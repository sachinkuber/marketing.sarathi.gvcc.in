'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { ApiError, api } from '../api/client'
import { suggestionDecisionReply, onboardingReply, suggestionItem, suggestionsReply } from '../api/schemas'
import { LoadError } from '../frame/LoadError'
import { OwnerOnly } from './OwnerOnly'
import { KEY_LABEL, TOPICS, failureWords, isForbidden } from './onboarding-words'

type Item = z.infer<typeof suggestionItem>
type Source = Item['sources'][number]
type Gap = { key: string; why: string }

const label = (key: string) => KEY_LABEL[key] ?? key

// A suggested or decided value as text: profile values are text, anything else is shown as it is stored.
const textOf = (value: unknown): string =>
  typeof value === 'string' ? value : value === null || value === undefined ? '' : JSON.stringify(value)

const readOn = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  })

const sourceCount = (n: number) => (n === 0 ? 'no sources' : `${n} ${n === 1 ? 'source' : 'sources'}`)
const confidenceTag = (c: Item['confidence']) => (c === 'found' ? 'ok' : c === 'assumed' ? 'warn' : 'plain')

function SourceRow({ source }: { source: Source }) {
  return (
    <li className="onb-group">
      <div className="wrap-row">
        <div className="grow onb-wrap">{source.address ?? 'No address'}</div>
        {source.flagged ? <span className="tag warn">{`Flagged: ${source.flagged.reason}`}</span> : null}
      </div>
      <div className="muted small">{`Read ${readOn(source.readAt)}`}</div>
      <p className="dp-extract small">{source.extract}</p>
    </li>
  )
}

function ItemCard(props: {
  item: Item
  busy: boolean
  error: string | undefined
  onDecide: (
    item: Item,
    body: { decision: 'accepted' | 'rejected' } | { decision: 'edited'; value: string },
  ) => void
}) {
  const { item } = props
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [empty, setEmpty] = useState(false)
  const [showSources, setShowSources] = useState(false)
  const listId = `dp-src-${item.key}`
  const name = label(item.key)
  return (
    <li className="dp-item" data-key={item.key}>
      <div className="wrap-row">
        <h3 className="onb-h grow">{name}</h3>
        <span className={`tag ${confidenceTag(item.confidence)}`}>
          {`${item.confidence} · ${sourceCount(item.sources.length)}`}
        </span>
      </div>
      <p className="dp-value">{textOf(item.proposed)}</p>
      <p className="muted small onb-wrap">{item.why}</p>
      {item.decision ? (
        <p className="sub">
          <span className={`tag ${item.decision === 'rejected' ? 'danger' : 'ok'}`}>
            {item.decision === 'accepted' ? 'Accepted' : item.decision === 'edited' ? 'Edited' : 'Rejected'}
          </span>
          {item.decision === 'edited' ? ` Edited to: ${textOf(item.decidedValue)}` : null}
        </p>
      ) : editing ? (
        <div className="field">
          <label htmlFor={`edit-${item.key}`}>{`Your wording for ${name}`}</label>
          <textarea
            id={`edit-${item.key}`}
            className={`input dp-edit${empty ? ' err' : ''}`}
            value={draft}
            aria-invalid={empty ? true : undefined}
            onChange={(event) => {
              setDraft(event.target.value)
              setEmpty(false)
            }}
          />
          {empty ? <p className="errtext">Write the value, or reject the suggestion.</p> : null}
          <div className="dp-actions">
            <button
              className="btn primary onb-touch"
              type="button"
              disabled={props.busy}
              onClick={() => {
                if (draft.trim() === '') return setEmpty(true)
                props.onDecide(item, { decision: 'edited', value: draft })
              }}
            >
              Save edit
            </button>
            <button className="btn onb-touch" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="dp-actions">
          <button
            className="btn ok onb-touch"
            type="button"
            aria-label={`Accept ${name}`}
            disabled={props.busy}
            onClick={() => props.onDecide(item, { decision: 'accepted' })}
          >
            Accept
          </button>
          <button
            className="btn onb-touch"
            type="button"
            aria-label={`Edit ${name}`}
            disabled={props.busy}
            onClick={() => {
              setDraft(textOf(item.proposed))
              setEditing(true)
            }}
          >
            Edit
          </button>
          <button
            className="btn danger onb-touch"
            type="button"
            aria-label={`Reject ${name}`}
            disabled={props.busy}
            onClick={() => props.onDecide(item, { decision: 'rejected' })}
          >
            Reject
          </button>
        </div>
      )}
      {props.error ? (
        <p className="errtext" role="alert">
          {props.error}
        </p>
      ) : null}
      {item.sources.length > 0 ? (
        <>
          <button
            className="btn sm onb-touch"
            type="button"
            aria-expanded={showSources}
            aria-controls={listId}
            onClick={() => setShowSources((v) => !v)}
          >
            {showSources ? 'Hide sources' : 'Show sources'}
          </button>
          {showSources ? (
            <ul className="list onb-sources" id={listId}>
              {item.sources.map((s) => (
                <SourceRow key={s.id} source={s} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </li>
  )
}

export function DraftProfileScreen({ brandId }: { brandId: string }) {
  const [items, setItems] = useState<Item[] | null>(null)
  const [gaps, setGaps] = useState<Gap[]>([])
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({})
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const live = useRef(true)

  const load = useCallback(async () => {
    try {
      const [overview, list] = await Promise.all([
        api(onboardingReply, 'GET', `/brands/${brandId}/onboarding`),
        api(suggestionsReply, 'GET', `/brands/${brandId}/onboarding/suggestions?step=profile`),
      ])
      if (!live.current) return
      setGaps(overview.research?.gaps ?? [])
      setItems(list.suggestions)
      setLoadError(null)
    } catch (error) {
      if (!live.current) return
      if (isForbidden(error)) setForbidden(true)
      else setLoadError(error instanceof Error ? error : new Error('failed'))
    }
  }, [brandId])
  useEffect(() => {
    live.current = true
    void load()
    return () => {
      live.current = false
    }
  }, [load])

  if (forbidden) return <OwnerOnly />

  const decideUrl = (item: Item) => `/brands/${brandId}/onboarding/suggestions/${item.id}/decision`

  const decide = async (
    item: Item,
    body: { decision: 'accepted' | 'rejected' } | { decision: 'edited'; value: string },
  ) => {
    setBusy(true)
    setNotice(null)
    setBulkError(null)
    setItemErrors((now) => ({ ...now, [item.id]: '' }))
    try {
      await api(suggestionDecisionReply, 'POST', decideUrl(item), body)
      setNotice(
        `${label(item.key)}: ${body.decision === 'accepted' ? 'accepted' : body.decision === 'edited' ? 'saved with your wording' : 'rejected'}.`,
      )
    } catch (error) {
      setItemErrors((now) => ({
        ...now,
        [item.id]: failureWords(error, 'The decision was not saved. Try again.'),
      }))
    } finally {
      await load()
      if (live.current) setBusy(false)
    }
  }

  // The topics in their fixed order, each with its items in the profile's key order; an item already replaced
  // is not sent by the core, so nothing hidden needs filtering here.
  const byKey = new Map((items ?? []).map((item) => [item.key, item]))
  const topics = TOPICS.map((topic) => ({
    heading: topic.heading,
    items: topic.keys.map((k) => byKey.get(k)).filter((i): i is Item => i !== undefined),
    gaps: topic.keys
      .filter((k) => !byKey.has(k))
      .map((k) => gaps.find((g) => g.key === k))
      .filter((g): g is Gap => g !== undefined),
  })).filter((topic) => topic.items.length > 0 || topic.gaps.length > 0)
  const ordered = topics.flatMap((topic) => topic.items)
  const waiting = ordered.filter((i) => i.decision === null && i.confidence === 'found')

  // M8's per-item route, one call at a time in the order shown. The first refusal stops it and names the item;
  // items decided already are not sent again.
  const acceptAll = async () => {
    setBusy(true)
    setNotice(null)
    setBulkError(null)
    let done = 0
    try {
      for (const item of waiting) {
        try {
          await api(suggestionDecisionReply, 'POST', decideUrl(item), { decision: 'accepted' })
          done += 1
        } catch (error) {
          setBulkError(
            `${label(item.key)} could not be accepted. ${failureWords(error, 'The platform did not accept it.')} Press "Accept all found items" again to carry on: items already accepted are skipped.`,
          )
          return
        }
      }
      setNotice(`Accepted ${done} ${done === 1 ? 'item' : 'items'}.`)
    } finally {
      await load()
      if (live.current) setBusy(false)
    }
  }

  return (
    <main id="content" className="page">
      <div className="page-head">
        <div>
          <h1>Draft profile</h1>
          <p>What the research found about this brand. Accept it, put it in your own words, or reject it.</p>
        </div>
      </div>
      {loadError ? (
        <LoadError what="the draft profile" error={loadError as ApiError} onRetry={() => void load()} />
      ) : items === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="stack">
          {notice ? (
            <p className="callout ok" role="status">
              {notice}
            </p>
          ) : null}
          {bulkError ? (
            <p className="callout warn" role="alert">
              {bulkError}
            </p>
          ) : null}
          {waiting.length > 0 ? (
            <div>
              <button
                className="btn primary onb-touch"
                type="button"
                disabled={busy}
                onClick={() => void acceptAll()}
              >
                {`Accept all found items (${waiting.length})`}
              </button>
            </div>
          ) : null}
          {topics.length === 0 ? <p className="sub">Nothing is waiting for your decision.</p> : null}
          {topics.map((topic) => (
            <section key={topic.heading} className="panel" aria-label={topic.heading}>
              <h2 className="pad onb-h">{topic.heading}</h2>
              <ul className="list">
                {topic.items.map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    busy={busy}
                    error={itemErrors[item.id] || undefined}
                    onDecide={(it, body) => void decide(it, body)}
                  />
                ))}
                {topic.gaps.map((gap) => (
                  <li className="dp-item" key={gap.key} data-key={gap.key}>
                    <h3 className="onb-h">{label(gap.key)}</h3>
                    <p className="sub">Not found yet — will be asked in the questionnaire</p>
                    <p className="muted small onb-wrap">{gap.why}</p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  )
}
