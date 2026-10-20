import nodemailer from 'nodemailer'
import { UnconfiguredMailer } from '../adapters.ts'
import type { MailMessage, Mailer, SendReceipt } from '../ports.ts'
import { errorName, SEND_TIMEOUT_MS } from './ports.ts'

// The part of a Nodemailer transport the adapter uses. Tests pass Nodemailer's own stream transport.
export interface MailTransport {
  sendMail(options: {
    from: string
    to: string
    subject: string
    text: string
  }): Promise<{ messageId?: string | null }>
}

export interface TransportTimeouts {
  connectionTimeout: number
  greetingTimeout: number
  socketTimeout: number
}

// A send that failed. The message is the name of the underlying error and nothing else: the real one can
// hold the recipient, the server's reply or the connection URL with its credentials. There is no `cause`.
export class MailSendFailed extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'MailSendFailed'
  }
}

export interface SmtpMailerOptions {
  // The connection URL, which carries the credentials: never logged, never put in an error.
  url: string
  from: string
  // One limit for connecting, the greeting and an idle socket (milliseconds).
  timeoutMs?: number
  makeTransport?: (url: string, timeouts: TransportTimeouts) => MailTransport
}

const defaultTransport = (url: string, timeouts: TransportTimeouts): MailTransport =>
  nodemailer.createTransport(url, timeouts)

// Sends through SMTP. Exactly one transport is made for the process, on the first send, and reused.
export function smtpMailer(options: SmtpMailerOptions): Mailer {
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS
  const make = options.makeTransport ?? defaultTransport
  let transport: MailTransport | undefined
  return {
    async send(message: MailMessage): Promise<SendReceipt> {
      let messageId: string | null | undefined
      try {
        transport ??= make(options.url, {
          connectionTimeout: timeoutMs,
          greetingTimeout: timeoutMs,
          socketTimeout: timeoutMs,
        })
        const info = await transport.sendMail({
          from: options.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
        })
        messageId = info.messageId
      } catch (error) {
        throw new MailSendFailed(errorName(error))
      }
      if (!messageId) throw new MailSendFailed('NoMessageId')
      return { providerId: messageId }
    },
  }
}

// Both set: the SMTP adapter. Neither: the stand-in that refuses every send. One only is a configuration
// error naming the missing variable (config.ts refuses it first; this holds when it is called alone).
export function mailerFromConfig(config: { smtpUrl?: string; mailFrom?: string }): Mailer {
  if (config.smtpUrl && config.mailFrom) return smtpMailer({ url: config.smtpUrl, from: config.mailFrom })
  if (config.smtpUrl) throw new Error('Invalid configuration: MAIL_FROM')
  if (config.mailFrom) throw new Error('Invalid configuration: SMTP_URL')
  return new UnconfiguredMailer()
}
