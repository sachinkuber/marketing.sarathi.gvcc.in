'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

export type Loaded<T> =
  | { state: 'loading'; data: null; error: null }
  | { state: 'ready'; data: T; error: null }
  | { state: 'error'; data: null; error: Error }

// Runs `load` on mount and whenever `key` changes; `retry` runs it again from the loading state. `refresh` runs it
// again in place: what is shown stays until the new data arrives, and a failed refresh keeps it (an error shows only
// when there was nothing to keep). The latest call wins.
export function useLoad<T>(
  load: () => Promise<T>,
  key: string,
): Loaded<T> & { retry: () => void; refresh: () => Promise<void> } {
  const [result, setResult] = useState<Loaded<T>>({ state: 'loading', data: null, error: null })
  const [attempt, setAttempt] = useState(0)
  const latest = useRef(load)
  latest.current = load
  // Counts the calls; an answer is used only while its call is still the latest (and the screen still mounted).
  const calls = useRef(0)
  useEffect(() => {
    const call = (calls.current += 1)
    setResult({ state: 'loading', data: null, error: null })
    latest.current().then(
      (data) => calls.current === call && setResult({ state: 'ready', data, error: null }),
      (error: unknown) =>
        calls.current === call &&
        setResult({
          state: 'error',
          data: null,
          error: error instanceof Error ? error : new Error('failed'),
        }),
    )
    return () => {
      calls.current += 1
    }
  }, [key, attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  const refresh = useCallback(async () => {
    const call = (calls.current += 1)
    try {
      const data = await latest.current()
      if (calls.current === call) setResult({ state: 'ready', data, error: null })
    } catch (error) {
      if (calls.current !== call) return
      setResult((now) =>
        now.state === 'ready'
          ? now
          : { state: 'error', data: null, error: error instanceof Error ? error : new Error('failed') },
      )
    }
  }, [])
  return { ...result, retry, refresh }
}
