import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '../src/api/client'
import {
  ApprovalSettingsForm,
  formFromSettings,
  settingsFieldErrors,
  settingsFromForm,
} from '../src/screens/ApprovalSettings'

const noop = () => {}
const stored = { firstReminderAfterMinutes: 1440, reminderGapMinutes: 720, reminderCount: 3 }

describe('approval settings', () => {
  it('shows 1440 minutes as 24 hours, and sends 24 hours back as 1440 minutes', () => {
    const form = formFromSettings(stored)
    expect(form).toEqual({ firstHours: '24', gapHours: '12', count: '3' })
    const html = renderToStaticMarkup(
      <ApprovalSettingsForm
        value={form}
        errors={{}}
        busy={false}
        saved={false}
        onChange={noop}
        onSave={noop}
      />,
    )
    expect(html).toMatch(/id="first-hours"[^>]*value="24"|value="24"[^>]*id="first-hours"/)
    expect(settingsFromForm(form)).toEqual({ ok: true, change: stored })
    expect(settingsFromForm({ firstHours: '1.5', gapHours: '48', count: '1' })).toEqual({
      ok: true,
      change: { firstReminderAfterMinutes: 90, reminderGapMinutes: 2880, reminderCount: 1 },
    })
  })

  it('offers a reminder count of 1 to 5 only', () => {
    const html = renderToStaticMarkup(
      <ApprovalSettingsForm
        value={formFromSettings(stored)}
        errors={{}}
        busy={false}
        saved={false}
        onChange={noop}
        onSave={noop}
      />,
    )
    const options = [...html.matchAll(/<option value="(\d+)"/g)].map((m) => m[1])
    expect(options).toEqual(['1', '2', '3', '4', '5'])
    expect(settingsFromForm({ firstHours: '24', gapHours: '24', count: '6' })).toMatchObject({
      ok: false,
      errors: { count: expect.any(String) },
    })
    expect(settingsFromForm({ firstHours: '0', gapHours: 'x', count: '3' })).toMatchObject({
      ok: false,
      errors: { firstHours: expect.any(String), gapHours: expect.any(String) },
    })
    expect(html).not.toMatch(/\sstyle=/)
  })

  it('puts the API’s validation errors on the field they belong to', () => {
    const error = new ApiError(400, 'invalid_request', 'The request is not valid.', [
      { part: 'body', path: 'reminderCount', message: 'Too big: expected number to be <=5' },
      { part: 'body', path: 'firstReminderAfterMinutes', message: 'Too big' },
    ])
    const errors = settingsFieldErrors(error)
    expect(errors).toEqual({ count: 'Too big: expected number to be <=5', firstHours: 'Too big' })
    const html = renderToStaticMarkup(
      <ApprovalSettingsForm
        value={formFromSettings(stored)}
        errors={errors}
        busy={false}
        saved={false}
        onChange={noop}
        onSave={noop}
      />,
    )
    expect(html).toContain('Too big: expected number to be &lt;=5')
    expect(html).toMatch(/id="count"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*id="count"/)
    expect(html).toMatch(/aria-describedby="[^"]*\bcount-error\b[^"]*"/)
    expect(html).toContain('id="count-error"')
    expect(settingsFieldErrors(new ApiError(500, 'internal_error', 'x'))).toEqual({})
  })
})
