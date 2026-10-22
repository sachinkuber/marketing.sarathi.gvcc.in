'use client'
import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { ApiError, api } from '../api/client'
import { approvalSettingsReply } from '../api/schemas'
import { roleIn } from '../api/session'
import { useLoad } from '../api/use-load'
import { LoadError } from '../frame/LoadError'
import { useShell } from '../frame/shell-context'

export type ApprovalSettings = z.infer<typeof approvalSettingsReply>

// The form holds what the person typed, in hours; the API speaks whole minutes.
export interface SettingsForm {
  firstHours: string
  gapHours: string
  count: string
}
export type SettingsErrors = Partial<Record<keyof SettingsForm | 'form', string>>

const MAX_MINUTES = 525_600
const COUNTS = ['1', '2', '3', '4', '5']

function hoursText(minutes: number): string {
  return (minutes / 60).toFixed(2).replace(/\.?0+$/, '')
}

export function formFromSettings(settings: ApprovalSettings): SettingsForm {
  return {
    firstHours: hoursText(settings.firstReminderAfterMinutes),
    gapHours: hoursText(settings.reminderGapMinutes),
    count: String(settings.reminderCount),
  }
}

function minutesOf(hours: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(hours.trim())) return null
  const minutes = Math.round(Number(hours.trim()) * 60)
  return minutes >= 1 && minutes <= MAX_MINUTES ? minutes : null
}

const HOURS_ERROR = 'Enter a number of hours above zero and at most 8760 (a year).'
const COUNT_ERROR = 'Choose 1 to 5 reminders.'

export function settingsFromForm(
  form: SettingsForm,
): { ok: true; change: ApprovalSettings } | { ok: false; errors: SettingsErrors } {
  const first = minutesOf(form.firstHours)
  const gap = minutesOf(form.gapHours)
  const count = COUNTS.includes(form.count.trim()) ? Number(form.count.trim()) : null
  const errors: SettingsErrors = {}
  if (first === null) errors.firstHours = HOURS_ERROR
  if (gap === null) errors.gapHours = HOURS_ERROR
  if (count === null) errors.count = COUNT_ERROR
  if (first === null || gap === null || count === null) return { ok: false, errors }
  return {
    ok: true,
    change: { firstReminderAfterMinutes: first, reminderGapMinutes: gap, reminderCount: count },
  }
}

const FIELD_OF: Record<string, keyof SettingsForm> = {
  firstReminderAfterMinutes: 'firstHours',
  reminderGapMinutes: 'gapHours',
  reminderCount: 'count',
}

// The screen's own words for each field: the core's messages speak minutes, which this screen never shows.
const FIELD_MESSAGE: Record<keyof SettingsForm | 'form', string> = {
  firstHours: HOURS_ERROR,
  gapHours: HOURS_ERROR,
  count: COUNT_ERROR,
  form: 'The settings were not accepted. Check each field and try again.',
}

// The core's 400 invalid_request lists each refused field; each is marked on the field it names. Anything it
// cannot place goes above the form. Other failures place nothing here.
export function settingsFieldErrors(error: unknown): SettingsErrors {
  if (!(error instanceof ApiError) || error.code !== 'invalid_request' || !Array.isArray(error.details))
    return {}
  const errors: SettingsErrors = {}
  for (const issue of error.details as Array<{ path?: unknown }>) {
    const field = typeof issue.path === 'string' ? (FIELD_OF[issue.path] ?? 'form') : 'form'
    errors[field] = FIELD_MESSAGE[field]
  }
  return errors
}

function Field(props: {
  id: string
  label: string
  hint: string
  error: string | undefined
  children: (described: string | undefined) => React.ReactNode
}) {
  const described = props.error ? `${props.id}-hint ${props.id}-error` : `${props.id}-hint`
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      {props.children(described)}
      <span className="hint" id={`${props.id}-hint`}>
        {props.hint}
      </span>
      {props.error ? (
        <p className="errtext" id={`${props.id}-error`}>
          {props.error}
        </p>
      ) : null}
    </div>
  )
}

