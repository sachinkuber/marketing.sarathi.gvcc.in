'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { ApiError, api, sendOnLeave, warmCsrfToken } from '../api/client'
import {
  agentQuestionsReply,
  answerSavedReply,
  questionnaireFinishedReply,
  questionnaireQuestion,
  questionnaireReply,
  questionnaireStartedReply,
} from '../api/schemas'
import { LoadError } from '../frame/LoadError'
import { AgentQuestion } from './AgentQuestion'
import { OwnerOnly } from './OwnerOnly'
import { OWNER_ONLY, failureWords, isForbidden } from './onboarding-words'

type Reply = z.infer<typeof questionnaireReply>
type Question = z.infer<typeof questionnaireQuestion>
type Asked = z.infer<typeof agentQuestionsReply>['questions'][number]
type Status = { kind: 'pending' } | { kind: 'saved' } | { kind: 'error'; text: string }

// How often the screen asks again while the questionnaire job runs or waits, and how long an answer waits
// after the last keystroke before it is saved (so one question saves at most once in that time).
export const POLL_MS = 5000
export const SAVE_MS = 800
const MAX_ANSWER = 2000

const isOpenJob = (state: string | undefined) =>
  state === 'waiting' || state === 'running' || state === 'waiting_for_answer'

const JOB_WORDS: Record<string, string> = {
  waiting: 'The questionnaire is queued. It starts soon.',
  running:
    'The questionnaire is being written. This takes a few minutes. You can leave this page and come back.',
  waiting_for_answer:
    'The questionnaire agent needs an answer from you before it can go on. Answer it below.',
}

// Ruling R40: a question starts from the owner's saved answer, else empty. The suggestion is shown beside it and
// becomes an answer only when the owner chooses it or uses it, so nothing is saved that the owner did not give.
const startValue = (q: Question) => q.answer ?? ''
const rowStyle = { display: 'flex', gap: 8, alignItems: 'center' } as const
const setStyle = { border: 0, padding: 0, margin: 0, minWidth: 0 } as const

