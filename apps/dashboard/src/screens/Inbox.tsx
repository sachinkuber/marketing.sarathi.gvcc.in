'use client'
import Link from 'next/link'
import type { z } from 'zod'
import { api } from '../api/client'
import { contentListReply, type contentListItem } from '../api/schemas'
import { useLoad } from '../api/use-load'
import { Empty } from '../frame/Empty'
import { LoadError } from '../frame/LoadError'
import { waitedFor, words } from './format'

export type InboxItem = z.infer<typeof contentListItem>
export type InboxFilter = 'waiting' | 'overdue' | 'check_failed'

const FILTERS: { id: InboxFilter; label: string }[] = [
  { id: 'waiting', label: 'Waiting' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'check_failed', label: 'Checks failed' },
]

const EMPTY: Record<InboxFilter, { title: string; text: string }> = {
  waiting: {
    title: 'Nothing is waiting for approval',
    text: 'Items appear here when an agent has produced them and their checks have passed.',
  },
  overdue: {
    title: 'Nothing is overdue',
    text: 'An item becomes overdue when its reminders go unanswered. It stays unapproved until someone decides.',
  },
  check_failed: {
    title: 'No item has failed its checks',
    text: 'Items whose checks failed appear here. They cannot be approved; an edit makes a new version.',
  },
}

// The filter named in the address; anything unknown is the default list.
export function inboxFilter(raw: string | null | undefined): InboxFilter {
  return FILTERS.some((f) => f.id === raw) ? (raw as InboxFilter) : 'waiting'
}

// What to ask the core for each filter. Overdue items are still awaiting approval. The core is asked for the
// oldest first, so its row cap drops the newest items rather than the ones that have waited longest.
export function inboxQuery(filter: InboxFilter): string {
  if (filter === 'overdue') return '?state=awaiting_approval&overdue=true&order=oldest'
  if (filter === 'check_failed') return '?state=check_failed&order=oldest'
  return '?state=awaiting_approval&order=oldest'
}

const since = (item: InboxItem) => item.requestedAt ?? item.createdAt ?? ''

// The core answers newest first; the inbox reads oldest first (app-flow 5.6 step 1).
export function inboxOrder(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => since(a).localeCompare(since(b)) || a.id.localeCompare(b.id))
}

function href(brandId: string, filter: InboxFilter): string {
  return filter === 'waiting' ? `/b/${brandId}/inbox` : `/b/${brandId}/inbox?filter=${filter}`
}

function Status({ item, now }: { item: InboxItem; now: number }) {
  const from = since(item)
  const wait = from ? waitedFor(from, now) : 'unknown'
  if (item.state === 'check_failed') return <span className="tag danger">{`Checks failed · ${wait}`}</span>
  if (item.overdue) return <span className="tag danger">{`Overdue · ${wait}`}</span>
  return <span className="tag warn">{`Waiting · ${wait}`}</span>
}

export function InboxList(props: { brandId: string; filter: InboxFilter; items: InboxItem[]; now: number }) {
  const { brandId, filter, now } = props
  const items = inboxOrder(props.items)
  return (
    <>
      <div className="row wrap mb-4">
        <nav className="seg" aria-label="Filter">
          {FILTERS.map((f) => (
            <Link key={f.id} href={href(brandId, f.id)} aria-current={f.id === filter ? 'page' : undefined}>
              {f.label}
            </Link>
          ))}
        </nav>
        <span className="sp muted small">Oldest first</span>
      </div>
      {items.length === 0 ? (
        <Empty title={EMPTY[filter].title}>
          <p>{EMPTY[filter].text}</p>
        </Empty>
      ) : (
        <div className="panel">
          <ul className="inbox plain">
            {items.map((item) => (
              <li key={item.id} className={item.overdue ? 'late' : undefined}>
                <div>
                  <b>
                    <Link className="inherit" href={`/b/${brandId}/inbox/${item.id}`}>
                      {item.title ?? 'Untitled item'}
                    </Link>
                  </b>
                  <div className="muted small">
                    {words(item.kind)}
                    {item.number ? ` · version ${item.number}` : null}
                  </div>
                </div>
                <div className="right">
                  <Status item={item} now={now} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

export function InboxScreen({ brandId, filter }: { brandId: string; filter: InboxFilter }) {
  const loaded = useLoad(
    () => api(contentListReply, 'GET', `/brands/${brandId}/content${inboxQuery(filter)}`),
    `${brandId}:${filter}`,
  )
  return (
    <main id="content" className="page">
      <div className="page-head">
        <div>
          <h1>Approval inbox</h1>
          <p>
            Nothing here goes live until it is approved. Items that wait too long are escalated and marked
            overdue; they are never approved by silence.
          </p>
        </div>
      </div>
      {loaded.state === 'loading' ? <p className="muted">Loading…</p> : null}
      {loaded.state === 'error' ? (
        <LoadError what="the inbox" error={loaded.error} onRetry={loaded.retry} />
      ) : null}
      {loaded.state === 'ready' ? (
        <InboxList brandId={brandId} filter={filter} items={loaded.data.items} now={Date.now()} />
      ) : null}
    </main>
  )
}
