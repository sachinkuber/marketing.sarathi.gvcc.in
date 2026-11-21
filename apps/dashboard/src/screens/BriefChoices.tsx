'use client'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { ApiError, api } from '../api/client'
import {
  agentQuestion,
  agentQuestionsReply,
  briefChoice,
  briefChoicesReply,
  briefChoicesStartedReply,
  briefStartedReply,
  onboardingReply,
  suggestionDecisionReply,
} from '../api/schemas'
import { LoadError } from '../frame/LoadError'
import { AgentQuestion } from './AgentQuestion'
import { AddAsCase } from './onboarding-parts'
import { OwnerOnly } from './OwnerOnly'
import { BRIEF_FAILED, OWNER_ONLY, isForbidden, refusalWords } from './onboarding-words'

type Reply = z.infer<typeof briefChoicesReply>
type Overview = z.infer<typeof onboardingReply>
type Choice = z.infer<typeof briefChoice>
type Asked = z.infer<typeof agentQuestion>

// How often the screen asks again while a job runs or waits.
export const POLL_MS = 5000

const OTHER = '__other__'
const MAX_OWN = 300

const isOpenJob = (state: string | undefined) =>
  state === 'waiting' || state === 'running' || state === 'waiting_for_answer'

const CHOICES_WORDS: Record<string, string> = {
  waiting: 'The open choices are queued. They start soon.',
  running:
    'The open choices are being found. This takes a few minutes. You can leave this page and come back.',
  waiting_for_answer: 'The agent needs an answer from you before it can go on. Answer it below.',
}

const BRIEF_WORDS: Record<string, string> = {
  waiting: 'Writing the brief…',
  running: 'Writing the brief…',
  waiting_for_answer: 'The agent needs an answer from you before it can go on. Answer it below.',
}

function Problem({ text }: { text: string | null }) {
  return text ? (
    <p className="errtext" role="alert">
      {text}
    </p>
  ) : null
}

// What the owner sends for one choice: the recommended option as accepted, anything else as an edit.
function decisionFor(choice: Choice, picked: string, own: string) {
  if (picked === OTHER) return { decision: 'edited' as const, value: { value: own.trim() } }
  const option = choice.options[Number(picked)]
  if (!option) return null
  return option.recommended
    ? { decision: 'accepted' as const }
    : { decision: 'edited' as const, value: { value: option.value } }
}

const defaultPick = (choice: Choice): string => {
  const at = choice.options.findIndex((o) => o.recommended)
  return String(at >= 0 ? at : 0)
}

function ChoiceCard(props: {
  choice: Choice
  picked: string
  own: string
  onPick: (value: string) => void
  onOwn: (text: string) => void
  base: string
}) {
  const { choice } = props
  const name = `choice-${choice.id}`
  return (
    <section className="panel pad stack" aria-labelledby={`${name}-q`}>
      <h2 className="onb-h onb-wrap" id={`${name}-q`}>
        {choice.question}
      </h2>
      <p className="muted small onb-wrap">{choice.why}</p>
      {choice.decision ? (
        <>
          <p className="sub onb-wrap">
            <span className="tag ok">
              {choice.decision === 'accepted'
                ? 'Accepted'
                : choice.options.some((o) => o.value === choice.picked)
                  ? 'Your pick'
                  : 'Your own words'}
            </span>
            {` ${choice.picked ?? ''}`}
          </p>
          {choice.decision === 'edited' ? <AddAsCase base={props.base} suggestionId={choice.id} /> : null}
        </>
      ) : (
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">{choice.question}</legend>
          {choice.options.map((o, i) => (
            <div key={`${i}-${o.value}`} className="field">
              <label htmlFor={`${name}-opt-${i}`} className="onb-touch onb-wrap">
                <input
                  id={`${name}-opt-${i}`}
                  type="radio"
                  name={name}
                  checked={props.picked === String(i)}
                  onChange={() => props.onPick(String(i))}
                />{' '}
                <b>{o.value}</b>
                {o.recommended ? <span className="tag ok">Recommended</span> : null}
                <span className="muted small" style={{ display: 'block' }}>
                  {o.tradeOff}
                </span>
              </label>
            </div>
          ))}
          <div className="field">
            <label htmlFor={`${name}-other-radio`} className="onb-touch">
              <input
                id={`${name}-other-radio`}
                type="radio"
                name={name}
                checked={props.picked === OTHER}
                onChange={() => props.onPick(OTHER)}
              />{' '}
              <b>Other</b>
            </label>
            {props.picked === OTHER ? (
              <>
                <label htmlFor={`${name}-other`} className="sr-only">
                  Your own words
                </label>
                <textarea
                  id={`${name}-other`}
                  className="input"
                  maxLength={MAX_OWN}
                  value={props.own}
                  onChange={(e) => props.onOwn(e.target.value)}
                />
              </>
            ) : null}
          </div>
        </fieldset>
      )}
    </section>
  )
}

