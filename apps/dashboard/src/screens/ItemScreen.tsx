'use client'
import { useState } from 'react'
import { ApiError } from '../api/client'
import { roleIn } from '../api/session'
import { useLoad } from '../api/use-load'
import { LoadError } from '../frame/LoadError'
import { useShell } from '../frame/shell-context'
import {
  approveShown,
  commentOn,
  loadItem,
  rejectShown,
  saveEdit,
  type ContentItem,
  type Outcome,
} from './item-actions'
import { ItemReview } from './ItemReview'

function failure(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return 'The platform could not be reached. Try again.'
  if (error instanceof ApiError && error.code === 'payload_rejected')
    return 'The edit could not be stored: the content is not valid. Check each field and try again.'
  if (error instanceof ApiError && error.status === 403) return 'You may not do that for this brand.'
  return 'That did not work. Reload the item and try again.'
}

export function ItemScreen({ brandId, itemId }: { brandId: string; itemId: string }) {
  const { session } = useShell()
  const role = roleIn(session, brandId)
  const canDecide = role === 'owner' || role === 'brand_admin' || role === 'approver'
  const loaded = useLoad(() => loadItem(brandId, itemId), `${brandId}:${itemId}`)
  // The item as last reloaded after an action; it replaces the first load until the address changes.
  const [fresh, setFresh] = useState<ContentItem | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Each finished action remounts the review, which closes any open form.
  const [round, setRound] = useState(0)

  const finish = async (
    work: () => Promise<Outcome<'approved'> | Outcome<'rejected'> | Outcome<'commented'>>,
    done: string,
  ) => {
    setBusy(true)
    setError(null)
    try {
      const outcome = await work()
      if (outcome.kind === 'invalid') {
        setError(outcome.message)
        return
      }
      if (outcome.kind === 'reloaded') {
        setFresh(outcome.item)
        setNotice(outcome.notice)
      } else {
        setFresh(await loadItem(brandId, itemId))
        setNotice(done)
      }
      setRound((n) => n + 1)
    } catch (e) {
      setError(failure(e))
    } finally {
      setBusy(false)
    }
  }

  const item = fresh?.id === itemId ? fresh : loaded.data
  return (
    <main id="content" className="page">
      {loaded.state === 'loading' && !item ? <p className="muted">Loading…</p> : null}
      {loaded.state === 'error' ? (
        <LoadError what="this item" error={loaded.error} onRetry={loaded.retry} />
      ) : null}
      {item ? (
        <ItemReview
          key={round}
          brandId={brandId}
          item={item}
          canDecide={canDecide}
          busy={busy}
          notice={notice}
          error={error}
          onApprove={(shown) =>
            void finish(
              () => approveShown(brandId, itemId, shown),
              'Approved. Nothing is published in this phase.',
            )
          }
          onReject={(shown, reason) =>
            void finish(
              () => rejectShown(brandId, itemId, shown, reason),
              'Rejected. The reason is kept with the decision.',
            )
          }
          onComment={(shown, text) =>
            void finish(() => commentOn(brandId, itemId, shown, text), 'Comment saved.')
          }
          onEdit={(shown, values) => {
            setBusy(true)
            setError(null)
            saveEdit(brandId, itemId, shown.payload, values).then(
              ({ number, item: next }) => {
                setFresh(next)
                setNotice(`Saved as version ${number}. It goes through the checks before it can be approved.`)
                setRound((n) => n + 1)
                setBusy(false)
              },
              (e: unknown) => {
                setError(failure(e))
                setBusy(false)
              },
            )
          }}
        />
      ) : null}
    </main>
  )
}
