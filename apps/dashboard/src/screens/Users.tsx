'use client'
import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { ApiError, api } from '../api/client'
import { inviteCreatedReply, noContent, roleChangedReply, usersReply } from '../api/schemas'
import { roleIn } from '../api/session'
import { useLoad } from '../api/use-load'
import { Empty } from '../frame/Empty'
import { LoadError } from '../frame/LoadError'
import { useShell } from '../frame/shell-context'
import { afterWrite, readAfterWrite } from './after-write'
import { CodeForm, codeFailure } from './CodeForm'
import { formatTime } from './format'

export type Users = z.infer<typeof usersReply>
export type Member = Users['members'][number]
type Role = Member['role']

// The roles an invite or a role change may give (app-flow 5.3): the brand's own roles only. Nobody is made a
// platform owner from here, and the core's own list is the same four.
export const INVITE_ROLES: ReadonlyArray<{ value: Role; label: string }> = [
  { value: 'approver', label: 'Brand approver' },
  { value: 'brand_admin', label: 'Brand admin' },
  { value: 'sales_contact', label: 'Sales contact' },
  { value: 'viewer', label: 'Viewer' },
]

const ROLE_LABEL: Record<Role, string> = {
  approver: 'Brand approver',
  brand_admin: 'Brand admin',
  sales_contact: 'Sales contact',
  viewer: 'Viewer',
}

const ROLE_PHRASE: Record<Role, string> = {
  approver: 'a brand approver',
  brand_admin: 'a brand admin',
  sales_contact: 'a sales contact',
  viewer: 'a viewer',
}

type Action = { kind: 'role' | 'remove' | 'reset'; member: Member }

const ACTION_TEXT: Record<
  Action['kind'],
  { label: string; title: (name: string) => string; explain: (name: string) => string }
> = {
  role: {
    label: 'Change role',
    title: (name) => `Change ${name}’s role`,
    explain: (name) => `${name} can do what the new role allows from their next request.`,
  },
  remove: {
    label: 'Remove',
    title: (name) => `Remove ${name} from this brand`,
    explain: (name) =>
      `${name} loses access to this brand. If it was their only brand, they are signed out everywhere.`,
  },
  reset: {
    label: 'Reset second factor',
    title: (name) => `Reset ${name}’s second factor`,
    explain: (name) =>
      `${name} is signed out everywhere and sets up a new authenticator at their next sign-in. They are told by email.`,
  },
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function actionFailure(error: unknown): string {
  const code = codeFailure(error)
  if (code) return code
  if (error instanceof ApiError) {
    if (error.code === 'last_admin')
      return 'A brand needs at least one admin. Make someone else an admin first.'
    if (error.code === 'cannot_change_own_membership')
      return 'You cannot change or remove your own membership here.'
    if (error.code === 'cannot_reset_own_second_factor')
      return 'Your own second factor is reset by the documented server-side procedure.'
    if (error.status === 404) return 'This person is no longer in the brand. Reload the page.'
    if (error.status === 403) return 'You may not do that for this person.'
  }
  return 'That did not work. Try again.'
}

function inviteFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'The platform could not be reached. Try again.'
    if (error.code === 'invalid_request')
      return 'Enter an email address, such as name@example.com, and pick a role.'
    if (error.code === 'mail_not_sent')
      return 'The invite email could not be sent, so no invite was made. Try again.'
    if (error.status === 403) return 'You may not invite people into this brand.'
  }
  return 'The invite could not be sent. Try again.'
}