export function ApprovalSettingsForm(props: {
  value: SettingsForm
  errors: SettingsErrors
  busy: boolean
  saved: boolean
  onChange: (next: SettingsForm) => void
  onSave: () => void
}) {
  const { value, errors } = props
  const set = (key: keyof SettingsForm) => (event: { target: { value: string } }) =>
    props.onChange({ ...value, [key]: event.target.value })
  return (
    <form
      className="panel pad stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        props.onSave()
      }}
    >
      {errors.form ? (
        <p className="errtext" role="alert">
          {errors.form}
        </p>
      ) : null}
      <div className="grid3">
        <Field
          id="first-hours"
          label="First reminder after"
          hint="Hours after the item starts waiting."
          error={errors.firstHours}
        >
          {(described) => (
            <input
              id="first-hours"
              className={errors.firstHours ? 'input err' : 'input'}
              inputMode="decimal"
              value={value.firstHours}
              aria-invalid={errors.firstHours ? true : undefined}
              aria-describedby={described}
              onChange={set('firstHours')}
            />
          )}
        </Field>
        <Field
          id="gap-hours"
          label="Gap between reminders"
          hint="Hours between one reminder and the next."
          error={errors.gapHours}
        >
          {(described) => (
            <input
              id="gap-hours"
              className={errors.gapHours ? 'input err' : 'input'}
              inputMode="decimal"
              value={value.gapHours}
              aria-invalid={errors.gapHours ? true : undefined}
              aria-describedby={described}
              onChange={set('gapHours')}
            />
          )}
        </Field>
        <Field
          id="count"
          label="Number of reminders"
          hint="After the last one the item is escalated and marked overdue."
          error={errors.count}
        >
          {(described) => (
            <select
              id="count"
              className={errors.count ? 'input err' : 'input'}
              value={value.count}
              aria-invalid={errors.count ? true : undefined}
              aria-describedby={described}
              onChange={set('count')}
            >
              {COUNTS.map((n) => (
                <option value={n} key={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <div className="row">
        <button className="btn primary" type="submit" disabled={props.busy}>
          Save changes
        </button>
        {props.saved ? (
          <span className="muted small" role="status">
            Saved. The change applies from the next reminder check.
          </span>
        ) : null}
      </div>
    </form>
  )
}

export function ApprovalSettingsScreen({ brandId }: { brandId: string }) {
  const { session } = useShell()
  const role = roleIn(session, brandId)
  const mayEdit = role === 'owner' || role === 'brand_admin'
  const loaded = useLoad(
    () =>
      mayEdit
        ? api(approvalSettingsReply, 'GET', `/brands/${brandId}/approval-settings`)
        : Promise.resolve(null),
    `${brandId}:${mayEdit}`,
  )
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [errors, setErrors] = useState<SettingsErrors>({})
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (loaded.state === 'ready' && loaded.data) setForm(formFromSettings(loaded.data))
  }, [loaded.state, loaded.data])

  const save = async () => {
    if (!form) return
    const checked = settingsFromForm(form)
    setSaved(false)
    if (!checked.ok) {
      setErrors(checked.errors)
      return
    }
    setBusy(true)
    setErrors({})
    try {
      const stored = await api(
        approvalSettingsReply,
        'PATCH',
        `/brands/${brandId}/approval-settings`,
        checked.change,
      )
      setForm(formFromSettings(stored))
      setSaved(true)
    } catch (error) {
      const placed = settingsFieldErrors(error)
      setErrors(
        Object.keys(placed).length > 0 ? placed : { form: 'The settings could not be saved. Try again.' },
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <main id="content" className="page narrow">
      <div className="page-head">
        <div>
          <h1>Approval settings</h1>
          <p>
            When approvers are reminded, and how many times before an item is escalated and marked overdue.
          </p>
        </div>
      </div>
      {!mayEdit ? (
        <div className="callout warn" role="alert">
          Only the platform owner and the brand admin can change approval settings.
        </div>
      ) : null}
      {loaded.state === 'error' ? (
        <LoadError what="the approval settings" error={loaded.error} onRetry={loaded.retry} />
      ) : null}
      {mayEdit && loaded.state === 'loading' ? <p className="muted">Loading…</p> : null}
      {form ? (
        <>
          <ApprovalSettingsForm
            value={form}
            errors={errors}
            busy={busy}
            saved={saved}
            onChange={(next) => {
              setForm(next)
              setSaved(false)
            }}
            onSave={() => void save()}
          />
          <div className="callout warn mt-4">
            <b>Silence is never approval.</b> Escalation changes who is asked; it never makes the decision. An
            overdue item stays unapproved and unpublished until someone approves or rejects it.
          </div>
        </>
      ) : null}
    </main>
  )
}
