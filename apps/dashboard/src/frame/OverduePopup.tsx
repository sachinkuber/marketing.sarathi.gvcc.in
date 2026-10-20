import type { z } from 'zod'
import type { overdueItem } from '../api/schemas'

export type OverdueItem = z.infer<typeof overdueItem>

function waited(since: string, now: number): string {
  const hours = Math.max(0, Math.floor((now - Date.parse(since)) / 3_600_000))
  if (hours < 1) return 'overdue for under an hour'
  if (hours < 48) return `overdue for ${hours} ${hours === 1 ? 'hour' : 'hours'}`
  return `overdue for ${Math.floor(hours / 24)} days`
}

// Opens over any screen while an overdue item has not been answered. It has no close control: the only
// ways out are the two choices. Escape, the backdrop and the back button are handled by the watcher.
export function OverduePopup(props: {
  open: boolean
  items: OverdueItem[]
  busy: boolean
  error: string | null
  now: number
  onChoice: (choice: 'review_now' | 'later') => void
}) {
  if (!props.open) return null
  const n = props.items.length
  return (
    <div className="scrim open" id="overdue-popup">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="od-h">
        <div className="mh">
          <h2 id="od-h">
            {n} {n === 1 ? 'item' : 'items'} overdue for approval
          </h2>
          <p className="muted small">
            Reminders were sent and the items were escalated. Nothing is approved or published until someone
            decides.
          </p>
        </div>
        <div className="mb">
          <ul className="od">
            {props.items.map((item) => (
              <li key={item.versionId}>
                <span>{item.title ?? 'Untitled item'}</span>
                <span className="muted">{waited(item.overdueSince, props.now)}</span>
              </li>
            ))}
          </ul>
          {props.error ? (
            <p className="errtext" role="alert">
              {props.error}
            </p>
          ) : null}
        </div>
        <div className="mf">
          <button className="btn" type="button" disabled={props.busy} onClick={() => props.onChoice('later')}>
            Later
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={props.busy}
            onClick={() => props.onChoice('review_now')}
          >
            Review now
          </button>
        </div>
      </div>
    </div>
  )
}
