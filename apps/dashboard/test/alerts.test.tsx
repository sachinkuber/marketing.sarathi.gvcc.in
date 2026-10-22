import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AlertList } from '../src/screens/Alerts'

const brandId = '6c77c301-7cb4-4c81-8551-1a0fbe6dce41'
const noop = () => {}

const alert = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  severity: 2,
  kind: 'dead_job',
  detail: { jobId: 'j1' },
  raisedAt: '2026-10-20T10:00:00.000Z',
  acknowledgedBy: null,
  acknowledgedAt: null,
  resolvedAt: null,
  delivered: true,
  deliveryAttempts: 1,
  deliveryStalled: false,
  deliveryIssue: null,
  ...extra,
})

describe('alerts', () => {
  it('shows open alerts with severity, kind, raised time and delivery state, and an acknowledge button', () => {
    const html = renderToStaticMarkup(
      <AlertList
        brandId={brandId}
        alerts={[
          alert('e0000000-0000-4000-8000-000000000001'),
          alert('e0000000-0000-4000-8000-000000000002', {
            severity: 1,
            kind: 'audit_chain_mismatch',
            delivered: false,
            deliveryAttempts: 4,
            deliveryStalled: true,
            deliveryIssue: 'smtp_failed',
          }),
        ]}
        canAck
        busyId={null}
        error={null}
        onAck={noop}
      />,
    )
    expect(html).toContain('Severity 1')
    expect(html).toContain('Severity 2')
    expect(html).toContain('A job is in dead letters')
    expect(html).toContain('The audit log does not match')
    expect(html).toMatch(/<time datetime="2026-10-20T10:00:00.000Z"/i)
    expect(html).toContain('Delivered')
    expect(html).toContain('Delivery stalled after 4 attempts')
    expect(html.match(/>Acknowledge</g)).toHaveLength(2)
    expect(html).toContain(`href="/b/${brandId}/agents/dead-letters"`)
    expect(html).toContain(`href="/b/${brandId}/settings/audit"`)
    expect(html).not.toMatch(/\sstyle=/)
  })

  it('lists acknowledged alerts apart, without the button, and hides it from people who cannot acknowledge', () => {
    const html = renderToStaticMarkup(
      <AlertList
        brandId={null}
        alerts={[
          alert('e0000000-0000-4000-8000-000000000003', { acknowledgedAt: '2026-10-20T11:00:00.000Z' }),
        ]}
        canAck
        busyId={null}
        error={null}
        onAck={noop}
      />,
    )
    expect(html).toContain('Acknowledged')
    expect(html).not.toContain('>Acknowledge<')
    const readOnly = renderToStaticMarkup(
      <AlertList
        brandId={brandId}
        alerts={[alert('e0000000-0000-4000-8000-000000000004')]}
        canAck={false}
        busyId={null}
        error={null}
        onAck={noop}
      />,
    )
    expect(readOnly).not.toContain('>Acknowledge<')
  })

  it('says what will appear when there are no alerts', () => {
    const html = renderToStaticMarkup(
      <AlertList brandId={brandId} alerts={[]} canAck busyId={null} error={null} onAck={noop} />,
    )
    expect(html).toContain('No open alerts')
    expect(html).toContain(
      'Alerts appear here when a job fails for good, a delivery stalls or the audit check finds a problem.',
    )
  })
})
