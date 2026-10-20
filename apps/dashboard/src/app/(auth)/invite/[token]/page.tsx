'use client'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { signIn } from '../../../../api/auth'
import { publicApi } from '../../../../api/client'
import { inviteAcceptReply, inviteLookupReply } from '../../../../api/schemas'
import { AuthShell } from '../../../../auth/AuthShell'
import { InviteForm, type InviteState } from '../../../../auth/InviteForm'

export default function InvitePage() {
  const { token } = useParams<{ token: string }>()
  const router = useRouter()
  const [state, setState] = useState<InviteState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    publicApi(inviteLookupReply, 'POST', '/invites/lookup', { token }).then(
      (invite) => setState({ kind: 'ready', invite }),
      () => setState({ kind: 'invalid' }),
    )
  }, [token])

  const submit = async (name: string, password: string) => {
    if (state.kind !== 'ready') return
    setBusy(true)
    setError(null)
    try {
      await publicApi(inviteAcceptReply, 'POST', '/invites/accept', { token, name, password })
      const result = await signIn(state.invite.email, password)
      router.push(result.kind === 'signed_in' && !result.session.enrolmentRequired ? '/' : '/enrol')
    } catch {
      setError('The invite could not be accepted. Check the password rules and try again.')
      setBusy(false)
    }
  }
  return (
    <AuthShell>
      <InviteForm state={state} busy={busy} error={error} onSubmit={(n, p) => void submit(n, p)} />
    </AuthShell>
  )
}
