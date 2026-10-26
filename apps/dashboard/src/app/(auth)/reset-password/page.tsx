'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { resetPassword } from '../../../api/auth'
import { AuthShell } from '../../../auth/AuthShell'
import { ResetForm } from '../../../auth/ResetForm'

// The page the recovery email links to (/reset-password?token=...). The token is read once, removed from the
// address bar and history, and held in memory only.
export default function ResetPasswordPage() {
  const router = useRouter()
  const token = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    // Development runs this effect twice; the second pass finds the address already cleaned and keeps the first.
    token.current = new URLSearchParams(window.location.search).get('token') ?? token.current
    window.history.replaceState(null, '', window.location.pathname)
  }, [])
  const submit = async (password: string) => {
    if (!token.current) {
      setError('This recovery link is not valid. Ask for a new one.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await resetPassword(token.current, password)
      router.push('/sign-in')
    } catch {
      setError('This recovery link no longer works, or the password is not allowed. Ask for a new link.')
      setBusy(false)
    }
  }
  return (
    <AuthShell>
      <meta name="referrer" content="no-referrer" />
      <ResetForm busy={busy} error={error} onSubmit={(p) => void submit(p)} />
    </AuthShell>
  )
}
