'use client'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { signOut } from '../api/auth'
import { loadSession } from '../api/session'
import { useLoad } from '../api/use-load'
import { AppBar } from './AppBar'
import { shouldPollOverdue, stopTarget, popupTarget } from './gating'
import { LoadError } from './LoadError'
import { OverdueWatcher, useOverdueAll } from './OverdueWatcher'
import { ShellContext } from './shell-context'

// Wraps every signed-in screen. It loads the session once, watches overdue approvals across all the person's
// brands, and owns the pop-up, so the pop-up opens over whatever screen they are on and no navigation
// removes it. A brand screen draws its own top bar and banners (Frame); the others get the AppBar.
export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const loaded = useLoad(loadSession, 'session')
  const session = loaded.state === 'ready' ? loaded.data : null
  const { overdue, reload } = useOverdueAll(session !== null && shouldPollOverdue(session))

  useEffect(() => {
    if (session?.enrolmentRequired) router.replace('/enrol')
  }, [session, router])

  if (loaded.state === 'loading') return <p className="page muted">Loading…</p>
  if (loaded.state === 'error') {
    return (
      <div className="page">
        <LoadError what="your account" error={loaded.error} onRetry={loaded.retry} />
      </div>
    )
  }
  if (!session || session.enrolmentRequired) return <p className="page muted">Loading…</p>
  const onBrandScreen = pathname.startsWith('/b/')
  const leave = () =>
    void signOut().then(
      () => router.push('/sign-in'),
      () => router.push('/sign-in'),
    )
  return (
    <ShellContext value={{ session, overdue, reload }}>
      <div id="app-root" inert={popupTarget(overdue) !== null}>
        {onBrandScreen ? (
          children
        ) : (
          <div className="col">
            <AppBar
              userName={session.user.name}
              overdue={overdue}
              stopHref={stopTarget(session)}
              onSignOut={leave}
            />
            {children}
          </div>
        )}
      </div>
      <OverdueWatcher overdue={overdue} reload={reload} />
    </ShellContext>
  )
}