export function BriefChoicesScreen({ brandId }: { brandId: string }) {
  const base = `/brands/${brandId}/onboarding`
  const [data, setData] = useState<Reply | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [stale, setStale] = useState(false)
  const [stopped, setStopped] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [asked, setAsked] = useState<Asked | null>(null)
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [owns, setOwns] = useState<Record<string, string>>({})
  const [problem, setProblem] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  // Reads now, then again every POLL_MS while the choices job or the strategist job runs or waits.
  useEffect(() => {
    let on = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      let again = true
      try {
        const fresh = await api(briefChoicesReply, 'GET', `${base}/brief-choices`)
        const over = await api(onboardingReply, 'GET', base)
        if (!on) return
        const waiting =
          fresh.job?.state === 'waiting_for_answer' || over.briefJob?.state === 'waiting_for_answer'
        if (waiting) {
          const list = await api(agentQuestionsReply, 'GET', `${base}/agent-questions`)
          if (!on) return
          const open = list.questions.filter((q) => q.answer === null)
          const wanted = fresh.job?.questionId ?? over.briefJob?.questionId
          setAsked(open.find((q) => q.id === wanted) ?? open[0] ?? null)
        } else {
          setAsked(null)
        }
        setData(fresh)
        setOverview(over)
        setError(null)
        setStale(false)
        again = isOpenJob(fresh.job?.state) || isOpenJob(over.briefJob?.state)
      } catch (e) {
        if (!on) return
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          if (e.status === 403) setError(e)
          setStopped(
            e.status === 401
              ? 'You are signed out. Sign in again to see the brief choices.'
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

  // One send at a time. A refusal is shown as the core worded it.
  async function send(work: () => Promise<unknown>, otherwise: string): Promise<boolean> {
    if (sending.current) return false
    sending.current = true
    setBusy(true)
    setProblem(null)
    setSaved(false)
    try {
      await work()
      return true
    } catch (e) {
      setProblem(refusalWords(e, otherwise))
      return false
    } finally {
      sending.current = false
      setBusy(false)
      reload()
    }
  }

  if (isForbidden(error)) return <OwnerOnly />

  const choices = data?.choices ?? []
  const undecided = choices.filter((c) => c.decision === null)
  const pickOf = (c: Choice) => picks[c.id] ?? defaultPick(c)
  const ownOf = (c: Choice) => owns[c.id] ?? ''
  const ownMissing = undecided.some((c) => pickOf(c) === OTHER && ownOf(c).trim() === '')
  const job = data?.job ?? null
  const briefJob = overview?.briefJob ?? null
  const brief = overview?.brief ?? null
  const choicesOpen = isOpenJob(job?.state)
  const briefOpen = isOpenJob(briefJob?.state)
  const failed = briefJob?.state === 'failed'

  const find = () =>
    void send(
      () => api(briefChoicesStartedReply, 'POST', `${base}/brief-choices`),
      'The open choices could not be started. Try again.',
    )

  const savePicks = async () => {
    const ok = await send(async () => {
      for (const c of undecided) {
        const body = decisionFor(c, pickOf(c), ownOf(c))
        if (!body) continue
        await api(suggestionDecisionReply, 'POST', `${base}/suggestions/${c.id}/decision`, body)
      }
    }, 'Your picks were not saved. Try again.')
    if (ok) setSaved(true)
  }

  const writeBrief = () =>
    void send(
      () => api(briefStartedReply, 'POST', `${base}/brief`),
      'The brief could not be started. Try again.',
    )

  return (
    <main id="content" className="page">
      <div className="page-head">
        <div>
          <h1>Brief choices</h1>
          <p>
            Before the strategy brief is written, decide the open strategic choices. The recommended option is
            chosen for you; change it, or write your own.
          </p>
        </div>
      </div>
      {stopped ? (
        <div className="callout warn" role="alert">
          {stopped}
        </div>
      ) : !data ? (
        error ? (
          <LoadError what="brief choices" error={error as ApiError} onRetry={reload} />
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
            <AgentQuestion key={asked.id} brandId={brandId} question={asked} onRefresh={reload} />
          ) : null}
          {job && choicesOpen ? (
            <p className="callout" role="status">
              {CHOICES_WORDS[job.state]}
            </p>
          ) : null}
          <Problem text={problem} />

          {choices.length === 0 && !choicesOpen ? (
            <div className="panel pad stack">
              <p className="sub">
                {job?.state === 'failed'
                  ? 'The open choices could not be found. Try again. If they fail again, check that the brief choices agent has a live release.'
                  : 'The platform reads the confirmed profile, facts and rules, and finds the strategic choices only you can make.'}
              </p>
              <div>
                <button className="btn primary onb-touch" type="button" disabled={busy} onClick={find}>
                  Find the open choices
                </button>
              </div>
            </div>
          ) : null}

          {choices.map((c) => (
            <ChoiceCard
              key={c.id}
              choice={c}
              picked={pickOf(c)}
              own={ownOf(c)}
              base={base}
              onPick={(v) => setPicks((p) => ({ ...p, [c.id]: v }))}
              onOwn={(t) => setOwns((o) => ({ ...o, [c.id]: t }))}
            />
          ))}

          {undecided.length > 0 ? (
            <div className="panel pad stack">
              <div>
                <button
                  className="btn primary onb-touch"
                  type="button"
                  disabled={busy || ownMissing}
                  onClick={() => void savePicks()}
                >
                  Save my picks
                </button>
              </div>
              {ownMissing ? <p className="muted small">Write your own words, or pick an option.</p> : null}
            </div>
          ) : null}
          {saved && undecided.length === 0 ? (
            <p className="callout" role="status">
              Picks saved.
            </p>
          ) : null}

          {choices.length > 0 && undecided.length === 0 ? (
            <div className="panel pad stack">
              <h2 className="onb-h">Strategy brief</h2>
              {briefOpen ? (
                <p className="callout" role="status">
                  {BRIEF_WORDS[briefJob?.state ?? 'running']}
                </p>
              ) : null}
              {!briefOpen && brief?.state === 'awaiting_approval' ? (
                <p className="sub">The brief is waiting for your approval.</p>
              ) : null}
              {!briefOpen && brief?.state === 'approved' ? (
                <p className="sub">The brief is approved.</p>
              ) : null}
              {!briefOpen && brief?.state === 'invalidated' ? (
                <p className="sub">The brief needs re-approval: a fact it cites changed.</p>
              ) : null}
              {!briefOpen && briefJob?.state === 'failed' ? (
                <p className="callout warn" role="alert">
                  {BRIEF_FAILED}
                </p>
              ) : null}
              {brief ? (
                <div>
                  <Link className="btn onb-touch" href={`/b/${brandId}/inbox/${brief.itemId}`}>
                    Review the brief
                  </Link>
                </div>
              ) : null}
              {!briefOpen && (!brief || failed || brief.state === 'invalidated' || brief.needsDecision) ? (
                <div>
                  <button
                    className="btn primary onb-touch"
                    type="button"
                    disabled={busy}
                    onClick={writeBrief}
                  >
                    {brief && !failed ? 'Write the brief again' : 'Write the strategy brief'}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </main>
  )
}