function MemberRows(props: {
  members: Member[]
  me: string
  canReset: boolean
  disabled: boolean
  onAction: (action: Action) => void
}) {
  return (
    <>
      {props.members.map((m) => (
        <tr key={m.userId}>
          <td>
            <b>{m.name}</b>
            <div className="tiny muted">{m.email}</div>
          </td>
          <td>
            <span className="tag plain">{ROLE_LABEL[m.role]}</span>
          </td>
          <td>
            {m.twoFactorEnabled ? (
              <span className="tag ok">Enrolled</span>
            ) : m.role === 'viewer' ? (
              <span className="muted">Not required</span>
            ) : (
              <span className="tag warn">Not enrolled</span>
            )}
          </td>
          <td className="nowrap">
            <time dateTime={m.since}>{formatTime(m.since)}</time>
          </td>
          <td>
            {m.userId === props.me ? (
              <span className="muted small">This is you</span>
            ) : (
              <div className="row wrap">
                <button
                  className="btn sm"
                  type="button"
                  disabled={props.disabled}
                  onClick={() => props.onAction({ kind: 'role', member: m })}
                >
                  Change role
                </button>
                {props.canReset && m.twoFactorEnabled ? (
                  <button
                    className="btn sm"
                    type="button"
                    disabled={props.disabled}
                    onClick={() => props.onAction({ kind: 'reset', member: m })}
                  >
                    Reset second factor
                  </button>
                ) : null}
                <button
                  className="btn sm danger"
                  type="button"
                  disabled={props.disabled}
                  onClick={() => props.onAction({ kind: 'remove', member: m })}
                >
                  Remove
                </button>
              </div>
            )}
          </td>
        </tr>
      ))}
    </>
  )
}

