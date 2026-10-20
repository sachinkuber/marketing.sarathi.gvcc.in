'use client'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { loadSession } from '../api/session'
import { Empty } from '../frame/Empty'
import { LoadError } from '../frame/LoadError'
import { useLoad } from '../api/use-load'

// Replaced by Home and "all brands" in the next task. Until then it sends a person to their brand.
export default function Front() {
  const router = useRouter()
  const loaded = useLoad(loadSession, 'session')
  useEffect(() => {
    if (loaded.state !== 'ready') return
    const first = loaded.data.memberships[0]
    if (loaded.data.enrolmentRequired) router.replace('/enrol')
    else if (first) router.replace(`/b/${first.brandId}`)
  }, [loaded.state, loaded.data, router])
  if (loaded.state === 'error')
    return (
      <div className="page">
        <LoadError what="your account" error={loaded.error} onRetry={loaded.retry} />
      </div>
    )
  if (loaded.state === 'ready' && loaded.data.memberships.length === 0 && !loaded.data.enrolmentRequired) {
    return (
      <main className="page">
        <Empty title="No brand yet">You are not a member of any brand.</Empty>
      </main>
    )
  }
  return <p className="page muted">Loading…</p>
}
