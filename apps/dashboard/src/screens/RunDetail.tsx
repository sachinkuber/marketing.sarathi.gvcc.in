'use client'
import Link from 'next/link'
import type { z } from 'zod'
import { api } from '../api/client'
import { runDetailReply } from '../api/schemas'
import { useLoad } from '../api/use-load'
import { LoadError } from '../frame/LoadError'
import { actionLabel } from './audit-words'
import { formatMoney, formatTime, words } from './format'

export type RunDetail = z.infer<typeof runDetailReply>
type Job = RunDetail['jobs'][number]
type Attempt = Job['attempts'][number]
type ModelCall = RunDetail['modelCalls'][number]

const STARTED_BY: Record<RunDetail['run']['startedByKind'], string> = {
  user: 'A person',
  agent: 'An agent',
  system: 'The platform',
  n8n: 'The workflow runner (n8n)',
}

const JOB_STATE: Record<Job['state'], { tone: string; label: string }> = {
  waiting: { tone: 'plain', label: 'Waiting' },
  running: { tone: 'info', label: 'Running' },
  held: { tone: 'warn', label: 'Held by the kill switch' },
  dead: { tone: 'danger', label: 'In dead letters' },
  finished: { tone: 'ok', label: 'Finished' },
}

const ATTEMPT_STATE: Record<Attempt['state'], { tone: string; label: string }> = {
  active: { tone: 'info', label: 'Running' },
  succeeded: { tone: 'ok', label: 'Succeeded' },
  failed: { tone: 'danger', label: 'Failed' },
  superseded: { tone: 'warn', label: 'Taken back' },
}

const CALL_STATUS: Record<ModelCall['status'], { tone: string; label: string }> = {
  started: { tone: 'info', label: 'In progress' },
  succeeded: { tone: 'ok', label: 'Succeeded' },
  failed: { tone: 'danger', label: 'Failed' },
  unknown: { tone: 'warn', label: 'Outcome unknown' },
}

const tokens = (n: number | null): string => (n === null ? '–' : n.toLocaleString('en-GB'))

function JobRows({ job }: { job: Job }) {
  const state = JOB_STATE[job.state]
  const head = (
    <td rowSpan={Math.max(1, job.attempts.length)}>
      <b>{`${words(job.jobClass)} job`}</b>
      <div className="tiny muted">{job.expectedResultType}</div>
      <span className={`tag ${state.tone} plain`}>{state.label}</span>
    </td>
  )
  if (job.attempts.length === 0) {
    return (
      <tr>
        {head}
        <td colSpan={3} className="muted">
          Not started yet
        </td>
      </tr>
    )
  }
  return (
    <>
      {job.attempts.map((attempt, index) => (
        <tr key={attempt.number}>
          {index === 0 ? head : null}
          <td className="nowrap">{`Attempt ${attempt.number}`}</td>
          <td>
            <span className={`tag ${ATTEMPT_STATE[attempt.state].tone} plain`}>
              {ATTEMPT_STATE[attempt.state].label}
            </span>
          </td>
          <td className="sub small">
            {`Worker ${attempt.workerId}, started `}
            <time dateTime={attempt.startedAt}>{formatTime(attempt.startedAt)}</time>
            {attempt.endedAt ? (
              <>
                {', ended '}
                <time dateTime={attempt.endedAt}>{formatTime(attempt.endedAt)}</time>
              </>
            ) : null}
          </td>
        </tr>
      ))}
    </>
  )
}

