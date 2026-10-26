'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { ApiError, api } from '../api/client'
import { agentsReply, modelCallReviewReply, runStartedReply, runsReply } from '../api/schemas'
import { roleIn } from '../api/session'
import { useLoad } from '../api/use-load'
import { Empty } from '../frame/Empty'
import { LoadError } from '../frame/LoadError'
import { useShell } from '../frame/shell-context'
import { afterWrite } from './after-write'
import { formatMoney, formatTime, words } from './format'

export type Agent = z.infer<typeof agentsReply>['items'][number]
export type RunPage = z.infer<typeof runsReply>
export type ReviewCall = z.infer<typeof modelCallReviewReply>['items'][number]

// The longest brief the summary agent takes (briefSchema in @mkt/shared; the core checks it again).
export const BRIEF_MAX = 2000

const AGENT_STATE: Record<Agent['state'], { tone: string; label: string }> = {
  running: { tone: 'ok', label: 'Running' },
  blocked: { tone: 'danger', label: 'Blocked' },
  idle: { tone: 'plain', label: 'Idle' },
}

const REVIEW_REASON: Record<ReviewCall['reason'], string> = {
  unknown: 'Outcome unknown',
  possible_duplicate: 'Possible duplicate',
  no_cost: 'No cost recorded',
}

