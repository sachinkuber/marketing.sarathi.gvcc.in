// Text an agent job's input carries (the questionnaire's, facts and rules'). It is only bounded: cut to the schema's
// limit without leaving half of a surrogate pair at the end, and dropped when nothing is left.
export const clip = (value: string, max: number): string | null => {
  const cut = value.slice(0, max)
  const safe = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
  return safe === '' ? null : safe
}

// A stored value (jsonb) as text: a string as it is, anything else as its JSON.
export const asText = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
