'use client'
import Link from 'next/link'
import { useState } from 'react'
import { EditForm } from './EditForm'
import { formatTime, stateLabel, words } from './format'
import {
  editValues,
  keywordsOf,
  TEXT_MAX,
  type ContentItem,
  type EditValues,
  type Version,
} from './item-actions'

// The version the item points at now; an item that has none yet shows its latest.
export function shownVersion(item: ContentItem): Version | null {
  return item.versions.find((v) => v.id === item.currentVersionId) ?? item.versions.at(-1) ?? null
}

// What the screen shows of a version's hash: the first 12 characters of the digest, without the scheme
// prefix. Approve sends the full hash of that same version.
export function hashPrefix(hash: string): string {
  return hash.replace(/^sha256:/, '').slice(0, 12)
}

const CHECK_NAMES: Record<string, string> = { placeholder_length: 'Length check' }

function checkFigures(detail: unknown): string[] {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return []
  return Object.entries(detail as Record<string, unknown>)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => `${words(key.replace(/([A-Z])/g, ' $1').toLowerCase())}: ${String(value)}`)
}

function stateTone(state: string): string {
  if (state === 'check_failed' || state === 'rejected') return 'danger'
  if (state === 'awaiting_approval') return 'warn'
  if (state === 'approved' || state === 'published') return 'ok'
  return ''
}

function author(version: Version): string {
  if (version.createdBy.kind === 'agent') return 'made by an agent'
  if (version.createdBy.kind === 'user') return 'edited by a person'
  return `made by the ${version.createdBy.kind === 'n8n' ? 'workflow runner' : 'platform'}`
}

