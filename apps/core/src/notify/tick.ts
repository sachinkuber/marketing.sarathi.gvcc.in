import { alertOnOperationalFindings, retryAlerts } from './alerts.ts'
import { deliverPending } from './notifications.ts'
import { errorName, type NotifyDeps } from './ports.ts'

export type Stage = 'findings' | 'retry' | 'deliver'

// The timer's notify work. Each stage has its own try/catch (the error name is logged, nothing else) so one
// failing stage cannot skip the others, and all three share one time budget: after it is used no new send
// is started. Returns the stages that failed.
export async function runNotifyTick(deps: NotifyDeps): Promise<Stage[]> {
  const startedAt = Date.now()
  const failed: Stage[] = []
  const stages: Array<[Stage, () => Promise<unknown>]> = [
    ['findings', () => alertOnOperationalFindings(deps.pool, deps, startedAt)],
    ['retry', () => retryAlerts(deps.pool, deps, 50, startedAt)],
    ['deliver', () => deliverPending(deps.pool, deps, 50, startedAt)],
  ]
  for (const [stage, run] of stages) {
    try {
      await run()
    } catch (error) {
      failed.push(stage)
      deps.logger?.error({ err: errorName(error), stage }, 'notify stage failed')
    }
  }
  return failed
}
