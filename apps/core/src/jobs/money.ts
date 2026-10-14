export interface Price {
  inputMicros: bigint
  outputMicros: bigint
  cacheReadMicros: bigint
  cacheWriteMicros: bigint
}
export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

const MILLION = 1_000_000n

// Round half up for non-negative numbers. Amounts never go negative (the database checks it too).
const divideRound = (numerator: bigint, denominator: bigint): bigint =>
  (numerator * 2n + denominator) / (denominator * 2n)

// Prices are millionths of a US dollar per million tokens, so tokens times price over a million
// is millionths of a dollar. One rounding for the whole call, not one per token class.
export function usdMicros(price: Price, usage: Usage): bigint {
  const total =
    BigInt(usage.inputTokens) * price.inputMicros +
    BigInt(usage.outputTokens) * price.outputMicros +
    BigInt(usage.cacheReadTokens) * price.cacheReadMicros +
    BigInt(usage.cacheWriteTokens) * price.cacheWriteMicros
  return divideRound(total, MILLION)
}

// The rate is rupees per dollar in millionths.
export function inrMicros(usd: bigint, rateMicros: bigint): bigint {
  return divideRound(usd * rateMicros, MILLION)
}
