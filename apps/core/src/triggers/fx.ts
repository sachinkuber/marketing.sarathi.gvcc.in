// The USD to INR rate for a day. FxSource is a port: the European Central Bank's daily reference file in
// production, a fixed stand-in in tests.
export interface FxRate {
  rateDate: string
  // INR per one USD, in millionths.
  rateMicros: bigint
  source: string
}

export interface FxSource {
  // `signal` aborts the request: the caller's budget for the whole duty.
  fetchUsdInr(date: string, signal?: AbortSignal): Promise<FxRate>
}

// Hard-coded: the address never comes from a request, a setting or the document.
export const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'
export const FX_TIMEOUT_MS = 10_000
const MAX_DOCUMENT_CHARS = 200_000

export type FxFailure = 'timeout' | 'aborted' | 'fetch_failed' | 'http_status' | 'bad_document'

// The message of a failure never carries the response or the address: the code says what went wrong.
function failure(code: FxFailure): Error {
  return Object.assign(new Error(`exchange rate unavailable: ${code}`), { name: 'FxSourceError', code })
}

interface Decimal {
  digits: bigint
  scale: number
}

// A plain decimal string only (digits, optionally a point and digits): no sign, exponent, space or separator.
function decimalOf(text: string | undefined): Decimal {
  if (text === undefined || !/^\d+(\.\d+)?$/.test(text)) throw failure('bad_document')
  const [whole, fraction = ''] = text.split('.') as [string, string?]
  return { digits: BigInt(whole + fraction), scale: fraction.length }
}

function rateOf(cubes: string, currency: string): Decimal {
  for (const tag of cubes.match(/<Cube\b[^>]*>/g) ?? []) {
    const code = /\bcurrency\s*=\s*(['"])([A-Za-z]+)\1/.exec(tag)?.[2]
    if (code !== currency) continue
    const rate = /\brate\s*=\s*(['"])([^'"]*)\1/.exec(tag)?.[2]
    const value = decimalOf(rate)
    if (value.digits <= 0n) throw failure('bad_document')
    return value
  }
  throw failure('bad_document')
}

// round(inr / usd x 1e6), halves up, in integers on the decimal strings: no floating point anywhere.
export function parseEcb(text: string): { rateDate: string; rateMicros: bigint } {
  const rateDate = /<Cube\b[^>]*\btime\s*=\s*(['"])(\d{4}-\d{2}-\d{2})\1/.exec(text)?.[2]
  if (!rateDate || Number.isNaN(Date.parse(`${rateDate}T00:00:00Z`))) throw failure('bad_document')
  const usd = rateOf(text, 'USD')
  const inr = rateOf(text, 'INR')
  // (inr.digits / 10^inr.scale) / (usd.digits / 10^usd.scale) x 1e6
  const numerator = inr.digits * 10n ** BigInt(usd.scale) * 1_000_000n
  const denominator = usd.digits * 10n ** BigInt(inr.scale)
  const rateMicros = (2n * numerator + denominator) / (2n * denominator)
  if (rateMicros <= 0n) throw failure('bad_document')
  return { rateDate, rateMicros }
}

export function ecbFxSource(fetchFn: typeof fetch = fetch, timeoutMs: number = FX_TIMEOUT_MS): FxSource {
  return {
    async fetchUsdInr(_date?: string, outer?: AbortSignal): Promise<FxRate> {
      const own = AbortSignal.timeout(timeoutMs)
      const signal = outer ? AbortSignal.any([own, outer]) : own
      let text: string
      try {
        const res = await fetchFn(ECB_URL, {
          signal,
          redirect: 'error',
          headers: { accept: 'application/xml' },
        })
        if (!res.ok) throw failure('http_status')
        text = await res.text()
      } catch (error) {
        if ((error as { code?: unknown }).code === 'http_status') throw error
        throw failure(outer?.aborted ? 'aborted' : own.aborted ? 'timeout' : 'fetch_failed')
      }
      if (text.length > MAX_DOCUMENT_CHARS) throw failure('bad_document')
      return { ...parseEcb(text), source: 'ecb' }
    },
  }
}

// For tests: a fixed rate, a count of calls, and failures on demand.
export class StandInFxSource implements FxSource {
  calls = 0
  failures = 0
  message = 'stand-in rate source down'
  // When true a call never answers on its own; it rejects only when its signal aborts (a hung source).
  hang = false
  aborted = false
  constructor(private readonly rateMicros: bigint) {}

  failNext(times: number): void {
    this.failures = times
  }

  async fetchUsdInr(date: string, signal?: AbortSignal): Promise<FxRate> {
    this.calls += 1
    if (this.hang) {
      return new Promise<FxRate>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          this.aborted = true
          reject(new Error('aborted'))
        })
      })
    }
    if (this.failures > 0) {
      this.failures -= 1
      throw new Error(this.message)
    }
    return { rateDate: date, rateMicros: this.rateMicros, source: 'stand-in' }
  }
}
