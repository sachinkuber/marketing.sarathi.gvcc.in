import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EnrolSetup } from '../src/auth/EnrolSetup'
import { BackupCodes } from '../src/auth/BackupCodes'
import { SignInForm } from '../src/auth/SignInForm'
import { VerifyForm } from '../src/auth/VerifyForm'
import { RecoverForm } from '../src/auth/RecoverForm'
import { InviteForm } from '../src/auth/InviteForm'

const noop = () => {}
const URI =
  'otpauth://totp/Marketing%20platform:a%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Marketing%20platform'

describe('enrolment', () => {
  it('shows the setup key and the otpauth link and never a QR image', () => {
    const html = renderToStaticMarkup(
      <EnrolSetup totpUri={URI} secret="JBSWY3DPEHPK3PXP" busy={false} error={null} onVerify={noop} />,
    )
    expect(html).toContain('JBSWY3DPEHPK3PXP')
    expect(html).toContain(`href="${URI.replaceAll('&', '&amp;')}"`)
    expect(html).not.toMatch(/<img|<canvas|<svg|qr/i)
    expect(html).toMatch(/inputmode="numeric"/i)
  })

  it('shows the backup codes once and keeps Continue off until they are confirmed saved', () => {
    const html = renderToStaticMarkup(<BackupCodes codes={['4F7K-92QD', 'H3PM-7XW2']} onContinue={noop} />)
    expect(html).toContain('4F7K-92QD')
    expect(html).toContain('I have saved these codes')
    expect(html).toMatch(/<input[^>]*type="checkbox"/)
    expect(html).not.toMatch(/<input[^>]*checked/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Continue<\/button>/)
  })
})

describe('sign-in screens', () => {
  it('sign-in asks for email and password and offers recovery', () => {
    const html = renderToStaticMarkup(<SignInForm busy={false} error={null} onSubmit={noop} />)
    expect(html).toContain('type="email"')
    expect(html).toContain('type="password"')
    expect(html).toContain('href="/recover"')
    expect(html).toContain('Sign in')
  })

  it('shows the wrong-credentials message as an alert', () => {
    const html = renderToStaticMarkup(
      <SignInForm busy={false} error="The email or password is not right." onSubmit={noop} />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('The email or password is not right.')
  })

  it('the code screen takes six digits and offers a backup code', () => {
    const html = renderToStaticMarkup(
      <VerifyForm useBackup={false} busy={false} error={null} onSubmit={noop} onToggle={noop} />,
    )
    expect(html).toContain('Enter your code')
    expect(html).toContain('Use a backup code instead')
    const backup = renderToStaticMarkup(
      <VerifyForm useBackup busy={false} error={null} onSubmit={noop} onToggle={noop} />,
    )
    expect(backup).toContain('Backup code')
  })

  it('recovery asks for an email and states the same answer for every address', () => {
    const asking = renderToStaticMarkup(
      <RecoverForm sent={false} busy={false} error={null} onSubmit={noop} />,
    )
    expect(asking).toContain('Send recovery email')
    const sent = renderToStaticMarkup(<RecoverForm sent busy={false} error={null} onSubmit={noop} />)
    expect(sent).toContain('Check your email')
    expect(sent).toContain('If an account exists')
  })

  it('an invite shows brand, role and email and asks for a name and password', () => {
    const html = renderToStaticMarkup(
      <InviteForm
        state={{
          kind: 'ready',
          invite: { email: 'priya@example.test', role: 'approver', brandName: 'Aztek Global' },
        }}
        busy={false}
        error={null}
        onSubmit={noop}
      />,
    )
    expect(html).toContain('Aztek Global')
    expect(html).toContain('Brand approver')
    expect(html).toContain('priya@example.test')
    expect(html).toMatch(/autocomplete="new-password"/i)
    expect(html).toContain('Your name')
  })

  it('an invite that no longer works says so and nothing else', () => {
    const html = renderToStaticMarkup(
      <InviteForm state={{ kind: 'invalid' }} busy={false} error={null} onSubmit={noop} />,
    )
    expect(html).toContain('This invite link no longer works')
    expect(html).not.toContain('type="password"')
  })
})
