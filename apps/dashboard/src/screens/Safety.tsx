'use client'
import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { ApiError, api } from '../api/client'
import {
  homeReply,
  killSwitchReply,
  shadowModeReply,
  switchReleasedReply,
  switchSetReply,
  type killSwitch,
} from '../api/schemas'
import { roleIn } from '../api/session'
import { useLoad } from '../api/use-load'
import { Empty } from '../frame/Empty'
import { useFrame } from '../frame/frame-context'
import { LoadError } from '../frame/LoadError'
import { useShell } from '../frame/shell-context'
import { afterWrite, readAfterWrite } from './after-write'
import { CodeForm, codeFailure } from './CodeForm'
import { formatTime, words } from './format'

export type KillSwitch = z.infer<typeof killSwitch>
type Scope = KillSwitch['scope']

// The channels a switch may name. In phase 1 no job carries a channel, so a channel switch is stored, shown and
// audited but holds nothing (killswitch/service.ts).
const CHANNELS = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'youtube', label: 'YouTube' },
]
// Phase 1 has one agent.
const AGENTS = [{ value: 'summary', label: 'Summary agent' }]

function scopeLabel(sw: Pick<KillSwitch, 'scope' | 'target'>): string {
  if (sw.scope === 'brand') return 'Whole brand'
  if (sw.scope === 'channel') {
    return `Channel: ${CHANNELS.find((c) => c.value === sw.target)?.label ?? sw.target ?? 'unknown'}`
  }
  return `Agent: ${AGENTS.find((a) => a.value === sw.target)?.label ?? words(sw.target ?? 'unknown')}`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function switchFailure(error: unknown): string {
  const code = codeFailure(error)
  if (code) return code
  if (error instanceof ApiError) {
    if (error.status === 403) return 'You may not use the kill switch for this brand.'
    if (error.code === 'conflict') return 'The switch changed while it was being set. Try again.'
  }
  return 'That did not work. Try again.'
}

export function HeldNow({ held }: { held: number }) {
  if (held === 0) {
    return (
      <div className="panel">
        <Empty title="Nothing is held">
          <p>When a switch is on, the waiting jobs it holds are counted here.</p>
        </Empty>
      </div>
    )
  }
  return (
    <div className="panel pad">
      <b>{`${plural(held, 'job is', 'jobs are')} held`}</b>
      <p className="sub small mt-2">
        They wait, and nothing further is sent. They resume when every switch that covers them is released.
      </p>
    </div>
  )
}

export function SafetyScreen({ brandId }: { brandId: string }) {
  const { session } = useShell()
  const { refreshStatus } = useFrame()
  const role = roleIn(session, brandId)
  const mayUse = role === 'owner' || role === 'brand_admin'
  const owner = session.platformOwner
  const readSwitches = () => api(killSwitchReply, 'GET', `/brands/${brandId}/kill-switch`)
  // What is held now: the core counts the brand's held jobs in the home figures.
  const readHeld = async () =>
    (await api(homeReply, 'GET', `/brands/${brandId}/home`)).progress?.jobs.held ?? 0
  const switchesLoad = useLoad(
    () => (mayUse ? readSwitches() : Promise.resolve(null)),
    `${brandId}:${mayUse}`,
  )
  const heldLoad = useLoad(() => (mayUse ? readHeld() : Promise.resolve(null)), `${brandId}:${mayUse}`)

  const [switches, setSwitches] = useState<KillSwitch[] | null>(null)
  const [shadow, setShadow] = useState<boolean | null>(null)
  const [held, setHeld] = useState<number | null>(null)
  const [scope, setScope] = useState<Scope>('brand')
  const [channel, setChannel] = useState(CHANNELS[0]!.value)
  const [agent, setAgent] = useState(AGENTS[0]!.value)
  const [releasing, setReleasing] = useState<KillSwitch | null>(null)
  const [busy, setBusy] = useState(false)
  // True once a change succeeded and the screen could not be read again: nothing more is sent from it.
  const [outdated, setOutdated] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [stopError, setStopError] = useState<string | null>(null)
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const [shadowError, setShadowError] = useState<string | null>(null)
  // Each stored change starts a new stop form, so the spent code is not left in it.
  const [round, setRound] = useState(0)

  useEffect(() => {
    if (switchesLoad.state === 'ready' && switchesLoad.data) {
      setSwitches(switchesLoad.data.switches)
      setShadow(switchesLoad.data.shadowMode)
    }
  }, [switchesLoad.state, switchesLoad.data])
  useEffect(() => {
    if (heldLoad.state === 'ready' && heldLoad.data !== null) setHeld(heldLoad.data)
  }, [heldLoad.state, heldLoad.data])

  const settle = async (done: string) => {
    const fresh = await readAfterWrite(readSwitches)
    const count = await readAfterWrite(readHeld)
    if (fresh) {
      setSwitches(fresh.switches)
      setShadow(fresh.shadowMode)
    }
    if (count !== null) setHeld(count)
    const ok = fresh !== null && count !== null
    setOutdated(!ok)
    setNotice(afterWrite(done, ok))
    setRound((n) => n + 1)
    // The red banner on every screen of the brand follows at once, not at the next poll.
    await refreshStatus()
  }

  const stop = async (code: string) => {
    const target = scope === 'brand' ? undefined : scope === 'channel' ? channel : agent
    setBusy(true)
    setStopError(null)
    setNotice(null)
    let done: string
    try {
      const result = await api(switchSetReply, 'POST', `/brands/${brandId}/kill-switch`, {
        scope,
        ...(target === undefined ? {} : { target }),
        code,
      })
      if (!result.created) done = 'This switch was already on. Nothing changed.'
      else if (scope === 'channel')
        done = 'Stopped. Nothing is sent on that channel. No job is tied to a channel yet, so none was held.'
      else done = `Stopped. ${plural(result.held, 'waiting job was', 'waiting jobs were')} held.`
    } catch (e) {
      setStopError(switchFailure(e))
      setBusy(false)
      return
    }
    await settle(done)
    setBusy(false)
  }

  const release = async (sw: KillSwitch, code: string) => {
    setBusy(true)
    setReleaseError(null)
    setNotice(null)
    let done: string
    try {
      const result = await api(switchReleasedReply, 'POST', `/brands/${brandId}/kill-switch/release`, {
        scope: sw.scope,
        ...(sw.target === null ? {} : { target: sw.target }),
        code,
      })
      done = result.released
        ? `Released. ${plural(result.unheld, 'held job resumes', 'held jobs resume')}.`
        : 'This switch was already released. Nothing changed.'
    } catch (e) {
      setReleaseError(switchFailure(e))
      setBusy(false)
      return
    }
    setReleasing(null)
    await settle(done)
    setBusy(false)
  }

  const toggleShadow = async (next: boolean) => {
    setBusy(true)
    setShadowError(null)
    try {
      const reply = await api(shadowModeReply, 'PATCH', `/brands/${brandId}/shadow-mode`, {
        shadow_mode: next,
      })
      setShadow(reply.shadowMode)
      await refreshStatus()
    } catch (e) {
      setShadowError(
        e instanceof ApiError && e.status === 403
          ? 'Only the platform owner can turn shadow mode on or off.'
          : 'Shadow mode could not be changed. Try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  if (!mayUse) {
    return (
      <main id="content" className="page">
        <div className="callout warn" role="alert">
          Only the platform owner and the brand admin can use the kill switch.
        </div>
      </main>
    )
  }

  return (
    <main id="content" className="page">
      <div className="page-head">
        <div>
          <h1>Kill switch and shadow mode</h1>
          <p>Stop work at once, or let everything run without sending anything.</p>
        </div>
      </div>
      <div className="callout">
        Setting or releasing a switch asks for a fresh 6-digit code from your authenticator app, even if you
        signed in a minute ago.
      </div>
      {notice ? (
        <p className="callout ok mt-4" role="status">
          {notice}
        </p>
      ) : null}

      <section className="sec" aria-labelledby="h-on">
        <div className="sec-head">
          <h2 id="h-on">Switches that are on</h2>
        </div>
        {switchesLoad.state === 'error' && !switches ? (
          <LoadError what="the kill switches" error={switchesLoad.error} onRetry={switchesLoad.retry} />
        ) : switches ? (
          switches.length === 0 ? (
            <p className="sub">No switch is on. All work runs as planned.</p>
          ) : (
            <div className="panel">
              <ul className="list">
                {switches.map((sw) => (
                  <li key={sw.id} className="wrap-row">
                    <span className="tag danger">On</span>
                    <div className="grow">
                      <b>{scopeLabel(sw)}</b>
                      <div className="muted small">
                        {'Since '}
                        <time dateTime={sw.setAt}>{formatTime(sw.setAt)}</time>
                      </div>
                    </div>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy || outdated}
                      onClick={() => {
                        setReleasing(sw)
                        setReleaseError(null)
                        setNotice(null)
                      }}
                    >
                      Release
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )
        ) : (
          <p className="muted">Loading…</p>
        )}
        {releasing ? (
          <div className="mt-4">
            <CodeForm
              key={releasing.id}
              id="rel"
              title={`Release: ${scopeLabel(releasing)}`}
              explain="Held work resumes once no other switch covers it."
              submitLabel="Release"
              busy={busy || outdated}
              error={releaseError}
              onSubmit={(code) => void release(releasing, code)}
              onCancel={() => {
                setReleasing(null)
                setReleaseError(null)
              }}
            />
          </div>
        ) : null}
      </section>

      <section className="sec" aria-labelledby="h-stop">
        <div className="sec-head">
          <h2 id="h-stop">Stop</h2>
          <p>Choose how much to stop</p>
        </div>
        <CodeForm
          key={round}
          id="ks"
          title="Set a kill switch"
          explain="Waiting work is held and nothing further is sent. A red banner shows on every screen of this brand."
          submitLabel="Stop"
          danger
          busy={busy || outdated}
          error={stopError}
          onSubmit={(code) => void stop(code)}
        >
          <div className="field">
            <label htmlFor="ks-scope">Scope</label>
            <select
              id="ks-scope"
              className="input"
              value={scope}
              onChange={(event) => setScope(event.target.value as Scope)}
            >
              <option value="brand">Whole brand: every channel and every agent</option>
              <option value="channel">One channel</option>
              <option value="agent">One agent</option>
            </select>
          </div>
          {scope === 'channel' ? (
            <div className="field">
              <label htmlFor="ks-channel">Channel</label>
              <select
                id="ks-channel"
                className="input"
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
              >
                {CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {scope === 'agent' ? (
            <div className="field">
              <label htmlFor="ks-agent">Agent</label>
              <select
                id="ks-agent"
                className="input"
                value={agent}
                onChange={(event) => setAgent(event.target.value)}
              >
                {AGENTS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </CodeForm>
      </section>

      <section className="sec" aria-labelledby="h-held">
        <div className="sec-head">
          <h2 id="h-held">What is held right now</h2>
        </div>
        {heldLoad.state === 'error' && held === null ? (
          <LoadError what="the held work" error={heldLoad.error} onRetry={heldLoad.retry} />
        ) : held !== null ? (
          <HeldNow held={held} />
        ) : (
          <p className="muted">Loading…</p>
        )}
        <p className="muted small mt-2">
          Nothing is sent to outside platforms in this phase, so nothing is in flight that could not be
          recalled.
        </p>
      </section>

      <section className="sec" aria-labelledby="h-shadow">
        <div className="sec-head">
          <h2 id="h-shadow">Shadow mode</h2>
        </div>
        {shadow === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="row wrap">
            <span
              className={shadow ? 'switch on' : 'switch'}
              role="img"
              aria-label={`Shadow mode is ${shadow ? 'on' : 'off'}`}
            />
            <b>{`Shadow mode is ${shadow ? 'on' : 'off'}`}</b>
            {owner ? (
              <button
                className="btn sm"
                type="button"
                disabled={busy || outdated}
                onClick={() => void toggleShadow(!shadow)}
              >
                {shadow ? 'Turn shadow mode off' : 'Turn shadow mode on'}
              </button>
            ) : (
              <span className="muted small">Only the platform owner can turn shadow mode on or off.</span>
            )}
          </div>
        )}
        {shadowError ? (
          <p className="errtext mt-2" role="alert">
            {shadowError}
          </p>
        ) : null}
        <p className="sub mt-2">
          With shadow mode on, everything is made, checked and approved as usual, and nothing is sent.
        </p>
      </section>
    </main>
  )
}
