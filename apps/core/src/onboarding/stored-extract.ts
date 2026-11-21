import { EXTRACT_MAX } from '@mkt/shared'

// ---- A flagged source keeps its flag as a marker at the head of its stored extract (ruling R28). ----

const STORED_EXTRACT_MAX = 600
const FLAG = /^\[flagged: ([^\]]*)\] ([\s\S]*)$/
// An unflagged extract that itself begins like the marker (page text is untrusted) is stored behind one more
// backslash, so it never reads back as flagged; reading drops that backslash again.
const LOOKS_FLAGGED = /^\\*\[flagged:/
const ESCAPED = /^\\+\[flagged:/

// Cut to at most `max` UTF-16 units without leaving half of a surrogate pair at the end.
function cut(text: string, max: number): string {
  const head = text.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head
}

// "[flagged: <reason>] <extract>", at most 600 characters in all. Brackets in the reason are shown as
// parentheses, so the marker always reads back whole.
export function storedExtract(extract: string, flagged: { reason: string } | null): string {
  if (flagged === null) return LOOKS_FLAGGED.test(extract) ? `\\${extract}` : extract
  const reason = flagged.reason.replace(/\[/g, '(').replace(/\]/g, ')')
  return cut(`[flagged: ${reason}] ${extract}`, STORED_EXTRACT_MAX)
}

// The extract and the flag apart again, as the merge input takes them.
export function readStoredExtract(stored: string): { extract: string; flagged: { reason: string } | null } {
  const match = FLAG.exec(stored)
  const plain = ESCAPED.test(stored) ? stored.slice(1) : stored
  const text = cut(match ? match[2]! : plain, EXTRACT_MAX)
  return {
    // A long reason can leave only blank text of the extract inside the 600 characters.
    extract: text.trim() === '' ? '(the extract was cut)' : text,
    flagged: match ? { reason: match[1]! } : null,
  }
}
