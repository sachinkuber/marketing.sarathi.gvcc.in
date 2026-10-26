'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { signIn, signInMessage } from '../../../api/auth'
import { safeNext } from '../../../api/client'
import { AuthShell } from '../../../auth/AuthShell'
import { SignInForm } from '../../../auth/SignInForm'

function nextParam(): string | null {
  return new URLSearchParams(window.location.search).get('next')
}

export default function SignInPage() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (email: string, password: string) => {
    setBusy(true)
    setError(null)
    try {
      const next = nextParam()
      const result = await signIn(email, password)
      if (result.kind === 'second_factor') {
        router.push(next ? `/sign-in/verify?next=${encodeURIComponent(safeNext(next))}` : '/sign-in/verify')
      } else if (result.session.enrolmentRequired) {
        router.push('/enrol')
      } else {
        router.push(safeNext(next))
      }
    } catch (e) {
      setError(signInMessage(e))
      setBusy(false)
    }
  }
  return (
    <AuthShell>
      <SignInForm busy={busy} error={error} onSubmit={(e, p) => void submit(e, p)} />
    </AuthShell>
  )
}
