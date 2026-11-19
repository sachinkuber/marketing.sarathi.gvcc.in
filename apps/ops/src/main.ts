import { alertFromEnv } from './alert.ts'
import { failureLine, prepareFromEnv } from './prepare.ts'

// The ops image's entry point: `docker compose run --rm ops <command> [arguments]`. Values come from the
// environment, never from the arguments.
const commands: Record<string, (args: string[]) => Promise<void>> = {
  prepare: () => prepareFromEnv(process.env),
  alert: (args) => alertFromEnv(process.env, args),
}

const name = process.argv[2] ?? ''
const command = commands[name]
if (!command) {
  process.stderr.write(`Unknown command "${name}". Commands: ${Object.keys(commands).join(', ')}.\n`)
  process.exit(2)
}
command(process.argv.slice(3)).catch((error: unknown) => {
  process.stderr.write(failureLine(error, `${name}_failed`))
  process.exit(1)
})
