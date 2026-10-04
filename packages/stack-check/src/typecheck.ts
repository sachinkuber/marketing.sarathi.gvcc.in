// Not run. It exists so the compiler checks these libraries' types against each other.
import Anthropic from '@anthropic-ai/sdk'
import express from 'express'
import helmet from 'helmet'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { PgBoss } from 'pg-boss'
import { pino } from 'pino'
import { z } from 'zod'

export function build(databaseUrl: string) {
  const app = express()
  app.use(helmet())
  const input = z.strictObject({ name: z.string() })
  const db = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }),
  })
  const queue = new PgBoss({ connectionString: databaseUrl })
  const log = pino()
  const model = new Anthropic({ apiKey: 'placeholder-not-a-key' })
  return { app, input, db, queue, log, model }
}
