// A copy of `registrableDomain` in packages/shared/src/registrable-domain.ts, the rule the core and the worker
// use (rulings R33, R34): the dashboard does not depend on @mkt/shared. Keep the two in step; the dashboard
// test holds the same cases.

// Ruling R34: second-level labels under a two-letter country code that are part of the public suffix, so that
// "aztek.co.in", "shop.com.au" and "brand.co.uk" are compared whole. No public-suffix list (no dependency).
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'gen', 'firm', 'ind'])
// Shared hosting, where each tenant owns one name under the host's: "aztek.github.io" and "other.github.io" are
// two owners, so one more label is kept (otherwise another tenant could count as the brand's own site, R33).
const SHARED_HOSTING = new Set([
  'github.io',
  'gitlab.io',
  'blogspot.com',
  'wordpress.com',
  'wixsite.com',
  'weebly.com',
  'netlify.app',
  'vercel.app',
  'pages.dev',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'myshopify.com',
  'square.site',
])

// The registrable domain of a web address: lower case, without a leading "www.", its last two labels, or its
// last three when it ends in a two-letter country code under one of SECOND_LEVEL or in a SHARED_HOSTING suffix.
// Null for anything that is not a web address (a document, a file name), which therefore never counts as a host.
export function registrableDomain(address: string | null): string | null {
  if (address === null) return null
  let host: string
  try {
    host = new URL(address).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
  if (host === '') return null
  // An IP address is its own host.
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return host
  const labels = host.split('.')
  const tld = labels[labels.length - 1]!
  const second = labels[labels.length - 2]
  // A public suffix of two labels: a country's second level (co.in) or a shared host (github.io).
  const twoLabelSuffix =
    (tld.length === 2 && second !== undefined && SECOND_LEVEL.has(second)) ||
    SHARED_HOSTING.has(labels.slice(-2).join('.'))
  const keep = labels.length >= 3 && twoLabelSuffix ? 3 : 2
  return labels.slice(-keep).join('.')
}
