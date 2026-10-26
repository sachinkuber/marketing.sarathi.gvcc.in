import nodemailer from 'nodemailer'
import { describe, expect, it } from 'vitest'
import { UnconfiguredMailer } from '../src/adapters.ts'
import { loadConfig } from '../src/config.ts'
import { errorName } from '../src/notify/ports.ts'
import {
  MailSendFailed,
  defaultTransport,
  mailerFromConfig,
  smtpMailer,
  type MailTransport,
} from '../src/notify/smtp.ts'

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

  it('writes the headers and body of the message it sends through the stream transport', async () => {
    let raw = ''
    const real = streamTransport()
    const mailer = smtpMailer({
      url: URL_WITH_SECRET,
      from: FROM,
      makeTransport: () => ({
        sendMail: async (options) => {
          const info = (await real.sendMail(options)) as unknown as { message: Buffer; messageId: string }
          raw = info.message.toString()
          return info
        },
      }),
    })
    const receipt = await mailer.send({ to: TO, subject: 'S', text: 'T' })
    expect(receipt.providerId).toBeTruthy()
    expect(raw).toContain('From: Marketing Sarathi <noreply@example.test>')
    expect(raw).toContain(`To: ${TO}`)
    expect(raw).toContain('Subject: S')
    expect(raw).toContain('T')
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
    expect(e.code).toBe('EENVELOPE')
  })

  it('keeps a short upper-case code and replaces anything else with UNKNOWN', async () => {
    const codeOf = async (code: unknown) => {
      const mailer = smtpMailer({
        url: URL_WITH_SECRET,
        from: FROM,
        makeTransport: () => ({
          sendMail: async () => {
            throw Object.assign(new Error('x'), { code })
          },
        }),
      })
      const error = (await mailer.send({ to: TO, subject: 'S', text: 'T' }).catch((e: unknown) => e)) as {
        code?: string
      }
      return error.code
    }
    expect(await codeOf('EAUTH')).toBe('EAUTH')
    expect(await codeOf('ETIMEDOUT')).toBe('ETIMEDOUT')
    expect(await codeOf(`535 ${TO} bad`)).toBe('UNKNOWN')
    expect(await codeOf(undefined)).toBe('UNKNOWN')
    expect(await codeOf(535)).toBe('UNKNOWN')
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

  it('requires MAIL_FROM to be an address or Name <address>, naming only the variable', () => {
    for (const ok of ['noreply@example.test', FROM, '"Sarathi, Marketing" <noreply@example.test>']) {
      expect(loadConfig({ ...base, SMTP_URL: URL_WITH_SECRET, MAIL_FROM: ok }).mailFrom).toBe(ok)
    }
    for (const bad of [
      'not an address',
      'Name <nope>',
      'a@b',
      '<a@b.test> trailing',
      'x@y.test\r\nBcc: z@y.test',
    ]) {
      expect(() => loadConfig({ ...base, SMTP_URL: URL_WITH_SECRET, MAIL_FROM: bad })).toThrow(
        'Invalid configuration: MAIL_FROM',
      )
    }
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

describe('the default transport', () => {
  it('holds the timeouts and the credentials as transport options, not as message defaults', () => {
    const transport = defaultTransport(URL_WITH_SECRET, {
      connectionTimeout: 1111,
      greetingTimeout: 2222,
      socketTimeout: 3333,
    }) as unknown as { options: Record<string, unknown> }
    expect(transport.options).toMatchObject({
      host: 'smtp.example.test',
      port: 587,
      connectionTimeout: 1111,
      greetingTimeout: 2222,
      socketTimeout: 3333,
      auth: { user: 'mailuser', pass: 'hunter2-secret' },
    })
  })
})
