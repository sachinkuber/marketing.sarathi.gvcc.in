'use client'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

// The invite email links to /accept-invite?token=...; the screen lives at /invite/{token}.
export default function AcceptInvite() {
  const router = useRouter()
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token')
    router.replace(token && /^[A-Za-z0-9_-]+$/.test(token) ? `/invite/${token}` : '/sign-in')
  }, [router])
  return <p className="page muted">Opening your invite…</p>
}
