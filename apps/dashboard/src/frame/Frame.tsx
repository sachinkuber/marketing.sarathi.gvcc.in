'use client'
import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { z } from 'zod'
import { signOut } from '../api/auth'
import { api } from '../api/client'
import { brandReply, brandsReply, statusReply } from '../api/schemas'
import { roleIn } from '../api/session'
import { useLoad } from '../api/use-load'
import { FrameContext } from './frame-context'
import { switcherBrands } from './gating'
import { LoadError } from './LoadError'
import { SideMenu } from './SideMenu'
import { useShell } from './shell-context'
import { StatusBanner } from './StatusBanner'
import { TopBar } from './TopBar'

const frameData = async (brandId: string, platformOwner: boolean) => {
  const [brand, status, brands] = await Promise.all([
    api(brandReply, 'GET', `/brands/${brandId}`),
    api(statusReply, 'GET', `/brands/${brandId}/status`),
    platformOwner ? api(brandsReply, 'GET', '/brands') : Promise.resolve(null),
  ])
  return { brand, status, brands: brands?.brands ?? null }
}

// The frame around every screen of one brand: top bar, side menu and status banner. The session and the
// overdue pop-up belong to the shell around it, so they are the same on every screen.
export function Frame({ brandId, children }: { brandId: string; children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { session, overdue } = useShell()
  const loaded = useLoad(() => frameData(brandId, session.platformOwner), brandId)
  const [status, setStatus] = useState<z.infer<typeof statusReply> | null>(null)

  // A screen that changed the kill switch or shadow mode asks for this at once. A failed read changes nothing:
  // the poll below tries again.
  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api(statusReply, 'GET', `/brands/${brandId}/status`))
    } catch {
      // Left to the next poll.
    }
  }, [brandId])
  const frameValue = useMemo(() => ({ refreshStatus }), [refreshStatus])

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
  const { brand, brands } = loaded.data
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
  const overdueCount = overdue?.brands.find((b) => b.brandId === brandId)?.count ?? 0
  return (
    <div className="app">
      <SideMenu brandId={brandId} role={role} current={pathname} />
      <div className="col">
        <TopBar
          brandId={brandId}
          brandName={brand.name}
          userName={session.user.name}
          brands={switcherBrands(session, brands)}
          canStop={live.canStop}
          onSwitch={(target) => router.push(target ? `/b/${target}` : '/brands')}
          onSignOut={() =>
            void signOut().then(
              () => router.push('/sign-in'),
              () => router.push('/sign-in'),
            )
          }
        />
        <StatusBanner brandId={brandId} brandName={brand.name} status={live} overdueCount={overdueCount} />
        <FrameContext value={frameValue}>{children}</FrameContext>
      </div>
    </div>
  )
}
