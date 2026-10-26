// Formatting shared by the screens. Money arrives as a string of millionths and is formatted by cutting the
// string, never through a floating-point number, so large sums keep every digit.

const CURRENCY = {
  USD: { symbol: '$', indian: false },
  INR: { symbol: '₹', indian: true },
} as const

function group(digits: string, indian: boolean): string {
  if (!indian) return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  // Indian grouping: the last three digits, then pairs (12,34,56,789).
  const last = digits.slice(-3)
  const rest = digits.slice(0, -3)
  return rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last}` : last
}

export function formatMicros(micros: string, currency: keyof typeof CURRENCY): string {
  const { symbol, indian } = CURRENCY[currency]
  const padded = micros.padStart(7, '0')
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, '')
  return `${symbol}${group(whole, indian)}.${padded.slice(-6)}`
}

// Both currencies, each from its own millionths as the core stored them: the rupee figure is never worked out
// from the dollar one here, so the two cannot drift apart by rounding.
export function formatMoney(money: { usdMicros: string; inrMicros: string }): string {
  return `${formatMicros(money.usdMicros, 'USD')} · ${formatMicros(money.inrMicros, 'INR')}`
}

// How long something has waited: hours up to two days, then days.
export function waitedFor(since: string, now: number): string {
  const hours = Math.max(0, Math.floor((now - Date.parse(since)) / 3_600_000))
  if (hours < 1) return 'under an hour'
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  return `${Math.floor(hours / 24)} days`
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}

// "social_post" reads "Social post".
export function words(code: string): string {
  const spaced = code.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const STATE_LABELS: Record<string, string> = {
  draft: 'Draft',
  in_checks: 'In checks',
  check_failed: 'Checks failed',
  awaiting_approval: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  superseded: 'Replaced by a newer version',
  invalidated: 'Invalidated',
  scheduled: 'Scheduled',
  publish_unknown: 'Publishing not confirmed',
  published: 'Published',
  withdrawn: 'Withdrawn',
}

export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? words(state)
}
