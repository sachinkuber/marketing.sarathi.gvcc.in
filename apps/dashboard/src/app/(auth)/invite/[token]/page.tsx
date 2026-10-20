'use client'
import { useParams } from 'next/navigation'
import { InviteScreen } from '../../../../auth/InviteScreen'

export default function InvitePage() {
  const { token } = useParams<{ token: string }>()
  return <InviteScreen token={token} />
}
