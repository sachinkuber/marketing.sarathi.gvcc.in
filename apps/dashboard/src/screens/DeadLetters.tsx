'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { ApiError, api } from '../api/client'
import { deadJobsReply, noContent } from '../api/schemas'
import { useLoad } from '../api/use-load'
import { Empty } from '../frame/Empty'
import { canSeeDeadLetters } from '../frame/gating'
import { LoadError } from '../frame/LoadError'
import { useShell } from '../frame/shell-context'
import { afterWrite, readAfterWrite, RELOAD_HINT } from './after-write'
import { formatTime, words } from './format'

export type DeadJob = z.infer<typeof deadJobsReply>[number]

export function DeadLetterList(props: {
  brandId: string
  jobs: DeadJob[]
  disabled: boolean
  onRequeue: (job: DeadJob) => void
  onCancel: (job: DeadJob) => void
}) {
  if (props.jobs.length === 0) {
    return (
      <div className="panel">
        <Empty title="No jobs have used all their attempts">
          <p>
            Failed jobs are retried automatically. If one runs out of attempts it appears here, and you get an
            alert.
          </p>
        </Empty>
      </div>
    )
  }
  return (
    <div className="stack">
      {props.jobs.map((job) => (
        <div className="panel" key={job.jobId}>
          <div className="pb">
            <div className="row wrap">
              <b>{`${words(job.jobClass)} job`}</b>
              <span className="tag danger plain">
                {`Failed after ${job.attempts} ${job.attempts === 1 ? 'attempt' : 'attempts'}`}
              </span>
              <span className="sp muted small">
                {'Moved here '}
                <time dateTime={job.deadAt}>{formatTime(job.deadAt)}</time>
              </span>
            </div>
            <p className="small sub mt-2">
              Requeue tries again with the same input. Cancel gives up on the job and ends its run. Each
              attempt’s result is on the run.{' '}
              <Link href={`/b/${props.brandId}/agents/runs/${job.runId}`}>Open the run</Link>
            </p>
            <div className="row wrap mt-4">
              <button
                className="btn primary"
                type="button"
                disabled={props.disabled}
                onClick={() => props.onRequeue(job)}
              >
                Requeue
              </button>
              <button
                className="btn"
                type="button"
                disabled={props.disabled}
                onClick={() => props.onCancel(job)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// The list no longer matches the core: the job was requeued, cancelled or finished elsewhere.
const gone = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 409 || error.status === 404)

// `reloaded`: whether the list was read again after a `gone` refusal; only then is it said to be fresh.
function failure(error: unknown, reloaded: boolean): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'The platform could not be reached. Try again.'
    if (gone(error)) {
      return `This job is no longer in dead letters. ${reloaded ? 'The list has been reloaded.' : RELOAD_HINT}`
    }
    if (error.status === 403) return 'Only the platform owner can act on dead letters.'
  }
  return 'That did not work. Try again.'
}

const DONE = {
  requeue: 'Requeued. The job runs again.',
  cancel: 'Cancelled. The job was given up and its run has ended.',
}

export function DeadLettersScreen({ brandId }: { brandId: string }) {
  const { session } = useShell()
  const owner = canSeeDeadLetters(session)
  const read = () => api(deadJobsReply, 'GET', `/brands/${brandId}/jobs/dead`)
  const loaded = useLoad(() => (owner ? read() : Promise.resolve(null)), `${brandId}:${owner}`)
  const [jobs, setJobs] = useState<DeadJob[] | null>(null)
  const [busy, setBusy] = useState(false)
  // True once an action succeeded and the list could not be read again: nothing more is sent from it.
  const [outdated, setOutdated] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (loaded.state === 'ready' && loaded.data) setJobs(loaded.data)
  }, [loaded.state, loaded.data])

  const act = async (job: DeadJob, kind: 'requeue' | 'cancel') => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api(noContent, 'POST', `/brands/${brandId}/jobs/${job.jobId}/${kind}`, {})
    } catch (e) {
      let reloaded = false
      if (gone(e)) {
        const fresh = await readAfterWrite(read)
        if (fresh) setJobs(fresh)
        reloaded = fresh !== null
      }
      setError(failure(e, reloaded))
      setBusy(false)
      return
    }
    const fresh = await readAfterWrite(read)
    if (fresh) setJobs(fresh)
    setOutdated(fresh === null)
    setNotice(afterWrite(DONE[kind], fresh !== null))
    setBusy(false)
  }

  return (
    <main id="content" className="page">
      <div className="page-head">
        <div>
          <h1>Dead letters</h1>
          <p>Jobs that used all their attempts. Nothing here is retried until a person decides.</p>
        </div>
      </div>
      {!owner ? (
        <div className="callout warn">
          <b>Dead letters are for the platform owner only.</b> The platform owner is told when a job fails for
          good and decides whether it runs again.
        </div>
      ) : loaded.state === 'error' ? (
        <LoadError what="the dead letters" error={loaded.error} onRetry={loaded.retry} />
      ) : jobs ? (
        <>
          <p className="strong mb-4">
            {jobs.length === 1 ? '1 job needs a decision' : `${jobs.length} jobs need a decision`}
          </p>
          {notice ? (
            <p className="callout ok mb-4" role="status">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p className="errtext mb-4" role="alert">
              {error}
            </p>
          ) : null}
          <DeadLetterList
            brandId={brandId}
            jobs={jobs}
            disabled={busy || outdated}
            onRequeue={(job) => void act(job, 'requeue')}
            onCancel={(job) => void act(job, 'cancel')}
          />
        </>
      ) : (
        <p className="muted">Loading…</p>
      )}
    </main>
  )
}
