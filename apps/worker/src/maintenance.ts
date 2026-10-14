import type { JobClass, Queue } from '@mkt/queue'
import type { CoreClient } from './core-client.ts'

export interface Maintenance {
  stop(): void
}

// A first estimate of how long a job of each class may wait before the watchdog reports it, to be tuned
// with the first real load. One line, here, so the numbers are not scattered.
export const DEFAULT_MAX_WAIT_SECONDS: Record<JobClass, number> = {
  interactive: 60,
  publishing: 120,
  production: 900,
  bulk: 3600,
}

// Until n8n's scheduled trigger exists (milestone 6): sweep model calls, and report what the watchdog sees.
export function startMaintenance(options: {
  core: CoreClient
  queue: Queue
  intervalSeconds: number
  maxWaitSeconds: Record<JobClass, number>
  log: (line: Record<string, unknown>) => void
}): Maintenance {
  // A tick that is still running is not started again on top of itself.
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const swept = await options.core.reconcile()
      const seen = await options.queue.watchdog(new Date(), { maxWaitSeconds: options.maxWaitSeconds })
      options.log({
        event: 'maintenance',
        marked_unknown: swept.marked,
        waiting_too_long: seen.waiting.length,
        running_too_long: seen.running.length,
      })
    } catch (error) {
      options.log({
        event: 'maintenance_failed',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void tick(), options.intervalSeconds * 1000)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
