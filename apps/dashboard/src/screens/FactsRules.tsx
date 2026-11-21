'use client'
import Link from 'next/link'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { ApiError, api } from '../api/client'
import {
  agentQuestion,
  agentQuestionsReply,
  factAddedReply,
  factChangedReply,
  factsRulesReply,
  factsRulesStartedReply,
  onboardingReply,
  ruleAddedReply,
  ruleChangedReply,
  suggestionDecisionReply,
  suggestionItem,
} from '../api/schemas'
import { LoadError } from '../frame/LoadError'
import { AgentQuestion } from './AgentQuestion'
import { AddAsCase, Ask, SourceRow } from './onboarding-parts'
import { OwnerOnly } from './OwnerOnly'
import {
  OWNER_ONLY,
  RULE_KIND_WORD,
  dayOn,
  failureWords,
  isForbidden,
  refusalWords,
  tomorrow,
} from './onboarding-words'

type Reply = z.infer<typeof factsRulesReply>
type Item = z.infer<typeof suggestionItem>
type Source = Item['sources'][number]
type Asked = z.infer<typeof agentQuestion>
type Decision =
  | { decision: 'accepted' | 'rejected'; reviewDate?: string }
  | { decision: 'edited'; value: Record<string, string> }

// How often the screen asks again while the facts and rules job runs or waits.
export const POLL_MS = 5000

const isOpenJob = (state: string | undefined) =>
  state === 'waiting' || state === 'running' || state === 'waiting_for_answer'

const JOB_WORDS: Record<string, string> = {
  waiting: 'Facts and rules are queued. They start soon.',
  running:
    'Facts and rules are being written. This takes a few minutes. You can leave this page and come back.',
  waiting_for_answer: 'The agent needs an answer from you before it can go on. Answer it below.',
}

const KINDS = Object.keys(RULE_KIND_WORD)
const MAX_TEXT = 300
const row = { display: 'flex', flexWrap: 'wrap', gap: 8 } as const

