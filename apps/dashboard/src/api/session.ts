import type { z } from 'zod'
import { api, setCsrfToken } from './client'
import { sessionReply } from './schemas'
import type { MenuRole } from '../frame/SideMenu'

export type Session = z.infer<typeof sessionReply>

// Reads the signed-in person and keeps the request token for later writes.
export async function loadSession(): Promise<Session> {
  const session = await api(sessionReply, 'GET', '/session')
  setCsrfToken(session.csrfToken)
  return session
}

// The role that decides the side menu in one brand; a platform owner is `owner` everywhere.
export function roleIn(session: Session, brandId: string): MenuRole | null {
  if (session.platformOwner) return 'owner'
  return session.memberships.find((m) => m.brandId === brandId)?.role ?? null
}
