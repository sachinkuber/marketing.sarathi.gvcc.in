'use client'
import Link from 'next/link'
import type { z } from 'zod'
import { api } from '../api/client'
import { brandReply } from '../api/schemas'
import { roleIn } from '../api/session'
import { useLoad } from '../api/use-load'
import { LoadError } from '../frame/LoadError'
import { useShell } from '../frame/shell-context'
import { words } from './format'

export type Brand = z.infer<typeof brandReply>

// The other settings screens of phase 1 (app-flow 5.16), reached from here.
const AREAS = [
  {
    path: 'users',
    label: 'Users and roles',
    about: 'Invite people, change roles, remove, reset a second factor',
  },
  {
    path: 'safety',
    label: 'Kill switch and shadow mode',
    about: 'Stop work at once, or run without sending',
  },
  {
    path: 'approvals',
    label: 'Approval settings',
    about: 'When approvers are reminded and when items escalate',
  },
  { path: 'audit', label: 'Audit log', about: 'Who did what, and the chain check' },
]

// The tag colour for each brand status (app.brand_status); a status not listed here is shown plain.
const STATUS_TONE: Record<string, string> = {
  active: 'ok',
  onboarding: 'info',
  paused: 'warn',
  offboarding: 'warn',
  closed: 'danger',
}

export function BrandSettingsView({ brandId, brand }: { brandId: string; brand: Brand }) {
  return (
    <>
      <div className="panel pad">
        <dl className="kv">
          <dt>Brand name</dt>
          <dd>{brand.name}</dd>
          <dt>Short address name</dt>
          <dd>{brand.slug}</dd>
          <dt>Status</dt>
          <dd>
            <span className={`tag ${STATUS_TONE[brand.status] ?? 'plain'}`}>{words(brand.status)}</span>
          </dd>
        </dl>
      </div>

      <section className="sec" aria-labelledby="h-shadow">
        <div className="sec-head">
          <h2 id="h-shadow">Shadow mode</h2>
        </div>
        <div className="row wrap">
          <span className={brand.shadowMode ? 'tag warn' : 'tag plain'}>
            {brand.shadowMode ? 'On' : 'Off'}
          </span>
          <span className="sub">
            {brand.shadowMode
              ? 'Everything is made and approved as usual, and nothing is sent.'
              : 'Content goes out after approval.'}
          </span>
          <Link className="sp" href={`/b/${brandId}/settings/safety`}>
            Change on Kill switch and shadow mode
          </Link>
        </div>
      </section>

      <section className="sec" aria-labelledby="h-areas">
        <div className="sec-head">
          <h2 id="h-areas">More settings</h2>
        </div>
        <div className="panel">
          <ul className="list">
            {AREAS.map((area) => (
              <li key={area.path} className="wrap-row">
                <div className="grow">
                  <Link href={`/b/${brandId}/settings/${area.path}`}>
                    <b>{area.label}</b>
                  </Link>
                  <div className="muted small">{area.about}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  )
}

export function BrandSettingsScreen({ brandId }: { brandId: string }) {
  const { session } = useShell()
  const role = roleIn(session, brandId)
  const mayOpen = role === 'owner' || role === 'brand_admin'
  const loaded = useLoad(
    () => (mayOpen ? api(brandReply, 'GET', `/brands/${brandId}`) : Promise.resolve(null)),
    `${brandId}:${mayOpen}`,
  )
  return (
    <main id="content" className="page">
      <div className="page-head">
        <div>
          <h1>Brand settings</h1>
          <p>The basics for this brand. Changes made in settings are recorded in the audit log.</p>
        </div>
      </div>
      {!mayOpen ? (
        <div className="callout warn" role="alert">
          Only the platform owner and the brand admin can open the brand settings.
        </div>
      ) : loaded.state === 'error' ? (
        <LoadError what="the brand settings" error={loaded.error} onRetry={loaded.retry} />
      ) : loaded.state === 'ready' && loaded.data ? (
        <BrandSettingsView brandId={brandId} brand={loaded.data} />
      ) : (
        <p className="muted">Loading…</p>
      )}
    </main>
  )
}
