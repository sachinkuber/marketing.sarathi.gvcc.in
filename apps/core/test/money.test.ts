import { describe, expect, it } from 'vitest'
import { inrMicros, usdMicros } from '../src/jobs/money.ts'

const price = {
  inputMicros: 4_000_000n,
  outputMicros: 20_000_000n,
  cacheReadMicros: 200_000n,
  cacheWriteMicros: 5_000_000n,
}

describe('costs in millionths', () => {
  it('prices tokens at the per-million rate', () => {
    // 1,000 input at $4/M = $0.004; 500 output at $20/M = $0.010
    expect(
      usdMicros(price, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ).toBe(14_000n)
  })

  it('includes cache reads and writes', () => {
    // 1,000,000 cache reads at $0.20/M = $0.20; 100,000 cache writes at $5/M = $0.50
    expect(
      usdMicros(price, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 100_000,
      }),
    ).toBe(700_000n)
  })

  it('rounds half up and never produces a negative or fractional amount', () => {
    // 1 token at $4/M = 4 micros exactly; 1 token at $0.2/M = 0.2 micro, rounds to 0; 3 tokens = 0.6, rounds to 1
    expect(
      usdMicros(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0 }),
    ).toBe(0n)
    expect(
      usdMicros(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 0 }),
    ).toBe(1n)
    expect(
      usdMicros(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ).toBe(0n)
  })

  it('converts to rupees with the rate in millionths, rounding half up', () => {
    // 14,000 micro-dollars at 83.5 rupees per dollar
    expect(inrMicros(14_000n, 83_500_000n)).toBe(1_169_000n)
    // 1 micro-dollar at 83.5 = 83.5, rounds to 84
    expect(inrMicros(1n, 83_500_000n)).toBe(84n)
  })

  it('has no precision loss at large amounts', () => {
    expect(inrMicros(10_000_000_000_000n, 83_500_000n)).toBe(835_000_000_000_000n)
  })
})
