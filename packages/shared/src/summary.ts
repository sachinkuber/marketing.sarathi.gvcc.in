import { z } from 'zod'
import { DISALLOWED } from './disallowed.ts'

export const BRIEF_MAX = 2000
const SUMMARY_MAX = 600
const KEYWORD_MAX = 60
// The limits the placeholder check holds a result to (plan decision 6).
const CHECK_SUMMARY_MAX = 400
const CHECK_KEYWORD_MAX = 40

// Non-empty text without the invisible and control characters the payload refuses.
const text = z.string().min(1)
const visible = (value: string) => !DISALLOWED.test(value) && value.trim() !== ''
const NOT_VISIBLE = 'is blank or contains an invisible or control character'

export const briefSchema = z.strictObject({
  brief: text.max(BRIEF_MAX).refine(visible, NOT_VISIBLE),
})

export const summaryResultSchema = z.strictObject({
  summary: text.max(SUMMARY_MAX).refine(visible, NOT_VISIBLE),
  keywords: z.array(text.max(KEYWORD_MAX).refine(visible, NOT_VISIBLE)).length(3),
})
export type SummaryResult = z.infer<typeof summaryResultSchema>

export function summaryPayload(result: SummaryResult): Record<string, unknown> {
  return {
    kind: 'summary',
    language: 'en',
    title: 'Summary of the brief',
    summary: result.summary,
    body: [
      { type: 'paragraph', text: result.summary },
      { type: 'list', ordered: false, items: result.keywords },
    ],
  }
}

export function placeholderCheck(payload: Record<string, unknown>): {
  passed: boolean
  detail: { summaryLength: number; longestKeyword: number }
} {
  const summary = typeof payload['summary'] === 'string' ? payload['summary'] : ''
  const body = Array.isArray(payload['body']) ? (payload['body'] as Array<Record<string, unknown>>) : []
  const keywords = body.flatMap((block) =>
    block['type'] === 'list' && Array.isArray(block['items']) ? (block['items'] as unknown[]) : [],
  )
  const summaryLength = summary.length
  const allText = keywords.every((keyword) => typeof keyword === 'string')
  const longestKeyword = keywords.reduce<number>(
    (longest, keyword) => Math.max(longest, typeof keyword === 'string' ? keyword.length : 0),
    0,
  )
  return {
    passed: allText && summaryLength <= CHECK_SUMMARY_MAX && longestKeyword <= CHECK_KEYWORD_MAX,
    detail: { summaryLength, longestKeyword },
  }
}

// The brief is data: it sits between fixed lines, and any angle bracket inside it is swapped for a
// look-alike so it cannot close the block early.
export function wrapBrief(brief: string): string {
  return `<brief>\n${brief.replace(/</g, '‹').replace(/>/g, '›')}\n</brief>`
}
