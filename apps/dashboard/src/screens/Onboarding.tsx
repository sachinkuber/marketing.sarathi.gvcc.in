'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { api } from '../api/client'
import { agentQuestionsReply, onboardingReply } from '../api/schemas'
import { useLoad } from '../api/use-load'
import { LoadError } from '../frame/LoadError'
import { AgentQuestion } from './AgentQuestion'
import { OwnerOnly } from './OwnerOnly'
import { costWords, isForbidden } from './onboarding-words'

type Asked = z.infer<typeof agentQuestionsReply>['questions'][number]

const STEP_WORD: Record<string, string> = {
  intake: 'Intake: the website, social links, competitors and documents',
  research: 'Research: the agents are reading what you gave them',
  profile: 'Draft profile: suggestions wait for your decision',
  facts_rules: 'Facts and rules: confirm what the platform may state and what it must never say',
  questionnaire: 'Questionnaire: answer what the research could not find',
  question: 'Questions',
  fact: 'Facts',
  rule: 'Rules',
  choice: 'Choices',
}

const LATER = new Set(['facts_rules', 'fact', 'rule', 'choice'])

// Where Continue leads: intake until research has started, progress while it runs, then the draft profile while
// suggestions wait, then the questionnaire.
function nextPath(brandId: string, step: string, openSuggestions: number): string {
  const base = `/b/${brandId}/onboarding`
  if (step === 'intake') return `${base}/intake`
  if (step === 'research') return `${base}/research`
  if (LATER.has(step)) return `${base}/facts-rules`
  if (step === 'profile' && openSuggestions > 0) return `${base}/profile`
  if (step === 'profile' || step === 'questionnaire') return `${base}/questionnaire`
  return `${base}/profile`
}

export function OnboardingScreen({ brandId }: { brandId: string }) {
  const load = useLoad(() => api(onboardingReply, 'GET', `/brands/${brandId}/onboarding`), brandId)
  // The questions agents asked and are waiting on. Read apart from the overview: if it fails the overview still shows.
  const [asked, setAsked] = useState<Asked[]>([])
  useEffect(() => {
    let on = true
    api(agentQuestionsReply, 'GET', `/brands/${brandId}/onboarding/agent-questions`).then(
      (list) => on && setAsked(list.questions.filter((q) => q.answer === null)),
      () => {},
    )
    return () => {
      on = false
    }
  }, [brandId])
  const data = load.data
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
                : data.openSuggestions > 0
                  ? `${data.openSuggestions} ${data.openSuggestions === 1 ? 'suggestion waits' : 'suggestions wait'} for your decision.`
                  : data.step === 'research'
                    ? 'Nothing yet. The research is still running or has just finished.'
                    : 'Nothing is waiting.'}
            </p>
          </div>
          <div>
            <b>Cost so far</b>
            <p className="sub">{costWords(data.cost)}</p>
          </div>
          {asked.map((q) => (
            <AgentQuestion key={q.id} brandId={brandId} question={q} />
          ))}
          <div>
            <Link className="btn primary onb-touch" href={nextPath(brandId, data.step, data.openSuggestions)}>
              Continue
            </Link>
          </div>
        </div>
      )}
    </main>
  )
}
