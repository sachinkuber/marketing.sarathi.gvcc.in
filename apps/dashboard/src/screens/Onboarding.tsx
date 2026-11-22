'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { api } from '../api/client'
import { agentQuestionsReply, briefStartedReply, caseAddedReply, onboardingReply } from '../api/schemas'
import { useLoad } from '../api/use-load'
import { LoadError } from '../frame/LoadError'
import { AgentQuestion } from './AgentQuestion'
import { OwnerOnly } from './OwnerOnly'
import { CASE_ADDED } from './onboarding-parts'
import {
  BRIEF_CLOSED,
  BRIEF_FAILED,
  BRIEF_REVISED_THRICE,
  canWriteAgain,
  costWords,
  isForbidden,
  isOpenJob,
  refusalWords,
} from './onboarding-words'

// How often the overview asks again while the strategist job is going.
export const POLL_MS = 5000

type Asked = z.infer<typeof agentQuestionsReply>['questions'][number]

const STEP_WORD: Record<string, string> = {
  intake: 'Intake: the website, social links, competitors and documents',
  research: 'Research: the agents are reading what you gave them',
  profile: 'Draft profile: suggestions wait for your decision',
  facts_rules: 'Facts and rules: confirm what the platform may state and what it must never say',
  questionnaire: 'Questionnaire: answer what the research could not find',
  brief_choices: 'Brief choices',
  brief: 'Strategy brief',
  done: 'Onboarded',
  question: 'Questions',
  fact: 'Facts',
  rule: 'Rules',
  choice: 'Choices',
}

const LATER = new Set(['facts_rules', 'fact', 'rule', 'choice'])

// Where Continue leads: intake until research has started, progress while it runs, then the draft profile while
// suggestions wait, then the questionnaire.
function nextPath(
  brandId: string,
  step: string,
  openSuggestions: number,
  briefItemId: string | null,
): string {
  const base = `/b/${brandId}/onboarding`
  if (step === 'intake') return `${base}/intake`
  if (step === 'research') return `${base}/research`
  if (step === 'brief_choices') return `${base}/brief-choices`
  if (step === 'brief' || step === 'done')
    return briefItemId ? `/b/${brandId}/inbox/${briefItemId}` : `${base}/brief-choices`
  if (LATER.has(step)) return `${base}/facts-rules`
  if (step === 'profile' && openSuggestions > 0) return `${base}/profile`
  if (step === 'profile' || step === 'questionnaire') return `${base}/questionnaire`
  return `${base}/profile`
}

type Overview = z.infer<typeof onboardingReply>

