'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { ApiError, api } from '../api/client'
import { onboardingReply, type researchSource } from '../api/schemas'
import { LoadError } from '../frame/LoadError'
import {
  GROUP_NAME,
  OWNER_ONLY,
  RESULT_WORD,
  STATE_WORD,
  costWords,
  groupLine,
  isOpen,
  type GroupState,
} from './onboarding-words'

type Onboarding = z.infer<typeof onboardingReply>
type Source = z.infer<typeof researchSource>

// How often the screen asks again while any group, or the merge, is still open.
export const POLL_MS = 5000

const stateTag = (state: GroupState) =>
  state === 'done' ? 'ok' : state === 'failed' ? 'danger' : state === 'running' ? 'info' : 'warn'

// A document source shows the file's name, and the page range of the part when its address carries one
// ("brochure.pdf, pages 1–100"); a web source shows its address.
function sourceName(s: Source): string {
  if (s.documentName !== null) {
    const range = s.address?.match(/, (pages? \d+(?:[–-]\d+)?)$/)
    return range ? `${s.documentName}, ${range[1]}` : s.documentName
  }
  return s.address ?? 'No address'
}

function SourceRow({ source }: { source: Source }) {
  return (
    <li className="wrap-row">
      <div className="grow onb-wrap">{sourceName(source)}</div>
      <span className="tag plain">{RESULT_WORD[source.result] ?? source.result}</span>
      {source.flagged ? <span className="tag warn">Flagged</span> : null}
    </li>
  )
}

type Group = NonNullable<Onboarding['research']>['groups'][number]

function GroupRow({ group }: { group: Group }) {
  const [open, setOpen] = useState(false)
  const listId = `src-${group.group}`
  return (
    <li className="onb-group">
      <div className="wrap-row">
        <div className="grow">
          <b>{GROUP_NAME[group.group] ?? group.group}</b>
          <div className="muted small">{groupLine(group)}</div>
        </div>
        <span className={`tag ${stateTag(group.state)}`}>{STATE_WORD[group.state]}</span>
      </div>
      {group.sources.length > 0 ? (
        <>
          <button
            className="btn sm onb-touch"
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide sources' : 'Show sources'}
          </button>
          {open ? (
            <ul className="list onb-sources" id={listId}>
              {group.sources.map((source) => (
                <SourceRow key={source.id} source={source} />
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="muted small">
          {group.state === 'done' || group.state === 'failed' ? 'Nothing was read.' : 'Nothing read yet.'}
        </p>
      )}
    </li>
  )
}

export function ResearchProgressScreen({ brandId }: { brandId: string }) {
  const [data, setData] = useState<Onboarding | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [stale, setStale] = useState(false)
  // A refusal that will not change on its own (signed out, not the owner, no such brand): polling stops.
  const [stopped, setStopped] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  // Reads now, then again every POLL_MS while anything is open. The timer is cleared when the screen goes, so
  // the owner can leave and come back; a read that fails keeps what is shown and tries again.
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      let again = true
      try {
        const fresh = await api(onboardingReply, 'GET', `/brands/${brandId}/onboarding`)
        if (!live) return
        setData(fresh)
        setError(null)
        setStale(false)
        again = isOpen(fresh.research)
      } catch (e) {
        if (!live) return
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          setStopped(
            e.status === 401
              ? 'You are signed out. Sign in again to see the progress.'
              : e.status === 403
                ? OWNER_ONLY
                : 'This brand was not found. Open All brands and choose it again.',
          )
          return
        }
        setStale(true)
        setError(e instanceof Error ? e : new Error('failed'))
      }
      if (live && again) timer = setTimeout(() => void read(), POLL_MS)
    }
    void read()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [brandId, attempt])

  const research = data?.research ?? null
  const done = research?.merge === 'done' || (data?.openSuggestions ?? 0) > 0

  return (
    <main id="content" className="page">
      <div className="page-head">
        <div>
          <h1>Research progress</h1>
          <p>What each part of the research is reading, and what it costs.</p>
        </div>
      </div>
      {stopped ? (
        <div className="callout warn" role="alert">
          {stopped}
        </div>
      ) : !data ? (
        error ? (
          <LoadError
            what="the research progress"
            error={error as ApiError}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : (
          <p className="muted">Loading…</p>
        )
      ) : !research ? (
        <div className="panel pad stack">
          <p className="sub">Research has not started. Save the intake, then start it.</p>
          <div>
            <Link className="btn primary onb-touch" href={`/b/${brandId}/onboarding/intake`}>
              Go to the intake
            </Link>
          </div>
        </div>
      ) : (
        <>
          {stale ? (
            <p className="callout warn" role="status">
              The latest progress could not be read. This screen keeps trying.
            </p>
          ) : null}
          <div className="panel">
            <ul className="list">
              {research.groups.map((group) => (
                <GroupRow key={group.group} group={group} />
              ))}
              <li className="onb-group">
                <div className="wrap-row">
                  <b className="grow">Putting it together</b>
                  <span className={`tag ${stateTag(research.merge)}`}>{STATE_WORD[research.merge]}</span>
                </div>
              </li>
            </ul>
          </div>
          <p className="sub mt-4">{`Cost so far: ${costWords(data.cost)}`}</p>
          {done ? (
            <div className="mt-4">
              <Link className="btn primary onb-touch" href={`/b/${brandId}/onboarding/profile`}>
                See the draft profile
              </Link>
            </div>
          ) : null}
        </>
      )}
    </main>
  )
}
