'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { resetPassword } from '../../../api/auth'
import { AuthShell } from '../../../auth/AuthShell'
import { ResetForm } from '../../../auth/ResetForm'

// The page the recovery email links to (/reset-password?token=...).
export default function ResetPasswordPage() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (password: string) => {
    const token = new URLSearchParams(window.location.search).get('token')
    if (!token) {
      setError('This recovery link is not valid. Ask for a new one.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await resetPassword(token, password)
      router.push('/sign-in')
    } catch {
      setError('This recovery link no longer works, or the password is not allowed. Ask for a new link.')
      setBusy(false)
    }
  }
  return (
    <AuthShell>
      <ResetForm busy={busy} error={error} onSubmit={(p) => void submit(p)} />
    </AuthShell>
  )
}