const asText = (value: unknown, key: string): string => {
  if (typeof value === 'object' && value !== null) {
    const v = (value as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : ''
  }
  return ''
}

// Codes that mean the screen's picture is out of date, so it reads again.
const STALE = new Set(['already_confirmed', 'already_decided', 'superseded', 'not_active'])

// One send at a time per card: a second press before the reply does nothing. A refusal is shown as the core
// worded it; a refusal that means the picture is stale reads the screen again.
function useSender(onChanged: () => void) {
  const sending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const run = async (work: () => Promise<unknown>, otherwise: string): Promise<boolean> => {
    if (sending.current) return false
    sending.current = true
    setBusy(true)
    setError(null)
    setCode(null)
    try {
      await work()
      onChanged()
      return true
    } catch (e) {
      if (e instanceof ApiError && STALE.has(e.code)) onChanged()
      setCode(e instanceof ApiError ? e.code : null)
      setError(refusalWords(e, otherwise))
      return false
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  return { run, busy, error, code }
}

// The intake website, which tells a page of the brand's own site from another web page: a string, null when the
// brand has none, and undefined until the overview has been read (or when it could not be).
const WebsiteContext = createContext<string | null | undefined>(undefined)

// What the fact or rule rests on, shown as it is: the owner decides with it in view.
function Sources({ sources, id }: { sources: Source[]; id: string }) {
  const website = useContext(WebsiteContext)
  if (sources.length === 0) return <p className="muted small">No sources.</p>
  return (
    <ul className="list onb-sources" id={`src-${id}`}>
      {sources.map((s) => (
        <SourceRow key={s.id} source={s} website={website} />
      ))}
    </ul>
  )
}

function Problem({ text }: { text: string | null }) {
  return text ? (
    <p className="errtext" role="alert">
      {text}
    </p>
  ) : null
}

function FactCard({ item, base, onChanged }: { item: Item; base: string; onChanged: () => void }) {
  const statement = asText(item.proposed, 'statement')
  const suggestedDate = asText(item.proposed, 'reviewDate')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(statement)
  const [date, setDate] = useState(suggestedDate)
  const send = useSender(onChanged)
  const decide = (body: Decision) =>
    send.run(
      () => api(suggestionDecisionReply, 'POST', `${base}/suggestions/${item.id}/decision`, body),
      'The decision was not saved. Try again.',
    )
  // A refusal for want of a source offers the owner's own wording.
  useEffect(() => {
    if (send.code === 'fact_needs_source') setEditing(true)
  }, [send.code])
  return (
    <li className="dp-item" data-id={item.id}>
      <p className="dp-value onb-wrap">{statement}</p>
      <p className="muted small onb-wrap">{item.why}</p>
      <Sources sources={item.sources} id={item.id} />
      {editing ? (
        <div className="field">
          <label htmlFor={`edit-${item.id}`}>Your wording</label>
          <textarea
            id={`edit-${item.id}`}
            className="input dp-edit"
            maxLength={MAX_TEXT}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
      ) : null}
      <div className="field">
        <label htmlFor={`date-${item.id}`}>Review date</label>
        <input
          id={`date-${item.id}`}
          className="input"
          type="date"
          min={tomorrow()}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>
      <Problem text={send.error} />
      <div className="dp-actions">
        {editing ? (
          <>
            <button
              className="btn primary onb-touch"
              type="button"
              disabled={send.busy || draft.trim() === ''}
              onClick={() =>
                void decide({ decision: 'edited', value: { statement: draft.trim(), reviewDate: date } })
              }
            >
              Save edit
            </button>
            <button className="btn onb-touch" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              className="btn ok onb-touch"
              type="button"
              disabled={send.busy}
              onClick={() =>
                void decide(
                  date === suggestedDate
                    ? { decision: 'accepted' }
                    : { decision: 'accepted', reviewDate: date },
                )
              }
            >
              Confirm
            </button>
            <button
              className="btn onb-touch"
              type="button"
              disabled={send.busy}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          </>
        )}
        <Ask
          label="Drop"
          question="Drop this fact? It will not be used."
          yes="Yes, drop"
          danger
          busy={send.busy}
          onYes={() => void decide({ decision: 'rejected' })}
        />
      </div>
    </li>
  )
}

// A suggestion the owner edited or dropped: it can become a candidate evaluation case.
function Corrected({ item, base }: { item: Item; base: string }) {
  const key = item.step === 'fact' ? 'statement' : 'text'
  const edited = item.decision === 'edited'
  return (
    <li className="dp-item" data-id={item.id}>
      <p className="dp-value onb-wrap">{asText(item.proposed, key)}</p>
      <p className="muted small onb-wrap">
        {edited ? `You changed it to: ${asText(item.decidedValue, key)}` : 'You dropped it.'}
      </p>
      <AddAsCase base={base} suggestionId={item.id} />
    </li>
  )
}

function KindSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>Kind of rule</label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {RULE_KIND_WORD[k]}
          </option>
        ))}
      </select>
    </div>
  )
}

