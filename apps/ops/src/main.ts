import { alertFromEnv } from './alert.ts'
import { failureLine, prepareFromEnv } from './prepare.ts'
import { releaseFromEnv } from './release.ts'

// The ops image's entry point: `docker compose run --rm ops <command> [arguments]`. Values come from the
// environment, never from the arguments.
const commands: Record<string, (args: string[]) => Promise<void>> = {
  prepare: () => prepareFromEnv(process.env),
  alert: (args) => alertFromEnv(process.env, args),
}

const name = process.argv[2] ?? ''
// `release` maps its outcome to an exit code itself: 0 released, 2 refused, 3 unexpected.
if (name === 'release') process.exit(await releaseFromEnv(process.env, process.argv.slice(3)))
const command = commands[name]
if (!command) {
  process.stderr.write(
    `Unknown command "${name}". Commands: ${[...Object.keys(commands), 'release'].join(', ')}.\n`,
  )
  process.exit(2)
}
command(process.argv.slice(3)).catch((error: unknown) => {
  process.stderr.write(failureLine(error, `${name}_failed`))
  process.exit(1)
})
