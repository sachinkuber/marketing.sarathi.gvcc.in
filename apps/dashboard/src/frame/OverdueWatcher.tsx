'use client'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { overdueAckReply, overdueReply } from '../api/schemas'
import type { z } from 'zod'
import { OverduePopup } from './OverduePopup'

export type Overdue = z.infer<typeof overdueReply>

const POLL_MS = 60_000

// Reads the overdue list now, every 60 seconds and whenever the window regains focus, so the pop-up opens on
// any screen when an item becomes overdue. Returns the latest reply (null before the first, or when the
// person cannot approve) and a reload.
export function useOverdue(brandId: string, canApprove: boolean) {
  const [overdue, setOverdue] = useState<Overdue | null>(null)
  const reload = useCallback(async () => {
    if (!canApprove) return
    try {
      setOverdue(await api(overdueReply, 'GET', `/brands/${brandId}/approvals/overdue`))
    } catch {
      // A failed poll keeps what is shown; the next poll tries again.
    }
  }, [brandId, canApprove])
  useEffect(() => {
    void reload()
    const timer = setInterval(() => void reload(), POLL_MS)
    const onFocus = () => void reload()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [reload])
  return { overdue, reload }
}

export function OverdueWatcher(props: {
  brandId: string
  overdue: Overdue | null
  reload: () => Promise<void>
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = Boolean(props.overdue?.popup.due)
  const first = useRef<string | null>(null)
  first.current = props.overdue?.items[0]?.contentItemId ?? null

  // While open the pop-up cannot be dismissed: Escape does nothing, and focus stays inside it.
  useEffect(() => {
    if (!open) return
    document.documentElement.classList.add('modal-open')
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
      }
      if (event.key === 'Tab') {
        const buttons = document.querySelectorAll<HTMLButtonElement>('#overdue-popup button:not([disabled])')
        const firstButton = buttons[0]
        const lastButton = buttons[buttons.length - 1]
        if (!firstButton || !lastButton) return
        if (event.shiftKey && document.activeElement === firstButton) {
          event.preventDefault()
          lastButton.focus()
        } else if (!event.shiftKey && document.activeElement === lastButton) {
          event.preventDefault()
          firstButton.focus()
        } else if (!document.querySelector('#overdue-popup')?.contains(document.activeElement)) {
          event.preventDefault()
          firstButton.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    document.querySelector<HTMLButtonElement>('#overdue-popup .btn.primary')?.focus()
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.documentElement.classList.remove('modal-open')
    }
  }, [open])

  const choose = async (choice: 'review_now' | 'later') => {
    const target = first.current
    setBusy(true)
    setError(null)
    try {
      await api(overdueAckReply, 'POST', `/brands/${props.brandId}/approvals/overdue/ack`, { choice })
      await props.reload()
      if (choice === 'review_now' && target) router.push(`/b/${props.brandId}/inbox/${target}`)
    } catch {
      setError('Your answer could not be saved. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <OverduePopup
      open={open}
      items={props.overdue?.items ?? []}
      busy={busy}
      error={error}
      now={Date.now()}
      onChoice={(choice) => void choose(choice)}
    />
  )
}
