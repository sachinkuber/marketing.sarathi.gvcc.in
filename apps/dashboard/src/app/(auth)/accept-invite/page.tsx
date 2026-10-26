'use client'
import { useEffect, useState } from 'react'
import { InviteScreen } from '../../../auth/InviteScreen'

// The invite email links to /accept-invite?token=... The token is read once and removed from the address bar
// and history, then held in memory only.
export default function AcceptInvite() {
  const [token, setToken] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    const found = new URLSearchParams(window.location.search).get('token')
    window.history.replaceState(null, '', window.location.pathname)
    // Development runs this effect twice; the second pass finds the address already cleaned and keeps the first.
    setToken((previous) => previous ?? (found && /^[A-Za-z0-9_-]+$/.test(found) ? found : null))
  }, [])
  if (token === undefined) return <p className="page muted">Opening your invite…</p>
  return <InviteScreen token={token} />
}
