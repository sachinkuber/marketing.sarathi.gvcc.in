'use client'
import { api } from '../api/client'
import { homeReply } from '../api/schemas'
import { useLoad } from '../api/use-load'
import { canSeeDeadLetters } from '../frame/gating'
import { LoadError } from '../frame/LoadError'
import { useShell } from '../frame/shell-context'
import { HomeBlocks } from './HomeBlocks'

export function BrandHome({ brandId }: { brandId: string }) {
  const { session } = useShell()
  const loaded = useLoad(() => api(homeReply, 'GET', `/brands/${brandId}/home`), brandId)
  return (
    <main id="content" className="page">
      <div className="page-head">
        <div>
          <h1>Home</h1>
          <p>Results and progress first; what waits for you and any problems follow.</p>
        </div>
      </div>
      {loaded.state === 'loading' ? <p className="muted">Loading…</p> : null}
      {loaded.state === 'error' ? (
        <LoadError what="the home figures" error={loaded.error} onRetry={loaded.retry} />
      ) : null}
      {loaded.state === 'ready' ? (
        <HomeBlocks
          brandId={brandId}
          home={loaded.data}
          now={Date.now()}
          canSeeDeadLetters={canSeeDeadLetters(session)}
        />
      ) : null}
    </main>
  )
}
