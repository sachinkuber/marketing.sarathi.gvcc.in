import { RELOAD_HINT } from './item-actions'

export { RELOAD_HINT }

// The read after a write. Its failure must not turn the write into a failure (the person would repeat it), so
// it answers null and the screen reports the write as done and asks for a reload (as ItemScreen does).
export async function readAfterWrite<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

// What a screen says after a write: the answer, plus the request to reload when the fresh read failed.
export function afterWrite(done: string, fresh: boolean): string {
  return fresh ? done : `${done} ${RELOAD_HINT}`
}
