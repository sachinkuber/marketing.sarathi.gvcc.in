export const JOB_CLASSES = ['interactive', 'publishing', 'production', 'bulk'] as const
export type JobClass = (typeof JOB_CLASSES)[number]

export interface ClassSettings {
  readonly queue: string
  readonly deadLetter: string
  // The allowed gap between heartbeats; the library refreshes inside it.
  readonly heartbeatSeconds: number
  readonly expireInSeconds: number
  // The library counts retries, not attempts: attempts = retryLimit + 1.
  readonly retryLimit: number
  readonly retryDelaySeconds: number
  readonly notify: boolean
  readonly pollingIntervalSeconds: number
  readonly brandCap: number
}

// Spec 9.3 and 9.2. The dead-letter queue is one per class (architecture 7.1).
export const CLASS_SETTINGS: Record<JobClass, ClassSettings> = {
  interactive: {
    queue: 'job-interactive',
    deadLetter: 'dead-interactive',
    heartbeatSeconds: 60,
    expireInSeconds: 300,
    retryLimit: 2,
    retryDelaySeconds: 15,
    notify: true,
    pollingIntervalSeconds: 2,
    brandCap: 2,
  },
  publishing: {
    queue: 'job-publishing',
    deadLetter: 'dead-publishing',
    heartbeatSeconds: 60,
    expireInSeconds: 600,
    retryLimit: 4,
    retryDelaySeconds: 15,
    notify: true,
    pollingIntervalSeconds: 2,
    brandCap: 2,
  },
  production: {
    queue: 'job-production',
    deadLetter: 'dead-production',
    heartbeatSeconds: 90,
    expireInSeconds: 1800,
    retryLimit: 2,
    retryDelaySeconds: 30,
    notify: false,
    pollingIntervalSeconds: 2,
    brandCap: 3,
  },
  bulk: {
    queue: 'job-bulk',
    deadLetter: 'dead-bulk',
    heartbeatSeconds: 90,
    expireInSeconds: 7200,
    retryLimit: 2,
    retryDelaySeconds: 60,
    notify: false,
    pollingIntervalSeconds: 2,
    brandCap: 1,
  },
}

// Spec 9.3: the per-process limit is the cap divided between the worker processes for the class; a cap
// smaller than the number of processes is not allowed. Rounding down keeps the total at or under the cap.
export function perProcessCap(cap: number, processes: number): number {
  if (!Number.isInteger(processes) || processes < 1) {
    throw new Error('processes must be a whole number of at least 1')
  }
  if (cap < processes)
    throw new Error(`a cap of ${cap} is smaller than the number of processes (${processes})`)
  return Math.floor(cap / processes)
}