// The strategy brief on the overview: gate 1, a brief that needs re-approval or a decision, and one being written.
function BriefStatus({
  brandId,
  data,
  onChanged,
}: {
  brandId: string
  data: Overview
  onChanged: () => void
}) {
  const sending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const { brief, briefJob } = data
  const writing = briefJob?.state === 'waiting' || briefJob?.state === 'running'
  async function again() {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setProblem(null)
    try {
      await api(briefStartedReply, 'POST', `/brands/${brandId}/onboarding/brief`)
      onChanged()
    } catch (e) {
      setProblem(refusalWords(e, 'The brief could not be started. Try again.'))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  const invalidated = brief?.state === 'invalidated'
  const failed = briefJob?.state === 'failed'
  const jobOpen = isOpenJob(briefJob?.state)
  const closed = !jobOpen && !failed && brief?.state === 'rejected' && !brief.needsDecision
  const showAgain = !jobOpen && (failed || canWriteAgain(brief, briefJob))
  if (!data.gate1 && !brief && !briefJob) return null
  return (
    <div className="stack">
      {data.gate1 ? (
        <p className="callout ok" role="status">
          Onboarded: the strategy brief is approved.
        </p>
      ) : null}
      {writing ? (
        <p className="callout" role="status">
          Writing the brief…
        </p>
      ) : null}
      {!writing && brief?.state === 'awaiting_approval' && !brief.needsDecision ? (
        <p className="callout" role="status">
          The brief is waiting for your approval.
        </p>
      ) : null}
      {invalidated ? (
        <p className="callout warn" role="status">
          The brief needs re-approval: a fact it cites changed.
        </p>
      ) : null}
      {brief?.needsDecision ? (
        <p className="callout warn" role="status">
          {BRIEF_REVISED_THRICE}
        </p>
      ) : null}
      {closed ? (
        <p className="callout warn" role="status">
          {BRIEF_CLOSED}
        </p>
      ) : null}
      {failed ? (
        <p className="callout warn" role="alert">
          {BRIEF_FAILED}
        </p>
      ) : null}
      {problem ? (
        <p className="errtext" role="alert">
          {problem}
        </p>
      ) : null}
      {showAgain ? (
        <div>
          <button className="btn onb-touch" type="button" disabled={busy} onClick={() => void again()}>
            {failed ? 'Write the strategy brief' : 'Write the brief again'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

const MAX_EXAMPLE = 4000
const MAX_NOTE = 1000

// A good or a bad post the owner gives as an example; it becomes a candidate evaluation case (C8).
function Examples({ brandId }: { brandId: string }) {
  const sending = useRef(false)
  const [kind, setKind] = useState<'good' | 'bad'>('good')
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [added, setAdded] = useState(false)
  async function add(event: React.FormEvent) {
    event.preventDefault()
    if (sending.current || text.trim() === '') return
    sending.current = true
    setBusy(true)
    setProblem(null)
    setAdded(false)
    try {
      await api(caseAddedReply, 'POST', `/brands/${brandId}/onboarding/examples`, {
        example: kind,
        text: text.trim(),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      })
      setText('')
      setNote('')
      setAdded(true)
    } catch (e) {
      setProblem(refusalWords(e, 'The example was not added. Try again.'))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  return (
    <form className="stack" onSubmit={(e) => void add(e)} aria-labelledby="examples-h">
      <b id="examples-h">Examples of good and bad posts</b>
      <p className="muted small">
        Paste a post you like, or one you never want to see. The platform is tested against it later.
      </p>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', gap: 16 }}>
        <legend className="sr-only">Kind of example</legend>
        <label htmlFor="example-good" className="onb-touch">
          <input
            id="example-good"
            type="radio"
            name="example-kind"
            checked={kind === 'good'}
            onChange={() => setKind('good')}
          />{' '}
          Good
        </label>
        <label htmlFor="example-bad" className="onb-touch">
          <input
            id="example-bad"
            type="radio"
            name="example-kind"
            checked={kind === 'bad'}
            onChange={() => setKind('bad')}
          />{' '}
          Bad
        </label>
      </fieldset>
      <div className="field">
        <label htmlFor="example-text">The post</label>
        <textarea
          id="example-text"
          className="input"
          maxLength={MAX_EXAMPLE}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="example-note">Why (optional)</label>
        <input
          id="example-note"
          className="input"
          maxLength={MAX_NOTE}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {problem ? (
        <p className="errtext" role="alert">
          {problem}
        </p>
      ) : null}
      {added ? (
        <p className="sub" role="status">
          {CASE_ADDED}
        </p>
      ) : null}
      <div>
        <button className="btn onb-touch" type="submit" disabled={busy || text.trim() === ''}>
          Add the example
        </button>
      </div>
    </form>
  )
}

export function OnboardingScreen({ brandId }: { brandId: string }) {
  const load = useLoad(() => api(onboardingReply, 'GET', `/brands/${brandId}/onboarding`), brandId)
  // The questions agents asked and are waiting on. Read apart from the overview: if it fails the overview still shows.
  const [asked, setAsked] = useState<Asked[]>([])
  const [askedFailed, setAskedFailed] = useState(false)
  useEffect(() => {
    let on = true
    api(agentQuestionsReply, 'GET', `/brands/${brandId}/onboarding/agent-questions`).then(
      (list) => on && setAsked(list.questions.filter((q) => q.answer === null)),
      () => on && setAskedFailed(true),
    )
    return () => {
      on = false
    }
  }, [brandId])
  const data = load.data
  const { refresh } = load
  // While the strategist job is going, the overview is read again every POLL_MS, in place: what is shown (and a
  // half-typed example) stays until the new state arrives. It stops once the job is done or failed.
  const briefOpen = isOpenJob(data?.briefJob?.state)
  const [polls, setPolls] = useState(0)
  useEffect(() => {
    if (!briefOpen) return
    let on = true
    const timer = setTimeout(() => {
      void refresh().finally(() => {
        if (on) setPolls((n) => n + 1)
      })
    }, POLL_MS)
    return () => {
      on = false
      clearTimeout(timer)
    }
  }, [briefOpen, polls, refresh])
  if (isForbidden(load.error)) return <OwnerOnly />
  return (
    <main id="content" className="page">
      <div className="page-head">
        <div>
          <h1>Onboarding</h1>
          <p>Teach the platform about this brand: what you give it, what it finds, what you decide.</p>
        </div>
      </div>
      {load.state === 'error' ? (
        <LoadError what="onboarding" error={load.error} onRetry={load.retry} />
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="panel pad stack">
          <div>
            <b>Where you are</b>
            <p className="sub">{STEP_WORD[data.step] ?? data.step}</p>
          </div>
          <div>
            <b>Waiting for you</b>
            <p className="sub">
              {data.step === 'intake'
                ? data.intake
                  ? 'Start research when the intake is right.'
                  : 'Save the intake: at least the website.'
                : [
                    asked.length > 0 &&
                      `${asked.length} ${asked.length === 1 ? 'question waits' : 'questions wait'} for your answer.`,
                    data.openSuggestions > 0 &&
                      `${data.openSuggestions} ${data.openSuggestions === 1 ? 'suggestion waits' : 'suggestions wait'} for your decision.`,
                  ]
                    .filter(Boolean)
                    .join(' ') ||
                  (data.step === 'research'
                    ? 'Nothing yet. The research is still running or has just finished.'
                    : 'Nothing is waiting.')}
            </p>
          </div>
          <div>
            <b>Cost so far</b>
            <p className="sub">{costWords(data.cost)}</p>
          </div>
          {askedFailed ? (
            <p className="callout warn" role="status">
              Questions from the agents could not be read. Reload the page to see them.
            </p>
          ) : null}
          {asked.map((q) => (
            <AgentQuestion key={q.id} brandId={brandId} question={q} />
          ))}
          <BriefStatus brandId={brandId} data={data} onChanged={() => void refresh()} />
          <div>
            <Link
              className="btn primary onb-touch"
              href={nextPath(brandId, data.step, data.openSuggestions, data.brief?.itemId ?? null)}
            >
              Continue
            </Link>
          </div>
          <Examples brandId={brandId} />
        </div>
      )}
    </main>
  )
}
