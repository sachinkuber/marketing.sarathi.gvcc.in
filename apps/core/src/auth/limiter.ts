export interface LimiterOptions {
  maxFailures: number
  windowMs: number
  lockMs: number
  now?: () => number
}

interface Entry {
  failures: number[]
  lockedUntil: number
}

const MAX_ENTRIES = 10_000

// Held in memory: it resets when the service restarts (plan 2b, decision 1).
export class AttemptLimiter {
  private readonly entries = new Map<string, Entry>()
  private readonly options: LimiterOptions
  private readonly now: () => number

  constructor(options: LimiterOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  // Milliseconds the key is still locked for; 0 when it is free.
  check(key: string): number {
    const entry = this.entries.get(key)
    if (!entry) return 0
    return Math.max(0, entry.lockedUntil - this.now())
  }

  fail(key: string): void {
    const now = this.now()
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 }
    entry.failures = entry.failures.filter((at) => now - at < this.options.windowMs)
    entry.failures.push(now)
    if (entry.failures.length >= this.options.maxFailures) {
      entry.lockedUntil = now + this.options.lockMs
      entry.failures = []
    }
    this.entries.set(key, entry)
    if (this.entries.size > MAX_ENTRIES) this.sweep(now)
  }

  succeed(key: string): void {
    this.entries.delete(key)
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      const idle = entry.failures.every((at) => now - at >= this.options.windowMs)
      if (idle && entry.lockedUntil <= now) this.entries.delete(key)
    }
  }
}

export function attemptKey(path: string, identifier: string): string {
  return `${path}:${identifier.trim().toLowerCase()}`
}
