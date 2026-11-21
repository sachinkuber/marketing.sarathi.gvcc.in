import { z } from 'zod'
import { shown } from './visible-text.ts'

export const BRIEF_MAX = 2000
const SUMMARY_MAX = 600
const KEYWORD_MAX = 60
// The limits the placeholder check holds a result to (plan decision 6).
const CHECK_SUMMARY_MAX = 400
const CHECK_KEYWORD_MAX = 40

export const briefSchema = z.strictObject({
  brief: shown(BRIEF_MAX),
})

export const summaryResultSchema = z.strictObject({
  summary: shown(SUMMARY_MAX),
  keywords: z.array(shown(KEYWORD_MAX)).length(3),
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

// The one way untrusted text reaches a model: it sits between fixed lines, and any angle bracket inside it is
// swapped for a look-alike so it cannot close the block early. Attribute values (an address, a ref) are
// cleaned the same way, and of quotes and line breaks, so they cannot leave their attribute either.
const swapBrackets = (text: string) => text.replace(/</g, '‹').replace(/>/g, '›')
// eslint-disable-next-line no-control-regex -- line breaks and controls are what is removed
const CONTROLS = /[\u0000-\u001F\u007F]/g
export function wrapData(tag: string, text: string, attributes: Record<string, string> = {}): string {
  const attrs = Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${swapBrackets(value).replace(/"/g, '″').replace(CONTROLS, ' ')}"`)
    .join('')
  return `<${tag}${attrs}>\n${swapBrackets(text)}\n</${tag}>`
}

// The brief is data, wrapped like all untrusted text.
export function wrapBrief(brief: string): string {
  return wrapData('brief', brief)
}
