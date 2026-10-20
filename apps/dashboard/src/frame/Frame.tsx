'use client'
import { usePathname, useRouter } from 'next/navigation'
import { z } from 'zod'
import { api } from '../api/client'
import { signOut } from '../api/auth'
import { brandReply, brandsReply, statusReply } from '../api/schemas'
import { loadSession, roleIn } from '../api/session'
import { useLoad } from '../api/use-load'
import { LoadError } from './LoadError'
import { OverdueWatcher, useOverdue } from './OverdueWatcher'
import { SideMenu } from './SideMenu'
import { StatusBanner } from './StatusBanner'
import { TopBar } from './TopBar'
import { useEffect, useState } from 'react'

const frameData = async (brandId: string) => {
  const session = await loadSession()
  const [brand, status, brands] = await Promise.all([
    api(brandReply, 'GET', `/brands/${brandId}`),
    api(statusReply, 'GET', `/brands/${brandId}/status`),
    session.platformOwner ? api(brandsReply, 'GET', '/brands') : Promise.resolve(null),
  ])
  return { session, brand, status, brands: brands?.brands ?? null }
}

// The frame around every brand screen: top bar, side menu, status banner and the overdue pop-up.
export function Frame({ brandId, children }: { brandId: string; children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const loaded = useLoad(() => frameData(brandId), brandId)
  const [status, setStatus] = useState<z.infer<typeof statusReply> | null>(null)
  const canApprove = loaded.state === 'ready' && loaded.data.status.canApprove
  const { overdue, reload } = useOverdue(brandId, canApprove)

  // The banner follows the kill switch and shadow mode while a person stays on a screen.
  useEffect(() => {
    if (loaded.state !== 'ready') return
    setStatus(loaded.data.status)
    const timer = setInterval(() => {
      api(statusReply, 'GET', `/brands/${brandId}/status`).then(setStatus, () => {})
    }, 60_000)
    return () => clearInterval(timer)
  }, [loaded.state, loaded.data, brandId])

  if (loaded.state === 'loading') return <p className="page muted">Loading…</p>
  if (loaded.state === 'error') {
    return (
      <div className="page">
        <LoadError what="this brand" error={loaded.error} onRetry={loaded.retry} />
      </div>
    )
  }
  const { session, brand, brands } = loaded.data
  const live = status ?? loaded.data.status
  const role = roleIn(session, brandId)
  if (!role) {
    return (
      <div className="page">
        <div className="callout warn" role="alert">
          <b>There is nothing at this address.</b>
        </div>
      </div>
    )
  }
  return (
    <div className="app">
      <SideMenu brandId={brandId} role={role} current={pathname} />
      <div className="col">
        <TopBar
          brandId={brandId}
          brandName={brand.name}
          userName={session.user.name}
          brands={brands}
          canStop={live.canStop}
          onSwitch={(target) => router.push(target ? `/b/${target}` : '/')}
          onSignOut={() =>
            void signOut().then(
              () => router.push('/sign-in'),
              () => router.push('/sign-in'),
            )
          }
        />
        <StatusBanner
          brandId={brandId}
          brandName={brand.name}
          status={live}
          overdueCount={overdue?.count ?? 0}
        />
        {children}
      </div>
      <OverdueWatcher brandId={brandId} overdue={overdue} reload={reload} />
    </div>
  )
}
