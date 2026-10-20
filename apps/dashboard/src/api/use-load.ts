'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

export type Loaded<T> =
  | { state: 'loading'; data: null; error: null }
  | { state: 'ready'; data: T; error: null }
  | { state: 'error'; data: null; error: Error }

// Runs `load` on mount and whenever `key` changes; `retry` runs it again. The latest call wins.
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> & { retry: () => void } {
  const [result, setResult] = useState<Loaded<T>>({ state: 'loading', data: null, error: null })
  const [attempt, setAttempt] = useState(0)
  const latest = useRef(load)
  latest.current = load
  useEffect(() => {
    let live = true
    setResult({ state: 'loading', data: null, error: null })
    latest.current().then(
      (data) => live && setResult({ state: 'ready', data, error: null }),
      (error: unknown) =>
        live &&
        setResult({
          state: 'error',
          data: null,
          error: error instanceof Error ? error : new Error('failed'),
        }),
    )
    return () => {
      live = false
    }
  }, [key, attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { ...result, retry }
}
