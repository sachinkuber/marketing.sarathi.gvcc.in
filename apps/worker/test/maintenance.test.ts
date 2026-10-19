import { describe, expect, it } from 'vitest'
import type { Queue } from '@mkt/queue'
import type { CoreClient } from '../src/core-client.ts'
import { startMaintenance } from '../src/maintenance.ts'

const queue = {
  watchdog: async () => ({ waiting: ['a', 'b'], running: ['c'] }),
  failedJobIds: async () => [] as string[],
} as unknown as Queue
const counts = { reminded: 1, overdue: 2, escalated: 3, failedBrands: 0 }
const approvalsTick = async () => counts
const limits = { interactive: 60, publishing: 120, production: 900, bulk: 3600 }

describe('maintenance', () => {
  it('sweeps, reads the watchdog and logs the counts on each tick', async () => {
    const lines: Record<string, unknown>[] = []
    const core = { reconcile: async () => ({ marked: 4 }), approvalsTick } as unknown as CoreClient
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
      approvalsTick,
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
    expect(
      lines.filter((l) => l.event !== 'approvals_tick').every((l) => l.event === 'maintenance_failed'),
    ).toBe(true)
  })

  it('reports a failed job that has no dead-letter copy to the core, and carries on past a refusal', async () => {
    const lines: Record<string, unknown>[] = []
    const reported: string[] = []
    const core = {
      reconcile: async () => ({ marked: 0 }),
      approvalsTick,
      // 'marked' is already known to the core: it is not reported again.
      unmarkedDead: async (ids: string[]) => ids.filter((id) => id !== 'marked'),
      jobDead: async (id: string) => {
        if (id === 'bad') throw new Error('refused')
        reported.push(id)
      },
    } as unknown as CoreClient
    const failing = {
      watchdog: async () => ({ waiting: [], running: [] }),
      failedJobIds: async (c: string) => (c === 'interactive' ? ['bad', 'lost', 'marked'] : []),
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
    expect(reported).not.toContain('marked')
    expect(lines.some((l) => l.event === 'dead_report_failed' && l.job_id === 'bad')).toBe(true)
    expect(lines.some((l) => l.event === 'maintenance')).toBe(true)
  })

  describe('the approvals tick', () => {
    const run = async (core: Partial<CoreClient>, q: Queue = queue, ms = 130) => {
      const lines: Record<string, unknown>[] = []
      const m = startMaintenance({
        core: core as CoreClient,
        queue: q,
        intervalSeconds: 0.1,
        maxWaitSeconds: limits,
        log: (l) => lines.push(l),
      })
      await new Promise((r) => setTimeout(r, ms))
      m.stop()
      return lines
    }

    it('is called once per maintenance tick and its counts are logged', async () => {
      let calls = 0
      const lines = await run({
        reconcile: async () => ({ marked: 0 }),
        approvalsTick: async () => {
          calls += 1
          return counts
        },
      })
      expect(calls).toBe(1)
      expect(lines).toContainEqual({
        event: 'approvals_tick',
        reminded: 1,
        overdue: 2,
        escalated: 3,
        failed_brands: 0,
      })
    })

    it('logs a failure by error name only and the other duties still ran', async () => {
      let reconciled = 0
      let watched = 0
      const lines = await run(
        {
          reconcile: async () => {
            reconciled += 1
            return { marked: 0 }
          },
          approvalsTick: async () => {
            throw new TypeError('http://10.0.0.1/secret body')
          },
        },
        {
          watchdog: async () => {
            watched += 1
            return { waiting: [], running: [] }
          },
          failedJobIds: async () => [],
        } as unknown as Queue,
      )
      expect(reconciled).toBe(1)
      expect(watched).toBe(1)
      expect(lines).toContainEqual({ event: 'approvals_tick_failed', error: 'TypeError' })
      expect(lines.some((l) => l.event === 'maintenance')).toBe(true)
      expect(JSON.stringify(lines)).not.toContain('10.0.0.1')
    })

    it('still runs when reconcile fails', async () => {
      let calls = 0
      const lines = await run({
        reconcile: async () => {
          throw new Error('core down')
        },
        approvalsTick: async () => {
          calls += 1
          return counts
        },
      })
      expect(calls).toBe(1)
      expect(lines.some((l) => l.event === 'maintenance_failed')).toBe(true)
    })

    it('is not started again while a tick is still running', async () => {
      let calls = 0
      await run(
        {
          reconcile: async () => ({ marked: 0 }),
          approvalsTick: async () => {
            calls += 1
            await new Promise((r) => setTimeout(r, 350))
            return counts
          },
        },
        queue,
        450,
      )
      expect(calls).toBe(1)
    })
  })

  describe('what is logged and when a tick may start again', () => {
    it('logs a failing first duty by error name only, and still runs the approvals tick', async () => {
      let ticked = 0
      const lines: Record<string, unknown>[] = []
      const m = startMaintenance({
        core: {
          reconcile: async () => {
            throw new TypeError('http://10.0.0.1/secret body')
          },
          approvalsTick: async () => {
            ticked += 1
            return counts
          },
        } as unknown as CoreClient,
        queue,
        intervalSeconds: 0.05,
        maxWaitSeconds: limits,
        log: (l) => lines.push(l),
      })
      await new Promise((r) => setTimeout(r, 120))
      m.stop()
      expect(ticked).toBeGreaterThanOrEqual(1)
      expect(lines).toContainEqual({ event: 'maintenance_failed', error: 'TypeError' })
      expect(JSON.stringify(lines)).not.toContain('secret')
    })

    it('logs a failed dead report by error name only', async () => {
      const lines: Record<string, unknown>[] = []
      const m = startMaintenance({
        core: {
          reconcile: async () => ({ marked: 0 }),
          approvalsTick,
          unmarkedDead: async (ids: string[]) => ids,
          jobDead: async () => {
            throw new Error('http://10.0.0.1/secret body')
          },
        } as unknown as CoreClient,
        queue: {
          watchdog: async () => ({ waiting: [], running: [] }),
          failedJobIds: async (c: string) => (c === 'interactive' ? ['x'] : []),
        } as unknown as Queue,
        intervalSeconds: 0.05,
        maxWaitSeconds: limits,
        log: (l) => lines.push(l),
      })
      await new Promise((r) => setTimeout(r, 120))
      m.stop()
      expect(lines).toContainEqual({ event: 'dead_report_failed', job_id: 'x', error: 'Error' })
      expect(JSON.stringify(lines)).not.toContain('secret')
    })

    it('clears busy even when the log callback throws', async () => {
      let ticked = 0
      const m = startMaintenance({
        core: {
          reconcile: async () => {
            ticked += 1
            return { marked: 0 }
          },
          approvalsTick,
        } as unknown as CoreClient,
        queue,
        intervalSeconds: 0.05,
        maxWaitSeconds: limits,
        log: () => {
          throw new Error('log sink down')
        },
      })
      await new Promise((r) => setTimeout(r, 300))
      m.stop()
      expect(ticked).toBeGreaterThanOrEqual(2)
    })
  })
})