function Checks({ version }: { version: Version }) {
  const failed = version.checks.some((c) => c.passed === false)
  return (
    <div className="panel">
      <div className="ph">
        <h3>Checks</h3>
        {version.checks.length > 0 ? (
          <span className={`tag sp ${failed ? 'danger' : 'ok'}`}>
            {failed ? 'Checks failed' : 'All passed'}
          </span>
        ) : null}
      </div>
      <div className="pb">
        {version.checks.length === 0 ? (
          <p className="muted small">No check has run on this version yet.</p>
        ) : (
          version.checks.map((check, i) => (
            <div className="chk" key={`${check.name}-${i}`}>
              <span className={`ic ${check.passed === null ? 'na' : check.passed ? 'ok' : 'bad'}`}>
                {check.passed === null ? '–' : check.passed ? '✓' : '✗'}
              </span>
              <span>
                {CHECK_NAMES[check.name] ?? words(check.name)}
                {checkFigures(check.detail).map((line) => (
                  <span className="block muted small" key={line}>
                    {line}
                  </span>
                ))}
              </span>
              <span className={`tag plain ${check.passed === false ? 'danger' : check.passed ? 'ok' : ''}`}>
                {check.passed === null ? 'Not applicable' : check.passed ? 'Pass' : 'Fail'}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function History({ item }: { item: ContentItem }) {
  const newest = [...item.versions].reverse()
  return (
    <div className="panel">
      <div className="ph">
        <h3>Version history</h3>
      </div>
      <ul className="list">
        {newest.map((v) => (
          <li key={v.id}>
            <div>
              <b>{`Version ${v.number}`}</b>
              <div className="muted small">
                {`${stateLabel(v.state)} · ${author(v)} · ${formatTime(v.createdAt)}`}
              </div>
            </div>
            <code className="sp small">{hashPrefix(v.hash)}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}

type Mode = 'none' | 'reject' | 'comment' | 'edit'

// The item as it will appear, its checks and history, and the four decisions (app-flow 5.6). Approve applies to
// exactly the version on screen and is offered only while that version awaits approval.
export function ItemReview(props: {
  brandId: string
  item: ContentItem
  canDecide: boolean
  busy: boolean
  notice: string | null
  error: string | null
  onApprove: (shown: Version) => void
  onReject: (shown: Version, reason: string) => void
  onComment: (shown: Version, text: string) => void
  onEdit: (shown: Version, values: EditValues) => void
}) {
  const { brandId, item, canDecide, busy } = props
  const [mode, setMode] = useState<Mode>('none')
  const [reason, setReason] = useState('')
  const [comment, setComment] = useState('')
  const shown = shownVersion(item)
  if (!shown) {
    return <p className="muted">This item has no version yet.</p>
  }
  const payload = shown.payload
  const keywords = keywordsOf(payload)
  const awaiting = shown.state === 'awaiting_approval'
  const toggle = (next: Mode) => setMode((now) => (now === next ? 'none' : next))
  return (
    <>
      <div className="crumbs">
        <Link href={`/b/${brandId}/inbox`}>Approval inbox</Link> / {words(item.kind)}
      </div>
      <div className="page-head">
        <div>
          <h1>{payload.title ?? 'Untitled item'}</h1>
          <p>{`${words(item.kind)} · version ${shown.number} of ${item.versions.length} · ${author(shown)}`}</p>
        </div>
        <div className="actions">
          <span className={`tag ${stateTone(shown.state)}`}>{stateLabel(shown.state)}</span>
        </div>
      </div>
      {props.notice ? (
        <div className="callout warn mb-4" role="status">
          {props.notice}
        </div>
      ) : null}
      {props.error ? (
        <div className="callout danger mb-4" role="alert">
          {props.error}
        </div>
      ) : null}

      <div className="split wide-r">
        <div className="stack-l">
          <section aria-labelledby="h-preview">
            <h2 id="h-preview" className="subhead">
              As it will appear
            </h2>
            <article className="panel pad preview">
              {payload.title ? <h3 className="preview-title">{payload.title}</h3> : null}
              {payload.summary ? <p>{payload.summary}</p> : null}
              {keywords.length > 0 ? (
                <>
                  <p className="muted small mt-4">Keywords</p>
                  <ul className="keywords">
                    {keywords.map((keyword, i) => (
                      <li key={`${i}-${keyword}`}>{keyword}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </article>
          </section>

          {canDecide && mode === 'reject' ? (
            <form
              className="panel pad stack"
              onSubmit={(event) => {
                event.preventDefault()
                props.onReject(shown, reason)
              }}
            >
              <label htmlFor="reject-reason" className="strong">
                Why is it rejected?
              </label>
              <textarea
                id="reject-reason"
                className="input"
                required
                maxLength={TEXT_MAX}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <div className="row">
                <button className="btn danger" type="submit" disabled={busy || reason.trim() === ''}>
                  {`Reject version ${shown.number}`}
                </button>
                <button className="btn" type="button" onClick={() => setMode('none')}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          {canDecide && mode === 'comment' ? (
            <form
              className="panel pad stack"
              onSubmit={(event) => {
                event.preventDefault()
                props.onComment(shown, comment)
              }}
            >
              <label htmlFor="comment-text" className="strong">
                Comment
              </label>
              <span className="hint muted small">Kept with this version in the audit log.</span>
              <textarea
                id="comment-text"
                className="input"
                required
                maxLength={TEXT_MAX}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
              <div className="row">
                <button className="btn primary" type="submit" disabled={busy || comment.trim() === ''}>
                  Save comment
                </button>
                <button className="btn" type="button" onClick={() => setMode('none')}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          {canDecide && mode === 'edit' ? (
            <EditForm
              initial={editValues(payload)}
              busy={busy}
              onSave={(values) => props.onEdit(shown, values)}
              onCancel={() => setMode('none')}
            />
          ) : null}
        </div>

        <div className="stack-l">
          <Checks version={shown} />
          <History item={item} />
        </div>
      </div>

      {canDecide ? (
        <div className="actionbar">
          <span className="muted small">
            You are deciding on version {shown.number}, fingerprint{' '}
            <code className="strong">{hashPrefix(shown.hash)}</code>. If a newer version appears, this screen
            reloads and nothing is approved.
            {shown.state === 'check_failed'
              ? ' Its checks failed, so it cannot be approved; edit it to make a new version.'
              : null}
          </span>
          <span className="sp row">
            <button className="btn" type="button" disabled={busy} onClick={() => toggle('edit')}>
              Edit
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => toggle('comment')}>
              Comment
            </button>
            <button
              className="btn danger"
              type="button"
              disabled={busy || !awaiting}
              onClick={() => toggle('reject')}
            >
              Reject
            </button>
            <button
              className="btn ok"
              type="button"
              disabled={busy || !awaiting}
              onClick={() => props.onApprove(shown)}
            >
              Approve
            </button>
          </span>
        </div>
      ) : null}
    </>
  )
}