export function AgentTable({ agents }: { agents: Agent[] }) {
  if (agents.length === 0) {
    return (
      <Empty title="No agent is live">
        <p>An agent appears here once a version of it is live.</p>
      </Empty>
    )
  }
  return (
    <div className="panel scroll-x">
      <table className="t">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Live version</th>
            <th>Model</th>
            <th>State</th>
            <th className="num">Cost this month</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.agent}>
              <td>
                <b>{words(agent.agent)}</b>
              </td>
              <td>{`v${agent.version}`}</td>
              <td className="sub">{agent.model}</td>
              <td>
                <span className={`tag ${AGENT_STATE[agent.state].tone}`}>
                  {AGENT_STATE[agent.state].label}
                </span>
              </td>
              <td className="num nowrap">{formatMoney(agent.costThisMonth)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function RunList({ brandId, runs }: { brandId: string; runs: RunPage['items'] }) {
  if (runs.length === 0) {
    return (
      <Empty title="No runs yet">
        <p>Each time an agent starts work, its run appears here with what it cost.</p>
      </Empty>
    )
  }
  return (
    <div className="panel">
      <ul className="list">
        {runs.map((run) => (
          <li key={run.id} className="wrap-row">
            <div className="grow">
              <Link href={`/b/${brandId}/agents/runs/${run.id}`}>
                <b>{`${words(run.agent)} run`}</b>
              </Link>
              <div className="muted small">
                {`${words(run.state)} · started `}
                <time dateTime={run.startedAt}>{formatTime(run.startedAt)}</time>
              </div>
            </div>
            <span className="small nowrap">{formatMoney(run.cost)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ReviewList({ brandId, calls }: { brandId: string; calls: ReviewCall[] }) {
  if (calls.length === 0) {
    return (
      <Empty title="No model call needs review">
        <p>
          A call shows here when its outcome is unknown, it may have been sent twice, or it succeeded with no
          cost recorded.
        </p>
      </Empty>
    )
  }
  return (
    <div className="panel">
      <ul className="list">
        {calls.map((call) => (
          <li key={call.id} className="wrap-row">
            <span className="tag warn">{REVIEW_REASON[call.reason]}</span>
            <div className="grow">
              <b>{words(call.step)}</b>
              <div className="muted small">
                {`${call.model} · `}
                <time dateTime={call.startedAt}>{formatTime(call.startedAt)}</time>
              </div>
            </div>
            <Link className="btn sm" href={`/b/${brandId}/agents/runs/${call.runId}`}>
              Open the run
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function briefProblem(brief: string): string | null {
  if (brief.trim().length === 0) return 'Write the brief first.'
  if (brief.length > BRIEF_MAX) return `Keep the brief to ${BRIEF_MAX} characters.`
  return null
}

function startFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'The platform could not be reached. Try again.'
    if (error.code === 'invalid_request')
      return 'The brief is blank or has a character that cannot be used. Check it and try again.'
    if (error.code === 'agent_unavailable')
      return 'The summary agent has no live version, so it cannot start.'
    if (error.code === 'queue_busy') return 'Too much work is waiting. Try again shortly.'
    if (error.status === 403) return 'Only the platform owner can start an agent.'
  }
  return 'The agent could not be started. Try again.'
}

// The summary agent's start form (plan decision 5: starting an agent spends money, so it is the platform
// owner's). The brief is counted as it is typed; the core checks it again.
export function StartSummaryForm(props: {
  brief: string
  busy: boolean
  error: string | null
  onChange: (brief: string) => void
  onStart: () => void
}) {
  const over = props.brief.length > BRIEF_MAX
  const described = props.error ? 'brief-count brief-error' : 'brief-count'
  return (
    <form
      className="panel pad stack"
      noValidate
      aria-labelledby="h-start"
      onSubmit={(event) => {
        event.preventDefault()
        props.onStart()
      }}
    >
      <h2 id="h-start" className="subhead">
        Start the summary agent
      </h2>
      <div className="field">
        <label htmlFor="brief">Brief</label>
        <textarea
          id="brief"
          className={over || props.error ? 'input err' : 'input'}
          rows={6}
          value={props.brief}
          aria-invalid={over || props.error ? true : undefined}
          aria-describedby={described}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <span className={over ? 'hint errtext' : 'hint'} id="brief-count" aria-live="polite">
          {`${props.brief.length} / ${BRIEF_MAX}`}
        </span>
        {props.error ? (
          <p className="errtext" id="brief-error" role="alert">
            {props.error}
          </p>
        ) : null}
      </div>
      <div className="row">
        <button
          className="btn primary"
          type="submit"
          disabled={props.busy || over || props.brief.trim().length === 0}
        >
          Start
        </button>
      </div>
    </form>
  )
}

// The first page of runs, then older pages by the core's cursor. `refresh` reads the first page again and
// answers whether it could.
function useRuns(brandId: string, enabled: boolean) {
  const first = useLoad(
    () => (enabled ? api(runsReply, 'GET', `/brands/${brandId}/runs`) : Promise.resolve(null)),
    `${brandId}:${enabled}`,
  )
  const [page, setPage] = useState<RunPage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (first.state === 'ready') setPage(first.data)
  }, [first.state, first.data])
  const older = async () => {
    if (!page?.nextCursor) return
    setBusy(true)
    setError(null)
    try {
      const next = await api(
        runsReply,
        'GET',
        `/brands/${brandId}/runs?cursor=${encodeURIComponent(page.nextCursor)}`,
      )
      setPage({ items: [...page.items, ...next.items], nextCursor: next.nextCursor })
    } catch {
      setError('Older runs could not be loaded. Try again.')
    } finally {
      setBusy(false)
    }
  }
  const refresh = async (): Promise<boolean> => {
    try {
      setPage(await api(runsReply, 'GET', `/brands/${brandId}/runs`))
      return true
    } catch {
      return false
    }
  }
  return { first, page, busy, error, older, refresh }
}

export function AgentsScreen({ brandId }: { brandId: string }) {
  const { session } = useShell()
  const role = roleIn(session, brandId)
  const mayRead = role === 'owner' || role === 'brand_admin'
  const canStart = session.platformOwner
  const agents = useLoad(
    () => (mayRead ? api(agentsReply, 'GET', `/brands/${brandId}/agents`) : Promise.resolve(null)),
    `${brandId}:${mayRead}`,
  )
  const runs = useRuns(brandId, mayRead)
  const review = useLoad(
    () =>
      mayRead
        ? api(modelCallReviewReply, 'GET', `/brands/${brandId}/model-calls/review`)
        : Promise.resolve(null),
    `${brandId}:${mayRead}`,
  )

  const [brief, setBrief] = useState('')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [started, setStarted] = useState<{ runId: string; notice: string } | null>(null)

  const start = async () => {
    const problem = briefProblem(brief)
    if (problem) {
      setStartError(problem)
      return
    }
    setStarting(true)
    setStartError(null)
    setStarted(null)
    try {
      const run = await api(runStartedReply, 'POST', `/brands/${brandId}/agents/summary/runs`, { brief })
      // The run exists from here on: the form is emptied so it is not started twice, and a failed refresh of
      // the list below only adds the request to reload.
      setBrief('')
      const fresh = await runs.refresh()
      setStarted({ runId: run.runId, notice: afterWrite('Started.', fresh) })
    } catch (error) {
      setStartError(startFailure(error))
    } finally {
      setStarting(false)
    }
  }

  return (
    <main id="content" className="page">
      <div className="page-head">
        <div>
          <h1>Agents</h1>
          <p>Which version of each agent is live, what it is doing, and what it costs this month.</p>
        </div>
      </div>
      {!mayRead ? (
        <div className="callout warn" role="alert">
          Only the platform owner and the brand admin can see the agents.
        </div>
      ) : (
        <>
          {agents.state === 'error' ? (
            <LoadError what="the agents" error={agents.error} onRetry={agents.retry} />
          ) : agents.state === 'ready' && agents.data ? (
            <AgentTable agents={agents.data.items} />
          ) : (
            <p className="muted">Loading…</p>
          )}

          {canStart ? (
            <section className="sec" aria-label="Start an agent">
              <StartSummaryForm
                brief={brief}
                busy={starting}
                error={startError}
                onChange={(next) => {
                  setBrief(next)
                  setStartError(null)
                }}
                onStart={() => void start()}
              />
              {started ? (
                <p className="callout ok mt-4" role="status">
                  {`${started.notice} `}
                  <Link href={`/b/${brandId}/agents/runs/${started.runId}`}>Open the run</Link>
                </p>
              ) : null}
            </section>
          ) : null}

          <section className="sec" aria-labelledby="h-runs">
            <div className="sec-head">
              <h2 id="h-runs">Runs</h2>
              <p>Newest first. Open a run to see its jobs, model calls and cost.</p>
            </div>
            {runs.first.state === 'error' ? (
              <LoadError what="the runs" error={runs.first.error} onRetry={runs.first.retry} />
            ) : runs.page ? (
              <>
                <RunList brandId={brandId} runs={runs.page.items} />
                {runs.error ? (
                  <p className="errtext mt-2" role="alert">
                    {runs.error}
                  </p>
                ) : null}
                {runs.page.nextCursor ? (
                  <div className="mt-4">
                    <button
                      className="btn sm"
                      type="button"
                      disabled={runs.busy}
                      onClick={() => void runs.older()}
                    >
                      Load older runs
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="muted">Loading…</p>
            )}
          </section>

          <section className="sec" aria-labelledby="h-review">
            <div className="sec-head">
              <h2 id="h-review">Model calls to review</h2>
              <p>Possible duplicates, unknown outcomes and calls with no cost recorded</p>
            </div>
            {review.state === 'error' ? (
              <LoadError what="the model calls to review" error={review.error} onRetry={review.retry} />
            ) : review.state === 'ready' && review.data ? (
              <>
                <ReviewList brandId={brandId} calls={review.data.items} />
                {review.data.truncated ? (
                  <p className="muted small mt-2">More calls need review than this list shows.</p>
                ) : null}
              </>
            ) : (
              <p className="muted">Loading…</p>
            )}
          </section>
        </>
      )}
    </main>
  )
}
