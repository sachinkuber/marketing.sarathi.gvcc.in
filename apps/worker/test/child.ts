import { httpCoreClient } from '../src/core-client.ts'
import { startWorker } from '../src/main.ts'
import { standInModel } from '../src/standin.ts'
import type { JobHandler } from '../src/runner.ts'

const env = process.env as Record<string, string>

const threeSteps: JobHandler = async (ctx) => {
  const texts: string[] = []
  for (const step of ['step1', 'step2', 'step3']) {
    const out = await ctx.modelStep(step, {
      model: 'test-model',
      messages: [{ role: 'user', content: step }],
      maxTokens: 10,
    })
    texts.push(out.text)
  }
  return { type: 'test.three_steps', result: { texts } }
}

await startWorker({
  core: httpCoreClient(env.CORE_URL!, env.WORKER_SECRET!),
  model: standInModel({
    logFile: env.MODEL_LOG!,
    crashBeforeReplyOn: env.CRASH_BEFORE_REPLY_ON,
    crashAfterReplyOn: env.CRASH_AFTER_REPLY_ON,
    delayMs: 200,
  }),
  handlers: { 'test.three_steps': threeSteps },
  queueUrl: env.QUEUE_DATABASE_URL!,
  workerId: env.WORKER_ID ?? 'child',
  classes: ['interactive'],
  processesPerClass: 1,
  superviseIntervalSeconds: 1,
})
process.send?.('ready')
setInterval(() => {}, 1 << 30)
