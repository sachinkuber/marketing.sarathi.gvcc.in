'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { codeMessage, enableTwoFactor, verifyTotp } from '../../../api/auth'
import { ApiError } from '../../../api/client'
import { AuthShell, ErrorLine } from '../../../auth/AuthShell'
import { BackupCodes } from '../../../auth/BackupCodes'
import { EnrolSetup } from '../../../auth/EnrolSetup'

type Step =
  | { kind: 'password' }
  | { kind: 'scan'; secret: string; totpUri: string; backupCodes: string[] }
  | { kind: 'codes'; backupCodes: string[] }

export default function EnrolPage() {
  const router = useRouter()
  const [step, setStep] = useState<Step>({ kind: 'password' })
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      const made = await enableTwoFactor(password)
      setPassword('')
      setStep({ kind: 'scan', ...made })
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.push('/sign-in')
      setError('That password is not right.')
    } finally {
      setBusy(false)
    }
  }
  const verify = async (code: string, backupCodes: string[]) => {
    setBusy(true)
    setError(null)
    try {
      await verifyTotp(code)
      setStep({ kind: 'codes', backupCodes })
    } catch (e) {
      setError(codeMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <AuthShell>
      <div>
        <h1>Set up your second factor</h1>
        <p className="muted">
          Required before you can use the platform. No other screen can be reached until this is finished.
        </p>
      </div>
      {step.kind === 'password' ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault()
            void start()
          }}
        >
          <div className="field">
            <label htmlFor="pw">Confirm your password</label>
            <input
              className="input"
              id="pw"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <ErrorLine error={error} />
          <button className="btn primary block" type="submit" disabled={busy}>
            Continue
          </button>
        </form>
      ) : null}
      {step.kind === 'scan' ? (
        <EnrolSetup
          totpUri={step.totpUri}
          secret={step.secret}
          busy={busy}
          error={error}
          onVerify={(code) => void verify(code, step.backupCodes)}
        />
      ) : null}
      {step.kind === 'codes' ? (
        <BackupCodes codes={step.backupCodes} onContinue={() => router.push('/')} />
      ) : null}
    </AuthShell>
  )
}
