import nodemailer from 'nodemailer'
import { describe, expect, it } from 'vitest'
import { UnconfiguredMailer } from '../src/adapters.ts'
import { loadConfig } from '../src/config.ts'
import { errorName } from '../src/notify/ports.ts'
import { MailSendFailed, mailerFromConfig, smtpMailer, type MailTransport } from '../src/notify/smtp.ts'

const URL_WITH_SECRET = 'smtp://mailuser:hunter2-secret@smtp.example.test:587'
const FROM = 'Marketing Sarathi <noreply@example.test>'
const TO = 'person@example.test'

const streamTransport = (): MailTransport =>
  nodemailer.createTransport({ streamTransport: true, buffer: true }) as unknown as MailTransport

describe('smtpMailer', () => {
  it('sends the configured from, the recipient, subject and text, and returns the message id', async () => {
    const seen: unknown[] = []
    const real = streamTransport()
    const mailer = smtpMailer({
      url: URL_WITH_SECRET,
      from: FROM,
      makeTransport: () => ({
        sendMail: async (options) => {
          seen.push(options)
          return real.sendMail(options)
        },
      }),
    })
    const receipt = await mailer.send({ to: TO, subject: 'Hello', text: 'Body text' })
    expect(receipt.providerId).toMatch(/^<.+@.+>$/)
    expect(seen[0]).toMatchObject({ from: FROM, to: TO, subject: 'Hello', text: 'Body text' })
  })

  it('produces a real message with the headers and body when sent through the stream transport', async () => {
    const real = streamTransport()
    const mailer = smtpMailer({ url: URL_WITH_SECRET, from: FROM, makeTransport: () => real })
    const info = (await real.sendMail({ from: FROM, to: TO, subject: 'S', text: 'T' })) as unknown as {
      message: Buffer
    }
    const raw = info.message.toString()
    expect(raw).toContain('From: Marketing Sarathi <noreply@example.test>')
    expect(raw).toContain(`To: ${TO}`)
    expect(raw).toContain('Subject: S')
    expect((await mailer.send({ to: TO, subject: 'S', text: 'T' })).providerId).toBeTruthy()
  })

  it('creates one transport per process, with the three timeouts', async () => {
    const created: { url: string; options: unknown }[] = []
    const mailer = smtpMailer({
      url: URL_WITH_SECRET,
      from: FROM,
      timeoutMs: 4_000,
      makeTransport: (url, options) => {
        created.push({ url, options })
        return streamTransport()
      },
    })
    await mailer.send({ to: TO, subject: 'a', text: 'a' })
    await mailer.send({ to: TO, subject: 'b', text: 'b' })
    expect(created).toHaveLength(1)
    expect(created[0]?.options).toEqual({
      connectionTimeout: 4_000,
      greetingTimeout: 4_000,
      socketTimeout: 4_000,
    })
  })

  it('defaults the timeouts to 10 seconds', async () => {
    let options: unknown
    const mailer = smtpMailer({
      url: URL_WITH_SECRET,
      from: FROM,
      makeTransport: (_url, o) => {
        options = o
        return streamTransport()
      },
    })
    await mailer.send({ to: TO, subject: 'a', text: 'a' })
    expect(options).toEqual({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000 })
  })

  it('turns a transport error into MailSendFailed carrying the error name only', async () => {
    const failing: MailTransport = {
      sendMail: async () => {
        throw Object.assign(new Error(`550 5.1.1 <${TO}> user unknown at ${URL_WITH_SECRET}`), {
          code: 'EENVELOPE',
          response: `550 mailbox ${TO} refused`,
        })
      },
    }
    const mailer = smtpMailer({ url: URL_WITH_SECRET, from: FROM, makeTransport: () => failing })
    const error = await mailer.send({ to: TO, subject: 'S', text: 'T' }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(MailSendFailed)
    const e = error as MailSendFailed
    expect(e.name).toBe('MailSendFailed')
    const everything = [e.message, e.stack ?? '', JSON.stringify(e), String(e), errorName(e)].join('\n')
    expect(everything).toContain('EENVELOPE')
    for (const leak of [TO, 'user unknown', 'refused', 'hunter2', 'smtp.example.test', 'mailuser']) {
      expect(everything).not.toContain(leak)
    }
    expect((e as { cause?: unknown }).cause).toBeUndefined()
  })

  it('fails a send that returns no message id', async () => {
    const mailer = smtpMailer({
      url: URL_WITH_SECRET,
      from: FROM,
      makeTransport: () => ({ sendMail: async () => ({ messageId: '' }) }),
    })
    await expect(mailer.send({ to: TO, subject: 'S', text: 'T' })).rejects.toBeInstanceOf(MailSendFailed)
  })
})

describe('mailerFromConfig', () => {
  it('uses the SMTP adapter when both are set and the unconfigured mailer when neither is', () => {
    expect(mailerFromConfig({ smtpUrl: URL_WITH_SECRET, mailFrom: FROM })).not.toBeInstanceOf(
      UnconfiguredMailer,
    )
    expect(mailerFromConfig({})).toBeInstanceOf(UnconfiguredMailer)
  })

  it('refuses exactly one of the two, naming the missing variable and never the url', () => {
    const noFrom = () => mailerFromConfig({ smtpUrl: URL_WITH_SECRET })
    expect(noFrom).toThrow('Invalid configuration: MAIL_FROM')
    expect(noFrom).not.toThrow('hunter2')
    expect(() => mailerFromConfig({ mailFrom: FROM })).toThrow('Invalid configuration: SMTP_URL')
  })
})

describe('mail configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://app:pw@127.0.0.1:5432/mkt',
    AUDIT_DATABASE_URL: 'postgres://audit:pw@127.0.0.1:5432/mkt',
    QUEUE_DATABASE_URL: 'postgres://queue:pw@127.0.0.1:5432/mkt',
    OWNER_VIEW_DATABASE_URL: 'postgres://owner:pw@127.0.0.1:5432/mkt',
    AUTH_SECRET: 'a'.repeat(32),
    WORKER_SECRET: 'w'.repeat(32),
    ATTEMPT_TOKEN_SECRET: 't'.repeat(32),
    TRIGGER_SECRET: 'g'.repeat(32),
    PUBLIC_ORIGIN: 'https://app.example.test',
  }

  it('reads neither, or both', () => {
    expect(loadConfig(base)).toMatchObject({ smtpUrl: undefined, mailFrom: undefined })
    expect(loadConfig({ ...base, SMTP_URL: URL_WITH_SECRET, MAIL_FROM: FROM })).toMatchObject({
      smtpUrl: URL_WITH_SECRET,
      mailFrom: FROM,
    })
  })

  it('treats an empty value as unset', () => {
    expect(loadConfig({ ...base, SMTP_URL: '', MAIL_FROM: '' })).toMatchObject({ smtpUrl: undefined })
  })

  it('refuses SMTP_URL without MAIL_FROM and the reverse, naming only the missing variable', () => {
    expect(() => loadConfig({ ...base, SMTP_URL: URL_WITH_SECRET })).toThrow(
      'Invalid configuration: MAIL_FROM',
    )
    expect(() => loadConfig({ ...base, SMTP_URL: URL_WITH_SECRET })).not.toThrow('hunter2')
    expect(() => loadConfig({ ...base, MAIL_FROM: FROM })).toThrow('Invalid configuration: SMTP_URL')
  })

  it('names SMTP_URL only, never its value, when it is malformed', () => {
    let message = ''
    try {
      loadConfig({ ...base, SMTP_URL: 'not a url hunter2', MAIL_FROM: FROM })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toBe('Invalid configuration: SMTP_URL')
  })
})
