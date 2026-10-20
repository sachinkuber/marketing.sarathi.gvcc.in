'use client'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { overdueAckReply, overdueAllReply } from '../api/schemas'
import { popupKeyAction, popupTarget, type OverdueAll } from './gating'
import { OverduePopup } from './OverduePopup'

const POLL_MS = 60_000

// Reads the overdue list across the person's brands now, every 60 seconds and whenever the window regains
// focus, so the pop-up opens on any screen when an item becomes overdue.
export function useOverdueAll(enabled: boolean) {
  const [overdue, setOverdue] = useState<OverdueAll | null>(null)
  const reload = useCallback(async () => {
    if (!enabled) return
    try {
      setOverdue(await api(overdueAllReply, 'GET', '/overdue'))
    } catch {
      // A failed poll keeps what is shown; the next poll tries again.
    }
  }, [enabled])
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

const BUTTONS = '#overdue-popup button:not([disabled])'

// The pop-up for the first brand whose pop-up is due. It cannot be dismissed: Escape is swallowed, the
// backdrop does nothing, focus stays inside it (the rest of the page is inert, set by the shell), and Back
// is answered by putting the same page back. Only "Later" and "Review now" end it.
export function OverdueWatcher(props: { overdue: OverdueAll | null; reload: () => Promise<void> }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const target = popupTarget(props.overdue)
  const open = target !== null
  const targetRef = useRef(target)
  targetRef.current = target

  useEffect(() => {
    if (!open) return
    document.documentElement.classList.add('modal-open')
    const dialog = () => document.querySelector<HTMLElement>('#overdue-popup [role="dialog"]')
    const onKey = (event: KeyboardEvent) => {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>(BUTTONS)]
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      // With one button it is both the first and the last, so Tab and Shift+Tab both wrap onto it.
      const active: 'first' | 'last' | 'other' =
        at < 0
          ? 'other'
          : buttons.length === 1
            ? event.shiftKey
              ? 'first'
              : 'last'
            : at === 0
              ? 'first'
              : 'last'
      const action = popupKeyAction(event.key, event.shiftKey, active, buttons.length)
      if (action.prevent) {
        event.preventDefault()
        event.stopPropagation()
      }
      if (action.focus === 'first') buttons[0]?.focus()
      if (action.focus === 'last') buttons[buttons.length - 1]?.focus()
      if (action.focus === 'dialog') dialog()?.focus()
    }
    // Back never takes the pop-up away: the same address is put back on top of the history each time.
    const guard = () => window.history.pushState({ overdueGuard: true }, '', window.location.href)
    guard()
    const onPop = () => guard()
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('popstate', onPop)
    const before = document.activeElement as HTMLElement | null
    ;(document.querySelector<HTMLElement>('#overdue-popup .btn.primary') ?? dialog())?.focus()
    return () => {
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('popstate', onPop)
      document.documentElement.classList.remove('modal-open')
      before?.focus?.()
    }
  }, [open])

  // While an answer is being saved the buttons are disabled; focus moves to the dialog so it is not lost.
  useEffect(() => {
    if (open && busy) document.querySelector<HTMLElement>('#overdue-popup [role="dialog"]')?.focus()
  }, [open, busy])

  const choose = async (choice: 'review_now' | 'later') => {
    const current = targetRef.current
    if (!current) return
    setBusy(true)
    setError(null)
    try {
      await api(overdueAckReply, 'POST', `/brands/${current.brandId}/approvals/overdue/ack`, { choice })
      await props.reload()
      if (choice === 'review_now') router.push(`/b/${current.brandId}/inbox/${current.firstItemId}`)
    } catch {
      setError('Your answer could not be saved. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <OverduePopup
      open={open}
      items={target?.items ?? []}
      brandName={target?.brandName}
      busy={busy}
      error={error}
      now={Date.now()}
      onChoice={(choice) => void choose(choice)}
    />
  )
}
