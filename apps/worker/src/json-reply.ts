// A reply whose text holds no JSON object. The text is not quoted: it is model output over untrusted pages.
export class ReplyHasNoJson extends Error {
  constructor() {
    super('The reply holds no JSON object.')
    this.name = 'ReplyHasNoJson'
  }
}

// The index just past the object that opens at `start`, or -1 when it never closes. Braces inside JSON strings
// do not count.
function objectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

// The JSON object in a reply's text. A request that may carry web-search citations cannot ask for structured
// output (the provider refuses the two together), so the final text can have narration before or after the
// object, or be several text blocks joined. Each top-level `{…}` that parses as an object is a candidate and
// the longest wins: a stray brace in narration is skipped, and a small object quoted in narration loses to the
// result. Text with no object is refused.
export function extractJsonObject(text: string): Record<string, unknown> {
  let best: { value: Record<string, unknown>; length: number } | null = null
  let from = text.indexOf('{')
  while (from !== -1) {
    const end = objectEnd(text, from)
    let next = from + 1
    if (end !== -1) {
      try {
        const value: unknown = JSON.parse(text.slice(from, end))
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          if (best === null || end - from > best.length)
            best = { value: value as Record<string, unknown>, length: end - from }
          // The braces inside a parsed object are not candidates of their own.
          next = end
        }
      } catch {
        // Not JSON from this brace: try the next one.
      }
    }
    from = text.indexOf('{', next)
  }
  if (best === null) throw new ReplyHasNoJson()
  return best.value
}
