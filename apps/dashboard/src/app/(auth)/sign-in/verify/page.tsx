'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { codeMessage, verifyBackupCode, verifyTotp } from '../../../../api/auth'
import { safeNext } from '../../../../api/client'
import { AuthShell } from '../../../../auth/AuthShell'
import { VerifyForm } from '../../../../auth/VerifyForm'

export default function VerifyPage() {
  const router = useRouter()
  const [useBackup, setUseBackup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (code: string) => {
    setBusy(true)
    setError(null)
    try {
      await (useBackup ? verifyBackupCode(code) : verifyTotp(code))
      router.push(safeNext(new URLSearchParams(window.location.search).get('next')))
    } catch (e) {
      setError(codeMessage(e))
      setBusy(false)
    }
  }
  return (
    <AuthShell>
      <VerifyForm
        useBackup={useBackup}
        busy={busy}
        error={error}
        onSubmit={(c) => void submit(c)}
        onToggle={() => {
          setUseBackup((v) => !v)
          setError(null)
        }}
      />
    </AuthShell>
  )
}
