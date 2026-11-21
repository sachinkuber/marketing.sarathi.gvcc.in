import { ModelStopped, type ModelRequest, type ModelTool } from './model.ts'
import { TIMEOUT_MS_BY_CLASS, type JobContext } from './runner.ts'

export const DEFAULT_MAX_CONTINUATIONS = 6
// Time kept back at the end of the attempt for checkpointing and posting the result.
export const DEADLINE_MARGIN_MS = 60_000
// A request given less time than this is not started.
export const MIN_REQUEST_MS = 30_000

// The time one request may take: its own bound (default the job class's), cut so it ends before the attempt's
// token does, less the margin kept for checkpointing and posting. A request with too little time is not
// started: ModelStopped('time_budget'). Every handler's model call takes its timeout from here.
export function attemptTimeoutMs(ctx: JobContext, requestedMs?: number): number {
  const classTimeout = requestedMs ?? TIMEOUT_MS_BY_CLASS[ctx.jobClass] ?? 240_000
  const timeoutMs = Math.min(classTimeout, ctx.deadline.getTime() - Date.now() - DEADLINE_MARGIN_MS)
  if (timeoutMs < MIN_REQUEST_MS) throw new ModelStopped('time_budget')
  return timeoutMs
}

export interface TurnCaps {
  searches: number
  fetches: number
  maxContinuations?: number
  // The searches the whole run may use (the definition's searchesPerBrandStep). With it, a request's searches are
  // also limited to what the run has left: the cap less the searches recorded before this attempt
  // (ctx.runSearches) and the ones made so far in this attempt. Absent: no run limit.
  runSearchCap?: number
}

export interface TurnsResult {
  // The text of the reply that ended the turn.
  text: string
  // Every content block of every reply, in order (search results and fetched pages included).
  content: unknown[]
  searches: number
  fetches: number
}

const TOOL_NAME = { web_search_20260209: 'web_search', web_fetch_20260209: 'web_fetch' } as const

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
    // Each request ends before the attempt's token does (less the margin), or is not started.
    const timeoutMs = attemptTimeoutMs(ctx, request.timeoutMs)

    const used = (tool: ModelTool): number => (tool.type === 'web_search_20260209' ? searches : fetches)
    // The turn's cap, and for web_search also what the run has left (M2): the run cap less the searches
    // recorded before this attempt and the ones made so far in it. Both are for "uses still allowed".
    const cap = (tool: ModelTool): number =>
      tool.type === 'web_search_20260209' ? caps.searches : caps.fetches
    const runLeft = (tool: ModelTool): number =>
      tool.type === 'web_search_20260209' && caps.runSearchCap !== undefined
        ? caps.runSearchCap - (ctx.runSearches ?? 0) - searches
        : Number.POSITIVE_INFINITY
    // A tool whose budget is spent (its turn cap or the run's) is left out. Exception (R29): a continuation
    // whose history holds that tool's blocks keeps it with max_uses 1, because it is not known whether the API
    // accepts such a history with the tool omitted or with max_uses 0 (see the R13 probe in
    // anthropic-live.test.ts, not yet run). So the run cap is enforced at run time, with at most one search over
    // it per continuation until that probe is run.
    const inHistory = (tool: ModelTool): boolean =>
      content.some((b) => {
        const block = b as { type?: unknown; name?: unknown }
        return block?.type === 'server_tool_use' && block.name === TOOL_NAME[tool.type]
      })
    const tools: ModelTool[] = []
    for (const tool of request.tools ?? []) {
      const left = Math.min(tool.maxUses, cap(tool) - used(tool), runLeft(tool))
      if (left > 0) tools.push({ ...tool, maxUses: left })
      else if (inHistory(tool)) tools.push({ ...tool, maxUses: 1 })
    }
    const next: ModelRequest = { ...request, messages: [...messages], timeoutMs }
    delete next.tools
    if (tools.length > 0) next.tools = tools
    const reply = await ctx.modelStep(`${step}#${turn}`, next)
    searches += reply.usage?.serverToolSearches ?? 0
    fetches += reply.usage?.serverToolFetches ?? 0
    const blocks = reply.content
    if (reply.stopReason === 'end_turn') {
      content.push(...(blocks ?? []))
      return { text: reply.text, content, searches, fetches }
    }
    if (reply.stopReason !== 'pause_turn') throw new ModelStopped(reply.stopReason ?? null)
    // Never send an empty assistant turn back.
    if (!blocks || blocks.length === 0) throw new Error('a paused reply carried no content blocks')
    content.push(...blocks)
    if (turn + 1 > maxContinuations) throw new ModelStopped('cap_reached')
    messages.push({ role: 'assistant', content: blocks })
  }
}