export function UsersScreen({ brandId }: { brandId: string }) {
  const { session } = useShell()
  const role = roleIn(session, brandId)
  const mayManage = role === 'owner' || role === 'brand_admin'
  const read = () => api(usersReply, 'GET', `/brands/${brandId}/users`)
  const loaded = useLoad(() => (mayManage ? read() : Promise.resolve(null)), `${brandId}:${mayManage}`)
  const [users, setUsers] = useState<Users | null>(null)
  const [action, setAction] = useState<Action | null>(null)
  const [newRole, setNewRole] = useState<Role>('approver')
  const [busy, setBusy] = useState(false)
  // True once a change succeeded and the list could not be read again: nothing more is sent from it.
  const [outdated, setOutdated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<Role>('approver')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

  useEffect(() => {
    if (loaded.state === 'ready' && loaded.data) setUsers(loaded.data)
  }, [loaded.state, loaded.data])

  // After a stored change: the fresh list, or the answer plus the request to reload.
  const settle = async (done: string) => {
    const fresh = await readAfterWrite(read)
    if (fresh) setUsers(fresh)
    setOutdated(fresh === null)
    setNotice(afterWrite(done, fresh !== null))
  }

  const run = async (code: string) => {
    if (!action) return
    const { kind, member: m } = action
    setBusy(true)
    setError(null)
    let done: string
    try {
      if (kind === 'role') {
        const changed = await api(roleChangedReply, 'PATCH', `/brands/${brandId}/users/${m.userId}`, {
          role: newRole,
          code,
        })
        done = `${m.name} is now ${ROLE_PHRASE[changed.role]}.`
      } else if (kind === 'remove') {
        await api(noContent, 'DELETE', `/brands/${brandId}/users/${m.userId}`, { code })
        done = `${m.name} was removed from this brand.`
      } else {
        await api(noContent, 'POST', `/users/${m.userId}/second-factor/reset`, { code })
        done = `${m.name}’s second factor was reset. They set up a new one at their next sign-in.`
      }
    } catch (e) {
      setError(actionFailure(e))
      setBusy(false)
      return
    }
    setAction(null)
    await settle(done)
    setBusy(false)
  }

  const invite = async () => {
    const address = email.trim()
    if (!EMAIL.test(address)) {
      setInviteError('Enter an email address, such as name@example.com.')
      return
    }
    setInviting(true)
    setInviteError(null)
    setNotice(null)
    try {
      await api(inviteCreatedReply, 'POST', `/brands/${brandId}/users/invites`, {
        email: address,
        role: inviteRole,
      })
    } catch (e) {
      setInviteError(inviteFailure(e))
      setInviting(false)
      return
    }
    setEmail('')
    await settle(`Invite sent to ${address}. It lasts 72 hours and works once.`)
    setInviting(false)
  }

  if (!mayManage) {
    return (
      <main id="content" className="page">
        <div className="callout warn" role="alert">
          Only the platform owner and the brand admin can manage users.
        </div>
      </main>
    )
  }

  const text = action ? ACTION_TEXT[action.kind] : null
  return (
    <main id="content" className="page">
      <div className="page-head">
        <div>
          <h1>Users and roles</h1>
          <p>Who can sign in to this brand, and what each person can do.</p>
        </div>
      </div>
      <div className="callout">
        Changing a role, removing a user or resetting a second factor asks for your own fresh 6-digit code
        first.
      </div>
      {notice ? (
        <p className="callout ok mt-4" role="status">
          {notice}
        </p>
      ) : null}

      <section className="sec" aria-labelledby="h-people">
        <div className="sec-head">
          <h2 id="h-people">People</h2>
          {users ? (
            <p>{`${users.members.length} active, ${users.pendingInvites.length} ${users.pendingInvites.length === 1 ? 'invite' : 'invites'} pending`}</p>
          ) : null}
        </div>
        {loaded.state === 'error' && !users ? (
          <LoadError what="the people of this brand" error={loaded.error} onRetry={loaded.retry} />
        ) : users ? (
          <>
            <div className="panel scroll-x">
              <table className="t">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Second factor</th>
                    <th>Member since</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <MemberRows
                    members={users.members}
                    me={session.user.id}
                    canReset={session.platformOwner}
                    disabled={busy || outdated}
                    onAction={(next) => {
                      setAction(next)
                      setNewRole(next.member.role)
                      setError(null)
                      setNotice(null)
                    }}
                  />
                  {users.pendingInvites.map((invite) => (
                    <tr key={invite.id}>
                      <td>
                        <span className="muted">Not yet accepted</span>
                        <div className="tiny muted">{invite.email}</div>
                      </td>
                      <td>
                        <span className="tag plain">{ROLE_LABEL[invite.role]}</span>
                      </td>
                      <td className="muted">Not set up</td>
                      <td colSpan={2}>
                        <span className={invite.expired ? 'tag danger' : 'tag warn'}>
                          {invite.expired ? 'Invite expired' : 'Invite pending'}
                        </span>
                        <div className="small muted">
                          {invite.expired ? 'Expired ' : 'Expires '}
                          <time dateTime={invite.expiresAt}>{formatTime(invite.expiresAt)}</time>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {users.members.length === 0 && users.pendingInvites.length === 0 ? (
              <Empty title="No one is in this brand yet">
                <p>Invite people below; each shows here once they accept.</p>
              </Empty>
            ) : null}
            <p className="muted small mt-2">
              Viewers sign in with email and password only, so they show no second factor. Only the platform
              owner can reset a second factor.
            </p>
            {action && text ? (
              <div className="mt-4">
                <CodeForm
                  key={`${action.kind}:${action.member.userId}`}
                  id="act"
                  title={text.title(action.member.name)}
                  explain={text.explain(action.member.name)}
                  submitLabel={text.label}
                  danger={action.kind !== 'role'}
                  busy={busy}
                  error={error}
                  onSubmit={(code) => void run(code)}
                  onCancel={() => {
                    setAction(null)
                    setError(null)
                  }}
                >
                  {action.kind === 'role' ? (
                    <div className="field">
                      <label htmlFor="act-role">New role</label>
                      <select
                        id="act-role"
                        className="input"
                        value={newRole}
                        onChange={(event) => setNewRole(event.target.value as Role)}
                      >
                        {INVITE_ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </CodeForm>
              </div>
            ) : null}
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>

      <section className="sec" aria-labelledby="h-invite">
        <div className="sec-head">
          <h2 id="h-invite">Invite user</h2>
          <p>An invite lasts 72 hours and works once</p>
        </div>
        <form
          className="panel pad stack"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void invite()
          }}
        >
          <div className="grid2">
            <div className="field">
              <label htmlFor="invite-email">Email</label>
              <input
                id="invite-email"
                className={inviteError ? 'input err' : 'input'}
                type="email"
                autoComplete="off"
                value={email}
                aria-invalid={inviteError ? true : undefined}
                aria-describedby={inviteError ? 'invite-error' : undefined}
                onChange={(event) => {
                  setEmail(event.target.value)
                  setInviteError(null)
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="invite-role">Role</label>
              <select
                id="invite-role"
                className="input"
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as Role)}
              >
                {INVITE_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {inviteError ? (
            <p className="errtext" id="invite-error" role="alert">
              {inviteError}
            </p>
          ) : null}
          <div>
            <button className="btn primary" type="submit" disabled={inviting || outdated}>
              Send invite
            </button>
          </div>
        </form>
      </section>
    </main>
  )
}
