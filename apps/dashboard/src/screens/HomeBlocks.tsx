import Link from 'next/link'
import type { z } from 'zod'
import type { homeReply } from '../api/schemas'
import { formatMicros, formatTime, waitedFor, words } from './format'

export type Home = z.infer<typeof homeReply>

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function hasProblems(problems: Home['problems']): boolean {
  return problems.deadJobs + problems.openAlerts + problems.reviewCalls > 0
}

// Home in the order the owner asked for (app-flow 4.1): results, progress, waiting for you, problems. A block
// the role may not see comes back null from the core and is left out; problems show only when there are any.
// In phase 1 the results are the agents' runs and cost, and the progress is where the jobs stand.
export function HomeBlocks({ brandId, home, now }: { brandId: string; home: Home; now: number }) {
  const { results, progress, waiting, problems } = home
  return (
    <>
      {results ? (
        <section className="sec" aria-labelledby="h-results">
          <div className="sec-head">
            <h2 id="h-results">Results</h2>
            <p>This month: the agents’ runs and what they cost</p>
          </div>
          <ul className="ledger figures">
            <li>
              <div className="what">
                <b>Agent runs</b>
                <span>Started this month</span>
              </div>
              <div className="val">{results.runsThisMonth}</div>
            </li>
            <li>
              <div className="what">
                <b>Cost</b>
                <span>Model calls this month, both currencies</span>
              </div>
              <div className="val">
                {formatMicros(results.costThisMonth.usdMicros, 'USD')}{' '}
                <small>{formatMicros(results.costThisMonth.inrMicros, 'INR')}</small>
              </div>
            </li>
          </ul>
          {results.lastRuns.length > 0 ? (
            <div className="panel mt-4">
              <div className="ph">
                <h3>Latest runs</h3>
              </div>
              <ul className="list">
                {results.lastRuns.map((run) => (
                  <li key={run.id}>
                    <div>
                      <b>{words(run.agent)}</b>
                      <div className="muted small">
                        {words(run.state)} · started {formatTime(run.startedAt)}
                      </div>
                    </div>
                    <span className="sp small">{formatMicros(run.cost.usdMicros, 'USD')}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {progress ? (
        <section className="sec" aria-labelledby="h-progress">
          <div className="sec-head">
            <h2 id="h-progress">Progress</h2>
            <p>Where the agents’ jobs stand</p>
          </div>
          <dl className="kv">
            <dt>Waiting to run</dt>
            <dd>{progress.jobs.waiting}</dd>
            <dt>Running</dt>
            <dd>{progress.jobs.running}</dd>
            <dt>Held by the kill switch</dt>
            <dd>{progress.jobs.held}</dd>
            <dt>Failed for good</dt>
            <dd>{progress.jobs.dead}</dd>
            <dt>Finished</dt>
            <dd>{progress.jobs.finished}</dd>
          </dl>
        </section>
      ) : null}

      {waiting ? (
        <section className="sec" aria-labelledby="h-waiting">
          <div className="sec-head">
            <h2 id="h-waiting">Waiting for you</h2>
            <Link className="more" href={`/b/${brandId}/inbox`}>
              Open inbox
            </Link>
          </div>
          <div className="panel pad">
            {waiting.awaitingApproval === 0 ? (
              <p className="sub">Nothing is waiting for your approval.</p>
            ) : (
              <p>
                <b>{plural(waiting.awaitingApproval, 'item', 'items')}</b> awaiting approval.
                {waiting.oldestWaitingSince
                  ? ` The oldest has waited ${waitedFor(waiting.oldestWaitingSince, now)}.`
                  : null}
              </p>
            )}
          </div>
        </section>
      ) : null}

      {hasProblems(problems) ? (
        <section className="sec" aria-labelledby="h-problems">
          <div className="sec-head">
            <h2 id="h-problems">Problems</h2>
            <Link className="more" href={`/b/${brandId}/alerts`}>
              All alerts
            </Link>
          </div>
          <div className="panel">
            <ul className="list">
              {problems.deadJobs > 0 ? (
                <li>
                  <span className="dot danger" />
                  <b>{plural(problems.deadJobs, 'job is', 'jobs are')} in dead letters</b>
                  <Link className="sp btn sm" href={`/b/${brandId}/agents/dead-letters`}>
                    Open
                  </Link>
                </li>
              ) : null}
              {problems.openAlerts > 0 ? (
                <li>
                  <span className="dot warn" />
                  <b>{plural(problems.openAlerts, 'open alert', 'open alerts')}</b>
                  <Link className="sp btn sm" href={`/b/${brandId}/alerts`}>
                    Open
                  </Link>
                </li>
              ) : null}
              {problems.reviewCalls > 0 ? (
                <li>
                  <span className="dot info" />
                  <b>{plural(problems.reviewCalls, 'model call needs', 'model calls need')} review</b>
                  <Link className="sp btn sm" href={`/b/${brandId}/agents`}>
                    Open
                  </Link>
                </li>
              ) : null}
            </ul>
          </div>
        </section>
      ) : null}
    </>
  )
}
