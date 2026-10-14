import { describe, expect, it } from 'vitest'
import type { Queue } from '@mkt/queue'
import type { CoreClient } from '../src/core-client.ts'
import { startMaintenance } from '../src/maintenance.ts'

const queue = {
  watchdog: async () => ({ waiting: ['a', 'b'], running: ['c'] }),
  failedJobIds: async () => [] as string[],
} as unknown as Queue
const limits = { interactive: 60, publishing: 120, production: 900, bulk: 3600 }

describe('maintenance', () => {
  it('sweeps, reads the watchdog and logs the counts on each tick', async () => {
    const lines: Record<string, unknown>[] = []
    const core = { reconcile: async () => ({ marked: 4 }) } as unknown as CoreClient
    const m = startMaintenance({
      core,
      queue,
      intervalSeconds: 0.05,
      maxWaitSeconds: limits,
      log: (l) => lines.push(l),
    })
    await new Promise((r) => setTimeout(r, 200))
    m.stop()
    expect(lines[0]).toEqual({
      event: 'maintenance',
      marked_unknown: 4,
      waiting_too_long: 2,
      running_too_long: 1,
    })
  })

  it('logs a failure and keeps ticking', async () => {
    const lines: Record<string, unknown>[] = []
    let calls = 0
    const core = {
      reconcile: async () => {
        calls += 1
        throw new Error('core down')
      },
    } as unknown as CoreClient
    const m = startMaintenance({
      core,
      queue,
      intervalSeconds: 0.05,
      maxWaitSeconds: limits,
      log: (l) => lines.push(l),
    })
    await new Promise((r) => setTimeout(r, 250))
    m.stop()
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(lines.every((l) => l.event === 'maintenance_failed')).toBe(true)
  })

  it('reports a failed job that has no dead-letter copy to the core, and carries on past a refusal', async () => {
    const lines: Record<string, unknown>[] = []
    const reported: string[] = []
    const core = {
      reconcile: async () => ({ marked: 0 }),
      jobDead: async (id: string) => {
        if (id === 'bad') throw new Error('refused')
        reported.push(id)
      },
    } as unknown as CoreClient
    const failing = {
      watchdog: async () => ({ waiting: [], running: [] }),
      failedJobIds: async (c: string) => (c === 'interactive' ? ['bad', 'lost'] : []),
    } as unknown as Queue
    const m = startMaintenance({
      core,
      queue: failing,
      intervalSeconds: 0.05,
      maxWaitSeconds: limits,
      log: (l) => lines.push(l),
    })
    await new Promise((r) => setTimeout(r, 200))
    m.stop()
    expect(reported).toContain('lost')
    expect(lines.some((l) => l.event === 'dead_report_failed' && l.job_id === 'bad')).toBe(true)
    expect(lines.some((l) => l.event === 'maintenance')).toBe(true)
  })
})
