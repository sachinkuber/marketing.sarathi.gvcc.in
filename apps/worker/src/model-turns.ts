import { ModelStopped, type ModelRequest, type ModelTool } from './model.ts'
import type { JobContext } from './runner.ts'

export const DEFAULT_MAX_CONTINUATIONS = 6

export interface TurnCaps {
  searches: number
  fetches: number
  maxContinuations?: number
}

export interface TurnsResult {
  // The text of the reply that ended the turn.
  text: string
  // Every content block of every reply, in order (search results and fetched pages included).
  content: unknown[]
  searches: number
  fetches: number
}

// One logical model turn that may take several provider requests: the provider pauses a long turn with
// `pause_turn` and expects the same request back with its assistant content appended (no "continue" message).
// Each request is its own checkpointed step `${step}#n`, so a crash resumes from the last saved one. The tool
// caps are for the whole turn: each request may use only what the earlier ones left. Written once and used
// by every tool-using handler.
export async function modelTurns(
  ctx: JobContext,
  step: string,
  request: ModelRequest,
  caps: TurnCaps,
): Promise<TurnsResult> {
  const maxContinuations = caps.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS
  const messages = [...request.messages]
  const content: unknown[] = []
  let searches = 0
  let fetches = 0

  for (let turn = 0; ; turn += 1) {
    const remaining = (tool: ModelTool): number =>
      Math.min(
        tool.maxUses,
        tool.type === 'web_search_20260209' ? caps.searches - searches : caps.fetches - fetches,
      )
    const tools = (request.tools ?? [])
      .map((tool) => ({ ...tool, maxUses: remaining(tool) }))
      .filter((tool) => tool.maxUses > 0)
    const next: ModelRequest = { ...request, messages }
    delete next.tools
    if (tools.length > 0) next.tools = tools
    const reply = await ctx.modelStep(`${step}#${turn}`, next)
    searches += reply.usage?.serverToolSearches ?? 0
    fetches += reply.usage?.serverToolFetches ?? 0
    const blocks = reply.content ?? []
    content.push(...blocks)
    if (reply.stopReason === 'end_turn') return { text: reply.text, content, searches, fetches }
    if (reply.stopReason !== 'pause_turn') throw new ModelStopped(reply.stopReason ?? null)
    if (turn + 1 > maxContinuations) throw new ModelStopped('cap_reached')
    messages.push({ role: 'assistant', content: blocks })
  }
}
