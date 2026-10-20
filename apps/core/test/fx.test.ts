import { describe, expect, it } from 'vitest'
import { ECB_URL, ecbFxSource, parseEcb, StandInFxSource } from '../src/triggers/fx.ts'

const doc = (cubes: string, time = '2026-10-19') =>
  `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
<gesmes:subject>Reference rates</gesmes:subject>
<Cube><Cube time='${time}'>${cubes}</Cube></Cube></gesmes:Envelope>`

const SAMPLE = doc(
  "<Cube currency='USD' rate='1.0812'/><Cube currency='JPY' rate='160.1'/><Cube currency='INR' rate='90.1234'/>",
)

const reply = (body: string, init: ResponseInit = { status: 200 }) =>
  (async () => new Response(body, init)) as unknown as typeof fetch

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (error) {
    return `${(error as Error).name}:${(error as { code?: string }).code}`
  }
  return 'resolved'
}

describe('parsing the ECB reference document', () => {
  it('turns USD 1.0812 and INR 90.1234 into 83354976 micros, dated by the document', () => {
    expect(parseEcb(SAMPLE)).toEqual({ rateDate: '2026-10-19', rateMicros: 83354976n })
  })

  it('rounds exact halves up and values just under a half down, in integers', () => {
    // inr / usd x 1e6 is exactly 90123456.5, 1.5, 0.5, 2.5 and 90123456.4999...
    const cases: Array<[string, string, bigint]> = [
      ['1', '90.1234565', 90123457n],
      ['2', '180.246913', 90123457n],
      ['2', '0.000003', 2n],
      ['2', '0.000001', 1n],
      ['2', '0.000005', 3n],
      ['1', '90.1234564', 90123456n],
      ['1', '90.12345649', 90123456n],
    ]
    for (const [usd, inr, micros] of cases) {
      const cubes = `<Cube currency='USD' rate='${usd}'/><Cube currency='INR' rate='${inr}'/>`
      expect(parseEcb(doc(cubes)).rateMicros).toBe(micros)
    }
  })

  it('keeps full precision where a float would not', () => {
    const cubes = "<Cube currency='USD' rate='1'/><Cube currency='INR' rate='9007199254740993.1234565'/>"
    expect(parseEcb(doc(cubes)).rateMicros).toBe(9007199254740993123457n)
  })

  it('refuses a missing currency, a zero rate, a negative or non-numeric rate, and a missing date', () => {
    const bad = [
      doc("<Cube currency='USD' rate='1.0812'/>"),
      doc("<Cube currency='INR' rate='90.1'/>"),
      doc("<Cube currency='USD' rate='0'/><Cube currency='INR' rate='90.1'/>"),
      doc("<Cube currency='USD' rate='1.08'/><Cube currency='INR' rate='0.00'/>"),
      doc("<Cube currency='USD' rate='-1.08'/><Cube currency='INR' rate='90.1'/>"),
      doc("<Cube currency='USD' rate='abc'/><Cube currency='INR' rate='90.1'/>"),
      doc("<Cube currency='USD' rate='1e3'/><Cube currency='INR' rate='90.1'/>"),
      doc("<Cube currency='USD' rate='1.08'/><Cube currency='INR' rate=''/>"),
      doc("<Cube currency='USD' rate='1.08'/><Cube currency='INR' rate='90.1'/>", 'tomorrow'),
      'not xml at all',
    ]
    for (const text of bad) expect(() => parseEcb(text)).toThrow()
  })

  it('refuses a rate that would round to zero micros', () => {
    expect(() =>
      parseEcb(doc("<Cube currency='USD' rate='1000000'/><Cube currency='INR' rate='0.0000001'/>")),
    ).toThrow()
  })
})

describe('ecbFxSource', () => {
  it('fetches the fixed https address with a timeout signal and returns the rate', async () => {
    const seen: Array<[unknown, RequestInit | undefined]> = []
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      seen.push([url, init])
      return new Response(SAMPLE, { status: 200 })
    }) as unknown as typeof fetch
    const got = await ecbFxSource(fetchFn).fetchUsdInr('2026-10-20')
    expect(got).toEqual({ rateDate: '2026-10-19', rateMicros: 83354976n, source: 'ecb' })
    expect(seen).toHaveLength(1)
    expect(String(seen[0]![0])).toBe(ECB_URL)
    expect(ECB_URL).toMatch(/^https:\/\/www\.ecb\.europa\.eu\/.*eurofxref-daily\.xml$/)
    expect(seen[0]![1]?.signal).toBeInstanceOf(AbortSignal)
    expect(seen[0]![1]?.redirect).toBe('error')
  })

  it('fails on a non-200 answer, an unreadable document and a network error, with codes only', async () => {
    expect(await codeOf(ecbFxSource(reply('x', { status: 503 })).fetchUsdInr('2026-10-20'))).toBe(
      'FxSourceError:http_status',
    )
    expect(await codeOf(ecbFxSource(reply('<nope/>')).fetchUsdInr('2026-10-20'))).toBe(
      'FxSourceError:bad_document',
    )
    const down = (async () => {
      throw new Error('connect ECONNREFUSED secret-host')
    }) as unknown as typeof fetch
    const error = await ecbFxSource(down)
      .fetchUsdInr('2026-10-20')
      .catch((e: Error) => e)
    expect((error as Error).message).not.toContain('secret-host')
    expect((error as { code?: string }).code).toBe('fetch_failed')
  })

  it('gives up after the timeout', async () => {
    const hang = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch
    expect(await codeOf(ecbFxSource(hang, 20).fetchUsdInr('2026-10-20'))).toBe('FxSourceError:timeout')
  })
})

describe('StandInFxSource', () => {
  it('answers a fixed rate, and can be told to fail', async () => {
    const fx = new StandInFxSource(83_000_000n)
    expect(await fx.fetchUsdInr('2026-10-20')).toEqual({
      rateDate: '2026-10-20',
      rateMicros: 83_000_000n,
      source: 'stand-in',
    })
    fx.failNext(1)
    await expect(fx.fetchUsdInr('2026-10-20')).rejects.toThrow()
    expect(fx.calls).toBe(2)
  })
})
