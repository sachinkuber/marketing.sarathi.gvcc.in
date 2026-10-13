import { createTestDatabase, type TestDatabase } from '@mkt/db/testing'
import { installQueue } from './install.ts'

export async function createQueueTestDatabase(): Promise<TestDatabase> {
  const db = await createTestDatabase()
  try {
    await installQueue(db.urlFor('migration'))
  } catch (error) {
    await db.drop()
    throw error
  }
  return db
}
