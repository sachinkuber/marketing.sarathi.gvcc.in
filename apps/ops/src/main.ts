import { failureLine, prepareFromEnv } from './prepare.ts'

// The ops image's entry point: `docker compose run --rm ops <command>`. Values come from the environment.
const commands: Record<string, () => Promise<void>> = {
  prepare: () => prepareFromEnv(process.env),
}

const name = process.argv[2] ?? ''
const command = commands[name]
if (!command) {
  process.stderr.write(`Unknown command "${name}". Commands: ${Object.keys(commands).join(', ')}.\n`)
  process.exit(2)
}
command().catch((error: unknown) => {
  process.stderr.write(failureLine(error))
  process.exit(1)
})