export function RunView({ brandId, detail }: { brandId: string; detail: RunDetail }) {
  const { run } = detail
  return (
    <>
      <div className="crumbs">
        <Link href={`/b/${brandId}/agents`}>Agents</Link>
        {` / ${words(run.agent)} / Run`}
      </div>
      <div className="page-head">
        <div>
          <h1>{`Run of the ${words(run.agent)} agent`}</h1>
          <p>Its jobs and their attempts, the model calls it made and what they cost.</p>
        </div>
        <div className="actions">
          <span className="tag info">{words(run.state)}</span>
        </div>
      </div>
      <div className="panel pad">
        <dl className="kv">
          <dt>Run</dt>
          <dd className="small">{run.id}</dd>
          <dt>Started by</dt>
          <dd>{STARTED_BY[run.startedByKind]}</dd>
          <dt>Started</dt>
          <dd>
            <time dateTime={run.startedAt}>{formatTime(run.startedAt)}</time>
          </dd>
          <dt>Finished</dt>
          <dd>
            {run.finishedAt ? <time dateTime={run.finishedAt}>{formatTime(run.finishedAt)}</time> : 'Not yet'}
          </dd>
          <dt>Cost</dt>
          <dd className="nowrap">{formatMoney(detail.cost)}</dd>
        </dl>
      </div>

      <section className="sec" aria-labelledby="h-jobs">
        <div className="sec-head">
          <h2 id="h-jobs">Jobs and attempts</h2>
          <p>An attempt that stops reporting is taken back and tried again</p>
        </div>
        {detail.jobs.length === 0 ? (
          <p className="muted">This run has no jobs yet.</p>
        ) : (
          <div className="panel scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Attempt</th>
                  <th>Result</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {detail.jobs.map((job) => (
                  <JobRows key={job.id} job={job} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="sec" aria-labelledby="h-calls">
        <div className="sec-head">
          <h2 id="h-calls">Model calls</h2>
          <p>Every request to a model, with its cost in both currencies</p>
        </div>
        {detail.modelCalls.length === 0 ? (
          <p className="muted">No model calls were made in this run.</p>
        ) : (
          <div className="panel scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Status</th>
                  <th className="num">Tokens in</th>
                  <th className="num">Tokens out</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {detail.modelCalls.map((call) => (
                  <tr key={call.id}>
                    <td>
                      <b>{words(call.step)}</b>
                      <div className="tiny muted">{call.model}</div>
                    </td>
                    <td>
                      <div className="row wrap">
                        <span className={`tag ${CALL_STATUS[call.status].tone} plain`}>
                          {CALL_STATUS[call.status].label}
                        </span>
                        {call.possibleDuplicate ? <span className="tag warn">Possible duplicate</span> : null}
                      </div>
                    </td>
                    <td className="num">{tokens(call.inputTokens)}</td>
                    <td className="num">{tokens(call.outputTokens)}</td>
                    <td className="num nowrap">
                      {call.cost ? formatMoney(call.cost) : <span className="muted">No cost recorded</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {detail.modelCalls.some((call) => call.possibleDuplicate || call.status === 'unknown') ? (
          <p className="small sub mt-2">
            <b>Why a call is flagged.</b> A possible duplicate was asked again with the same request after an
            earlier attempt recorded no result, so it may have been billed twice. An unknown outcome means the
            call never reported back.
          </p>
        ) : null}
      </section>

      <section className="sec" aria-labelledby="h-audit">
        <div className="sec-head">
          <h2 id="h-audit">Audit entries for this run</h2>
        </div>
        {detail.audit.length === 0 ? (
          <p className="muted">No audit entries are about this run.</p>
        ) : (
          <ol className="timeline">
            {detail.audit.map((entry) => (
              <li key={entry.seq} className="done">
                <b>
                  <time dateTime={entry.at}>{formatTime(entry.at)}</time>
                </b>{' '}
                {actionLabel(entry.action)}
                {entry.outcome === 'failure' ? <span className="tag danger plain">Failed</span> : null}
              </li>
            ))}
          </ol>
        )}
        {detail.auditTruncated ? (
          <p className="muted small mt-2">
            Older entries about this run may exist: the search stopped at its limit.{' '}
            <Link href={`/b/${brandId}/settings/audit`}>Search the audit log</Link>
          </p>
        ) : null}
      </section>
    </>
  )
}

export function RunScreen({ brandId, runId }: { brandId: string; runId: string }) {
  const loaded = useLoad(
    () => api(runDetailReply, 'GET', `/brands/${brandId}/runs/${runId}`),
    `${brandId}:${runId}`,
  )
  return (
    <main id="content" className="page">
      {loaded.state === 'loading' ? <p className="muted">Loading…</p> : null}
      {loaded.state === 'error' ? (
        <LoadError what="this run" error={loaded.error} onRetry={loaded.retry} />
      ) : null}
      {loaded.state === 'ready' ? <RunView brandId={brandId} detail={loaded.data} /> : null}
    </main>
  )
}
