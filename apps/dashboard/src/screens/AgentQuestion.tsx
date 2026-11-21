'use client'
import { useRef, useState } from 'react'
import type { z } from 'zod'
import { ApiError, api } from '../api/client'
import { agentQuestion, agentQuestionAnsweredReply } from '../api/schemas'
import { failureWords } from './onboarding-words'

type Question = z.infer<typeof agentQuestion>

export const SENT_WORDS = 'Sent. The job starts again with your answer.'
export const SUGGESTED_WORDS = 'Suggested by the agent; change it if it is wrong.'
const MAX_ANSWER = 2000

// A question an agent asked the owner (spec 9): what it asks, why, the options with the suggested one
// pre-selected, and a box for the owner's own words. With no options the suggestion is in the box itself, so what
// is sent is always what the owner sees. The answer is sent once; the job then starts again.
export function AgentQuestion({
  brandId,
  question,
  onSent,
  onRefresh,
}: {
  brandId: string
  question: Pick<Question, 'id' | 'question' | 'why' | 'options' | 'suggested'>
  onSent?: () => void
  // Called when the core says the question is no longer open, so the screen reads again.
  onRefresh?: () => void
}) {
  const hasOptions = question.options.length > 0
  const [choice, setChoice] = useState(hasOptions ? (question.suggested ?? '') : '')
  const [own, setOwn] = useState(hasOptions ? '' : (question.suggested ?? ''))
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A second click before the first reply must not send again.
  const sending = useRef(false)
  const id = question.id
  // The box holds the agent's suggestion (there are no options to pre-select), and says so until it is changed.
  const prefilled = !hasOptions && question.suggested !== null && own === question.suggested

  // The owner's own words win over the option.
  const answer = (own.trim() !== '' ? own : choice).trim()

  async function send() {
    if (sending.current || answer === '') return
    sending.current = true
    setBusy(true)
    setError(null)
    try {
      await api(
        agentQuestionAnsweredReply,
        'POST',
        `/brands/${brandId}/onboarding/agent-questions/${id}/answer`,
        { answer },
      )
      setSent(true)
      onSent?.()
    } catch (e) {
      sending.current = false
      if (e instanceof ApiError && (e.code === 'already_answered' || e.code === 'job_not_waiting'))
        onRefresh?.()
      setError(failureWords(e, 'The answer was not sent. Check your connection, then send it again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel pad stack onb-comp" aria-label="A question from the agent">
      <div>
        <b className="onb-wrap">{question.question}</b>
        <p className="muted small onb-wrap">{`Why we ask: ${question.why}`}</p>
      </div>
      {sent ? (
        <p className="callout ok" role="status">
          {SENT_WORDS}
        </p>
      ) : (
        <>
          {question.options.length > 0 ? (
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <legend className="lab">Choose an answer</legend>
              {question.options.map((option) => (
                <label
                  key={option}
                  className="onb-touch"
                  style={{ display: 'flex', gap: 8, alignItems: 'center' }}
                >
                  <input
                    type="radio"
                    name={`aq-${id}`}
                    value={option}
                    checked={choice === option}
                    onChange={() => setChoice(option)}
                  />
                  <span className="onb-wrap">{option}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="field">
            <label htmlFor={`aq-own-${id}`}>
              {question.options.length > 0 ? 'Or write your own answer' : 'Your answer'}
            </label>
            <textarea
              id={`aq-own-${id}`}
              className="input"
              maxLength={MAX_ANSWER}
              value={own}
              aria-describedby={prefilled ? `aq-hint-${id}` : undefined}
              onChange={(event) => setOwn(event.target.value)}
            />
            {prefilled ? (
              <p id={`aq-hint-${id}`} className="muted small">
                {SUGGESTED_WORDS}
              </p>
            ) : null}
          </div>
          {error ? (
            <p className="errtext" role="alert">
              {error}
            </p>
          ) : null}
          <div>
            <button
              className="btn primary onb-touch"
              type="button"
              disabled={busy || answer === ''}
              onClick={() => void send()}
            >
              Send answer
            </button>
          </div>
        </>
      )}
    </section>
  )
}