export function QuestionnaireScreen({ brandId }: { brandId: string }) {
  const router = useRouter()
  const base = `/brands/${brandId}/onboarding`
  const [data, setData] = useState<Reply | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [stale, setStale] = useState(false)
  const [stopped, setStopped] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [asked, setAsked] = useState<Asked | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  // What the owner has typed, per question: the value shown, whether "Other" is chosen, and the save status.
  const [values, setValues] = useState<Record<string, string>>({})
  const [others, setOthers] = useState<Record<string, boolean>>({})
  const [status, setStatus] = useState<Record<string, Status>>({})
  const valuesRef = useRef<Record<string, string>>({})
  const savedRef = useRef<Record<string, string>>({})
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const chains = useRef(new Map<string, Promise<boolean>>())
  const live = useRef(true)

  const [confirming, setConfirming] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)
  // A second press before the first reply must not send again.
  const finishSending = useRef(false)
  const startSending = useRef(false)

  // Reads now, then again every POLL_MS while the job runs or waits. The timer is cleared when the screen goes;
  // a read that fails keeps what is shown and tries again; a refusal that will not change stops it.
  useEffect(() => {
    let on = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      let again = true
      try {
        const fresh = await api(questionnaireReply, 'GET', `${base}/questionnaire`)
        if (!on) return
        // New questions start from the saved answer, else empty; ones being typed in are left alone.
        const added: Record<string, string> = {}
        for (const q of fresh.questionnaire?.questions ?? []) {
          if (!(q.id in valuesRef.current)) {
            added[q.id] = startValue(q)
            savedRef.current[q.id] = q.answer ?? ''
          }
        }
        if (Object.keys(added).length > 0) {
          valuesRef.current = { ...valuesRef.current, ...added }
          setValues(valuesRef.current)
        }
        if (fresh.job?.state === 'waiting_for_answer') {
          const list = await api(agentQuestionsReply, 'GET', `${base}/agent-questions`)
          if (!on) return
          const open = list.questions.filter((q) => q.answer === null)
          const found = open.find((q) => q.id === fresh.job?.questionId) ?? open[0]
          if (found) setAsked(found)
        } else {
          // The job is no longer waiting on the owner, so the question and its "Sent" note go.
          setAsked(null)
        }
        setData(fresh)
        setError(null)
        setStale(false)
        again = isOpenJob(fresh.job?.state)
      } catch (e) {
        if (!on) return
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          if (e.status === 403) setError(e)
          setStopped(
            e.status === 401
              ? 'You are signed out. Sign in again to see the questionnaire.'
              : e.status === 403
                ? OWNER_ONLY
                : 'This brand was not found. Open All brands and choose it again.',
          )
          return
        }
        setStale(true)
        setError(e instanceof Error ? e : new Error('failed'))
      }
      if (on && again) timer = setTimeout(() => void read(), POLL_MS)
    }
    void read()
    return () => {
      on = false
      if (timer) clearTimeout(timer)
    }
  }, [base, attempt])

  const save = useCallback(
    (id: string): Promise<boolean> => {
      timers.current.delete(id)
      const run = async (): Promise<boolean> => {
        const value = valuesRef.current[id] ?? ''
        if (savedRef.current[id] === value) {
          if (live.current) setStatus((s) => ({ ...s, [id]: { kind: 'saved' } }))
          return true
        }
        try {
          await api(answerSavedReply, 'PUT', `${base}/questionnaire/answers/${id}`, { value })
          savedRef.current[id] = value
          if (live.current) setStatus((s) => ({ ...s, [id]: { kind: 'saved' } }))
          return true
        } catch (e) {
          // The questionnaire was finished elsewhere: read it again, so the form becomes read-only.
          if (live.current && e instanceof ApiError && e.code === 'questionnaire_finished')
            setAttempt((n) => n + 1)
          if (live.current)
            setStatus((s) => ({
              ...s,
              [id]: {
                kind: 'error',
                text: failureWords(e, 'This answer was not saved. Change it again to retry.'),
              },
            }))
          return false
        }
      }
      // One save at a time per question, in the order typed.
      const next = (chains.current.get(id) ?? Promise.resolve(true)).then(run)
      chains.current.set(id, next)
      return next
    },
    [base],
  )

  // Leaving the page sends what is still waiting to be saved; the screen is gone, so nothing is shown for it.
  useEffect(() => {
    live.current = true
    const pending = timers.current
    return () => {
      live.current = false
      for (const [id, timer] of [...pending]) {
        clearTimeout(timer)
        void save(id)
      }
      pending.clear()
    }
  }, [save])

  // Closing the tab does not run the cleanup above in time for a request to finish, so on `pagehide` each answer
  // still waiting goes out with `keepalive`, which the browser completes after the page is gone. The request
  // token is read once on arrival, because a closing page cannot wait for it.
  useEffect(() => {
    void warmCsrfToken()
    const flush = () => {
      for (const [id, timer] of [...timers.current]) {
        const value = valuesRef.current[id] ?? ''
        if (
          savedRef.current[id] !== value &&
          !sendOnLeave('PUT', `${base}/questionnaire/answers/${id}`, { value })
        )
          continue
        clearTimeout(timer)
        timers.current.delete(id)
        savedRef.current[id] = value
      }
    }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [base])

  function change(id: string, value: string) {
    valuesRef.current = { ...valuesRef.current, [id]: value }
    setValues(valuesRef.current)
    setStatus((s) => ({ ...s, [id]: { kind: 'pending' } }))
    const old = timers.current.get(id)
    if (old) clearTimeout(old)
    timers.current.set(
      id,
      setTimeout(() => void save(id), SAVE_MS),
    )
  }

  async function start() {
    if (startSending.current) return
    startSending.current = true
    setStarting(true)
    setStartError(null)
    try {
      await api(questionnaireStartedReply, 'POST', `${base}/questionnaire`)
      setAttempt((n) => n + 1)
    } catch (e) {
      setStartError(failureWords(e, 'The questionnaire could not be prepared. Try again.'))
    } finally {
      startSending.current = false
      setStarting(false)
    }
  }

  const questions = data?.questionnaire?.questions ?? []
  const shown = (q: Question) => valuesRef.current[q.id] ?? values[q.id] ?? startValue(q)
  // Every answer is the owner's own (typed, chosen, or saved before); an untouched suggestion is a blank.
  const answered = questions.filter((q) => (values[q.id] ?? startValue(q)).trim() !== '').length
  const blank = questions.length - answered

  async function finish() {
    if (finishSending.current) return
    finishSending.current = true
    setFinishing(true)
    setFinishError(null)
    try {
      // Every pending save goes now, so what the counts said is what gets finished. Only what the owner gave
      // differs from what is saved; a suggestion the owner did not use is never sent.
      for (const [id, timer] of timers.current) {
        clearTimeout(timer)
        timers.current.delete(id)
      }
      const results = await Promise.all(
        questions.map((q) => {
          if (!(q.id in valuesRef.current)) valuesRef.current[q.id] = startValue(q)
          const value = shown(q)
          const saved = savedRef.current[q.id] ?? q.answer ?? ''
          return value === saved ? Promise.resolve(true) : save(q.id)
        }),
      )
      if (results.includes(false)) {
        setFinishError('Some answers were not saved. Fix the ones marked, then finish again.')
        setConfirming(false)
        finishSending.current = false
        setFinishing(false)
        return
      }
      await api(questionnaireFinishedReply, 'POST', `${base}/questionnaire/finish`)
      router.push(`/b/${brandId}/onboarding/facts-rules`)
      return
    } catch (e) {
      setFinishError(failureWords(e, 'The questionnaire could not be finished. Try again.'))
      setConfirming(false)
      setAttempt((n) => n + 1)
    }
    // Only a refusal gets here: the page is left on a success, so the button stays off.
    finishSending.current = false
    if (live.current) setFinishing(false)
  }

  if (isForbidden(error)) return <OwnerOnly />

  const job = data?.job ?? null
  const finished = data?.questionnaire?.finishedAt != null

  return (
    <main id="content" className="page">
      <div className="page-head">
        <div>
          <h1>Questionnaire</h1>
          <p>Answer what the research could not find. Each answer saves as you type.</p>
        </div>
      </div>
      {stopped ? (
        <div className="callout warn" role="alert">
          {stopped}
        </div>
      ) : !data ? (
        error ? (
          <LoadError
            what="the questionnaire"
            error={error as ApiError}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : (
          <p className="muted">Loading…</p>
        )
      ) : (
        <div className="stack">
          {stale ? (
            <p className="callout warn" role="status">
              The latest state could not be read. This screen keeps trying.
            </p>
          ) : null}
          {asked ? (
            <AgentQuestion
              key={asked.id}
              brandId={brandId}
              question={asked}
              onRefresh={() => setAttempt((n) => n + 1)}
            />
          ) : null}
          {job && isOpenJob(job.state) ? (
            <p className="callout" role="status">
              {JOB_WORDS[job.state]}
            </p>
          ) : null}
          {!data.questionnaire && !isOpenJob(job?.state) ? (
            <div className="panel pad stack">
              <p className="sub">
                {job?.state === 'failed'
                  ? 'The questionnaire could not be written. Prepare it again. If it fails again, check that the questionnaire agent has a live release.'
                  : 'The questionnaire turns the gaps in the draft profile into questions, each with a suggested answer.'}
              </p>
              {startError ? (
                <p className="errtext" role="alert">
                  {startError}
                </p>
              ) : null}
              <div>
                <button
                  className="btn primary onb-touch"
                  type="button"
                  disabled={starting}
                  onClick={() => void start()}
                >
                  Prepare the questionnaire
                </button>
              </div>
            </div>
          ) : null}
          {data.questionnaire && finished ? (
            <div className="panel pad stack">
              {finishError ? (
                <p className="errtext" role="alert">
                  {finishError}
                </p>
              ) : null}
              <p className="callout ok" role="status">
                This questionnaire is finished. Its answers are kept.
              </p>
              <div>
                <Link className="btn primary onb-touch" href={`/b/${brandId}/onboarding/facts-rules`}>
                  Go to facts and rules
                </Link>
              </div>
            </div>
          ) : null}
          {data.questionnaire ? (
            <ol className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {questions.map((q) => (
                <QuestionRow
                  key={q.id}
                  q={q}
                  value={values[q.id] ?? startValue(q)}
                  other={others[q.id] === true}
                  status={status[q.id]}
                  disabled={finished}
                  onOther={(on) => setOthers((o) => ({ ...o, [q.id]: on }))}
                  onChange={(v) => change(q.id, v)}
                />
              ))}
            </ol>
          ) : null}
          {data.questionnaire && !finished && questions.length > 0 ? (
            <div className="panel pad stack">
              {finishError ? (
                <p className="errtext" role="alert">
                  {finishError}
                </p>
              ) : null}
              {confirming ? (
                <>
                  <p>{`${answered} answered, ${blank} left blank. Finish now?`}</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <button
                      className="btn primary onb-touch"
                      type="button"
                      disabled={finishing}
                      onClick={() => void finish()}
                    >
                      Yes, finish
                    </button>
                    <button
                      className="btn onb-touch"
                      type="button"
                      disabled={finishing}
                      onClick={() => setConfirming(false)}
                    >
                      Keep answering
                    </button>
                  </div>
                </>
              ) : (
                <div>
                  <button
                    className="btn primary onb-touch"
                    type="button"
                    onClick={() => {
                      setFinishError(null)
                      setConfirming(true)
                    }}
                  >
                    Finish questionnaire
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </main>
  )
}

function QuestionRow(props: {
  q: Question
  value: string
  other: boolean
  status: Status | undefined
  disabled: boolean
  onOther: (on: boolean) => void
  onChange: (value: string) => void
}) {
  const { q, value, status } = props
  const inOptions = q.options.includes(value)
  const otherChosen = props.other || (value !== '' && !inOptions)
  const suggested = q.suggestedAnswer
  const note =
    status?.kind === 'saved' ? (
      <span className="tag ok">Saved</span>
    ) : status?.kind === 'pending' ? (
      <span className="muted small">Saving…</span>
    ) : status?.kind === 'error' ? (
      <span className="errtext small" role="alert">
        {status.text}
      </span>
    ) : null
  return (
    <li className="panel pad stack onb-comp">
      <div>
        <b className="onb-wrap">{`${q.position}. ${q.text}`}</b>
        <p className="muted small onb-wrap">{`Why we ask: ${q.why}`}</p>
        {suggested !== null ? <p className="small onb-wrap">{`Suggested: ${suggested}`}</p> : null}
      </div>
      {q.options.length > 0 ? (
        <fieldset className="field" style={setStyle} disabled={props.disabled}>
          <legend className="lab">Choose an answer</legend>
          {q.options.map((option) => (
            <label key={option} className="onb-touch" style={rowStyle}>
              <input
                type="radio"
                name={`q-${q.id}`}
                value={option}
                checked={!otherChosen && value === option}
                onChange={() => {
                  props.onOther(false)
                  props.onChange(option)
                }}
              />
              <span className="onb-wrap">{option}</span>
              {option === suggested ? <span className="tag plain">suggested</span> : null}
            </label>
          ))}
          <label className="onb-touch" style={rowStyle}>
            <input
              type="radio"
              name={`q-${q.id}`}
              value="other"
              checked={otherChosen}
              onChange={() => {
                props.onOther(true)
                if (inOptions) props.onChange('')
              }}
            />
            <span>Other</span>
          </label>
          {otherChosen ? (
            <div className="field">
              <label htmlFor={`other-${q.id}`}>Your own answer</label>
              <input
                id={`other-${q.id}`}
                className="input"
                type="text"
                maxLength={MAX_ANSWER}
                value={inOptions ? '' : value}
                onChange={(event) => props.onChange(event.target.value)}
              />
            </div>
          ) : null}
        </fieldset>
      ) : (
        <div className="field">
          <label htmlFor={`a-${q.id}`}>Your answer</label>
          <textarea
            id={`a-${q.id}`}
            className="input"
            maxLength={MAX_ANSWER}
            disabled={props.disabled}
            value={value}
            onChange={(event) => props.onChange(event.target.value)}
          />
          {/* Using the suggestion is the owner's own act: it fills the box and saves like typing. */}
          {suggested !== null && !props.disabled && value !== suggested ? (
            <div>
              <button className="btn onb-touch" type="button" onClick={() => props.onChange(suggested)}>
                Use the suggestion
              </button>
            </div>
          ) : null}
        </div>
      )}
      <div aria-live="polite">{note}</div>
    </li>
  )
}
