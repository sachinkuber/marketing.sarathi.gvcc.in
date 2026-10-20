'use client'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { api } from '../../api/client'
import { brandsReply } from '../../api/schemas'
import { useLoad } from '../../api/use-load'
import { Empty } from '../../frame/Empty'
import { LoadError } from '../../frame/LoadError'
import { useShell } from '../../frame/shell-context'

// Replaced by Home and "all brands" in the next task. Until then it sends a person to their first brand;
// the platform owner's list comes from GET /brands, which holds every brand for them.
export default function Front() {
  const router = useRouter()
  const { session } = useShell()
  const loaded = useLoad(() => api(brandsReply, 'GET', '/brands'), 'brands')
  const first = loaded.state === 'ready' ? loaded.data.brands[0] : undefined
  useEffect(() => {
    if (first) router.replace(`/b/${first.id}`)
  }, [first, router])
  if (loaded.state === 'error') {
    return (
      <div className="page">
        <LoadError what="your brands" error={loaded.error} onRetry={loaded.retry} />
      </div>
    )
  }
  if (loaded.state === 'ready' && !first) {
    return (
      <main className="page">
        <Empty title="No brand yet">
          {session.platformOwner ? 'No brand has been created yet.' : 'You are not a member of any brand.'}
        </Empty>
      </main>
    )
  }
  return <p className="page muted">Loading…</p>
}