function RuleCard({ item, base, onChanged }: { item: Item; base: string; onChanged: () => void }) {
  const kind = asText(item.proposed, 'kind')
  const text = asText(item.proposed, 'text')
  const [editing, setEditing] = useState(false)
  const [kindDraft, setKindDraft] = useState(kind)
  const [textDraft, setTextDraft] = useState(text)
  const [whyDraft, setWhyDraft] = useState(item.why)
  const send = useSender(onChanged)
  const decide = (body: Decision) =>
    send.run(
      () => api(suggestionDecisionReply, 'POST', `${base}/suggestions/${item.id}/decision`, body),
      'The decision was not saved. Try again.',
    )
  return (
    <li className="dp-item" data-id={item.id}>
      <span className="tag plain">{RULE_KIND_WORD[kind] ?? kind}</span>
      <p className="dp-value onb-wrap">{text}</p>
      <p className="muted small onb-wrap">{`Why: ${item.why}`}</p>
      <Sources sources={item.sources} id={item.id} />
      {editing ? (
        <>
          <KindSelect id={`edit-kind-${item.id}`} value={kindDraft} onChange={setKindDraft} />
          <div className="field">
            <label htmlFor={`edit-${item.id}`}>Your wording</label>
            <textarea
              id={`edit-${item.id}`}
              className="input dp-edit"
              maxLength={MAX_TEXT}
              value={textDraft}
              onChange={(e) => setTextDraft(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`edit-why-${item.id}`}>Why</label>
            <textarea
              id={`edit-why-${item.id}`}
              className="input"
              maxLength={MAX_TEXT}
              value={whyDraft}
              onChange={(e) => setWhyDraft(e.target.value)}
            />
          </div>
        </>
      ) : null}
      <Problem text={send.error} />
      <div className="dp-actions">
        {editing ? (
          <>
            <button
              className="btn primary onb-touch"
              type="button"
              disabled={send.busy || textDraft.trim() === '' || whyDraft.trim() === ''}
              onClick={() =>
                void decide({
                  decision: 'edited',
                  value: { kind: kindDraft, text: textDraft.trim(), why: whyDraft.trim() },
                })
              }
            >
              Save edit
            </button>
            <button className="btn onb-touch" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              className="btn ok onb-touch"
              type="button"
              disabled={send.busy}
              onClick={() => void decide({ decision: 'accepted' })}
            >
              Confirm
            </button>
            <button
              className="btn onb-touch"
              type="button"
              disabled={send.busy}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          </>
        )}
        <Ask
          label="Drop"
          question="Drop this rule? It will not be used."
          yes="Yes, drop"
          danger
          busy={send.busy}
          onYes={() => void decide({ decision: 'rejected' })}
        />
      </div>
    </li>
  )
}

function ActiveFact({
  fact,
  base,
  onChanged,
}: {
  fact: Reply['facts']['active'][number]
  base: string
  onChanged: () => void
}) {
  const [replacing, setReplacing] = useState(false)
  const [statement, setStatement] = useState(fact.statement)
  const [date, setDate] = useState(fact.reviewDate)
  const send = useSender(onChanged)
  return (
    <li className="dp-item" data-id={fact.id}>
      <p className="dp-value onb-wrap">{fact.statement}</p>
      <p className="muted small">{`Review by ${dayOn(fact.reviewDate)}`}</p>
      <Sources sources={fact.sources} id={fact.id} />
      {replacing ? (
        <div className="stack">
          <div className="field">
            <label htmlFor={`replace-${fact.id}-statement`}>The new wording</label>
            <textarea
              id={`replace-${fact.id}-statement`}
              className="input dp-edit"
              maxLength={MAX_TEXT}
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`replace-${fact.id}-date`}>Review date</label>
            <input
              id={`replace-${fact.id}-date`}
              className="input"
              type="date"
              min={tomorrow()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div style={row}>
            <button
              className="btn primary onb-touch"
              type="button"
              disabled={send.busy || statement.trim() === ''}
              onClick={() =>
                void send
                  .run(
                    () =>
                      api(factChangedReply, 'POST', `${base}/facts/${fact.id}/replace`, {
                        statement: statement.trim(),
                        reviewDate: date,
                      }),
                    'The fact was not replaced. Try again.',
                  )
                  .then((ok) => ok && setReplacing(false))
              }
            >
              Replace fact
            </button>
            <button className="btn onb-touch" type="button" onClick={() => setReplacing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="dp-actions">
          <button
            className="btn onb-touch"
            type="button"
            disabled={send.busy}
            onClick={() => setReplacing(true)}
          >
            Replace
          </button>
          <Ask
            label="Retire"
            question="Retire this fact? It is kept, but no longer used."
            yes="Yes, retire"
            danger
            busy={send.busy}
            onYes={() =>
              void send.run(
                () => api(factChangedReply, 'POST', `${base}/facts/${fact.id}/retire`),
                'The fact was not retired. Try again.',
              )
            }
          />
        </div>
      )}
      <Problem text={send.error} />
    </li>
  )
}

function ActiveRule({
  rule,
  base,
  onChanged,
}: {
  rule: Reply['rules']['active'][number]
  base: string
  onChanged: () => void
}) {
  const send = useSender(onChanged)
  return (
    <li className="dp-item" data-id={rule.id}>
      <span className="tag plain">{RULE_KIND_WORD[rule.kind] ?? rule.kind}</span>
      <p className="dp-value onb-wrap">{rule.text}</p>
      <p className="muted small onb-wrap">{`Why: ${rule.why}`}</p>
      <Problem text={send.error} />
      <div className="dp-actions">
        <Ask
          label="Turn off"
          question="Turn off this rule? It is kept, but no longer applies."
          yes="Yes, turn off"
          danger
          busy={send.busy}
          onYes={() =>
            void send.run(
              () => api(ruleChangedReply, 'POST', `${base}/rules/${rule.id}/turn-off`),
              'The rule was not turned off. Try again.',
            )
          }
        />
      </div>
    </li>
  )
}

function AddFact({ base, onChanged }: { base: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [statement, setStatement] = useState('')
  const [date, setDate] = useState('')
  const send = useSender(onChanged)
  if (!open)
    return (
      <div>
        <button className="btn onb-touch" type="button" onClick={() => setOpen(true)}>
          Add your own fact
        </button>
      </div>
    )
  return (
    <div className="panel pad stack">
      <div className="field">
        <label htmlFor="own-fact-statement">The fact, in your words</label>
        <textarea
          id="own-fact-statement"
          className="input"
          maxLength={MAX_TEXT}
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="own-fact-date">Review date</label>
        <input
          id="own-fact-date"
          className="input"
          type="date"
          min={tomorrow()}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>
      <Problem text={send.error} />
      <div style={row}>
        <button
          className="btn primary onb-touch"
          type="button"
          disabled={send.busy || statement.trim() === '' || date === ''}
          onClick={() =>
            void send
              .run(
                () =>
                  api(factAddedReply, 'POST', `${base}/facts`, {
                    statement: statement.trim(),
                    reviewDate: date,
                  }),
                'The fact was not added. Try again.',
              )
              .then((ok) => {
                if (!ok) return
                setStatement('')
                setDate('')
                setOpen(false)
              })
          }
        >
          Add fact
        </button>
        <button className="btn onb-touch" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function AddRule({ base, onChanged }: { base: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState(KINDS[0]!)
  const [text, setText] = useState('')
  const [why, setWhy] = useState('')
  const send = useSender(onChanged)
  if (!open)
    return (
      <div>
        <button className="btn onb-touch" type="button" onClick={() => setOpen(true)}>
          Add your own rule
        </button>
      </div>
    )
  return (
    <div className="panel pad stack">
      <KindSelect id="own-rule-kind" value={kind} onChange={setKind} />
      <div className="field">
        <label htmlFor="own-rule-text">The rule, in your words</label>
        <textarea
          id="own-rule-text"
          className="input"
          maxLength={MAX_TEXT}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="own-rule-why">Why</label>
        <textarea
          id="own-rule-why"
          className="input"
          maxLength={MAX_TEXT}
          value={why}
          onChange={(e) => setWhy(e.target.value)}
        />
      </div>
      <Problem text={send.error} />
      <div style={row}>
        <button
          className="btn primary onb-touch"
          type="button"
          disabled={send.busy || text.trim() === '' || why.trim() === ''}
          onClick={() =>
            void send
              .run(
                () =>
                  api(ruleAddedReply, 'POST', `${base}/rules`, { kind, text: text.trim(), why: why.trim() }),
                'The rule was not added. Try again.',
              )
              .then((ok) => {
                if (!ok) return
                setText('')
                setWhy('')
                setOpen(false)
              })
          }
        >
          Add rule
        </button>
        <button className="btn onb-touch" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export function FactsRulesScreen({ brandId }: { brandId: string }) {
  const base = `/brands/${brandId}/onboarding`
  const [data, setData] = useState<Reply | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [stale, setStale] = useState(false)
  const [stopped, setStopped] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [asked, setAsked] = useState<Asked | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const startSending = useRef(false)
  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  // Reads now, then again every POLL_MS while the job runs or waits. The timer goes with the screen; a read that
  // fails keeps what is shown and tries again; a refusal that will not change stops it.
  useEffect(() => {
    let on = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      let again = true
      try {
        const fresh = await api(factsRulesReply, 'GET', `${base}/facts-rules`)
        if (!on) return
        if (fresh.job?.state === 'waiting_for_answer') {
          const list = await api(agentQuestionsReply, 'GET', `${base}/agent-questions`)
          if (!on) return
          const open = list.questions.filter((q) => q.answer === null)
          const found = open.find((q) => q.id === fresh.job?.questionId) ?? open[0]
          setAsked(found ?? null)
        } else {
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
              ? 'You are signed out. Sign in again to see facts and rules.'
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

  // The intake website, read once from the overview after the first read of this screen, for the sources' labels.
  // A failed read leaves it unknown.
  const [website, setWebsite] = useState<string | null | undefined>(undefined)
  const loaded = data !== null
  useEffect(() => {
    if (!loaded) return
    let on = true
    api(onboardingReply, 'GET', base)
      .then((overview) => {
        if (on) setWebsite(overview.intake?.website ?? null)
      })
      .catch(() => undefined)
    return () => {
      on = false
    }
  }, [base, loaded])

  async function start() {
    if (startSending.current) return
    startSending.current = true
    setStarting(true)
    setStartError(null)
    try {
      await api(factsRulesStartedReply, 'POST', `${base}/facts-rules`)
      reload()
    } catch (e) {
      setStartError(failureWords(e, 'Facts and rules could not be started. Try again.'))
    } finally {
      startSending.current = false
      setStarting(false)
    }
  }

  if (isForbidden(error)) return <OwnerOnly />

  const open = (items: Item[]) => items.filter((i) => i.decision === null)
  const facts = open(data?.facts.suggestions ?? [])
  const foundFacts = facts.filter((f) => f.confidence === 'found')
  const assumedFacts = facts.filter((f) => f.confidence !== 'found')
  const rules = open(data?.rules.suggestions ?? [])
  const job = data?.job ?? null
  const activeFacts = data?.facts.active ?? []
  const activeRules = data?.rules.active ?? []
  const corrected = [...(data?.facts.suggestions ?? []), ...(data?.rules.suggestions ?? [])].filter(
    (i) => i.decision === 'edited' || i.decision === 'rejected',
  )

  return (
    <WebsiteContext value={website}>
      <main id="content" className="page">
        <div className="page-head">
          <div>
            <h1>Facts and rules</h1>
            <p>
              Confirm what the platform may state as fact, and what it must never say. Nothing is used until
              you confirm it.
            </p>
          </div>
        </div>
        {stopped ? (
          <div className="callout warn" role="alert">
            {stopped}
          </div>
        ) : !data ? (
          error ? (
            <LoadError what="facts and rules" error={error as ApiError} onRetry={reload} />
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
            {job && isOpenJob(job.state) ? (
              <p className="callout" role="status">
                {JOB_WORDS[job.state]}
              </p>
            ) : null}
            {!isOpenJob(job?.state) ? (
              <div className="panel pad stack">
                <p className="sub">
                  {job?.state === 'failed'
                    ? 'Facts and rules could not be written. Start them again. If they fail again, check that the facts and rules agent has a live release.'
                    : facts.length + rules.length > 0
                      ? 'Start again to look for more facts and rules from the latest profile and answers. A waiting suggestion that the new run suggests again is replaced by the new one; the others stay waiting. What you confirmed stays.'
                      : 'The platform reads the confirmed profile and your answers, and suggests facts and safety rules.'}
                </p>
                <Problem text={startError} />
                <div>
                  <button
                    className="btn primary onb-touch"
                    type="button"
                    disabled={starting}
                    onClick={() => void start()}
                  >
                    {job ? 'Find facts and rules again' : 'Find facts and rules'}
                  </button>
                </div>
              </div>
            ) : null}
            {job && !isOpenJob(job.state) && job.state !== 'failed' && facts.length + rules.length === 0 ? (
              <div>
                <Link className="btn primary onb-touch" href={`/b/${brandId}/onboarding/brief-choices`}>
                  Continue to brief choices
                </Link>
              </div>
            ) : null}

            <section className="panel" aria-label="Facts to confirm">
              <h2 className="pad onb-h">Facts to confirm</h2>
              {foundFacts.length + assumedFacts.length === 0 ? (
                <p className="pad sub">No facts wait for your decision.</p>
              ) : null}
              {foundFacts.length > 0 ? (
                <ul className="list">
                  {foundFacts.map((f) => (
                    <FactCard key={f.id} item={f} base={base} onChanged={reload} />
                  ))}
                </ul>
              ) : null}
              {assumedFacts.length > 0 ? (
                <>
                  <h3 className="pad onb-h">Needs your wording</h3>
                  <p className="pad muted small">
                    These have no source that proves them. Edit them into your own words before confirming.
                  </p>
                  <ul className="list">
                    {assumedFacts.map((f) => (
                      <FactCard key={f.id} item={f} base={base} onChanged={reload} />
                    ))}
                  </ul>
                </>
              ) : null}
              <div className="pad">
                <AddFact base={base} onChanged={reload} />
              </div>
            </section>

            <section className="panel" aria-label="Rules to confirm">
              <h2 className="pad onb-h">Rules to confirm</h2>
              {rules.length === 0 ? <p className="pad sub">No rules wait for your decision.</p> : null}
              {rules.length > 0 ? (
                <ul className="list">
                  {rules.map((r) => (
                    <RuleCard key={r.id} item={r} base={base} onChanged={reload} />
                  ))}
                </ul>
              ) : null}
              <div className="pad">
                <AddRule base={base} onChanged={reload} />
              </div>
            </section>

            {corrected.length > 0 ? (
              <section className="panel" aria-label="Your corrections">
                <h2 className="pad onb-h">Your corrections</h2>
                <p className="pad muted small">
                  Add a correction as a case so the platform is tested on it later.
                </p>
                <ul className="list">
                  {corrected.map((i) => (
                    <Corrected key={i.id} item={i} base={base} />
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="panel" aria-label="Confirmed facts">
              <h2 className="pad onb-h">Confirmed facts</h2>
              {activeFacts.length === 0 ? <p className="pad sub">No fact is confirmed yet.</p> : null}
              <ul className="list">
                {activeFacts.map((f) => (
                  <ActiveFact key={f.id} fact={f} base={base} onChanged={reload} />
                ))}
              </ul>
            </section>

            <section className="panel" aria-label="Confirmed rules">
              <h2 className="pad onb-h">Confirmed rules</h2>
              {activeRules.length === 0 ? <p className="pad sub">No rule is confirmed yet.</p> : null}
              <ul className="list">
                {activeRules.map((r) => (
                  <ActiveRule key={r.id} rule={r} base={base} onChanged={reload} />
                ))}
              </ul>
            </section>
          </div>
        )}
      </main>
    </WebsiteContext>
  )
}
