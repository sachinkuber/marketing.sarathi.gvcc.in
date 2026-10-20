'use client'
import { createContext, useContext } from 'react'
import type { Session } from '../api/session'
import type { OverdueAll } from './gating'

export interface ShellValue {
  session: Session
  // The latest GET /overdue reply; null before the first one, or for someone who cannot approve anywhere.
  overdue: OverdueAll | null
  reload: () => Promise<void>
}

export const ShellContext = createContext<ShellValue | null>(null)

export function useShell(): ShellValue {
  const value = useContext(ShellContext)
  if (!value) throw new Error('useShell was used outside the signed-in shell.')
  return value
}
