'use client'
import { useState } from 'react'
import { requestReset } from '../../../api/auth'
import { AuthShell } from '../../../auth/AuthShell'
import { RecoverForm } from '../../../auth/RecoverForm'

export default function RecoverPage() {
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (email: string) => {
    setBusy(true)
    setError(null)
    try {
      await requestReset(email)
      setSent(true)
    } catch {
      // The same answer for every address, including a refused request: nothing here says whether one exists.
      setSent(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <AuthShell>
      <RecoverForm sent={sent} busy={busy} error={error} onSubmit={(e) => void submit(e)} />
    </AuthShell>
  )
}
