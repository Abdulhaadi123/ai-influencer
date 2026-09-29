/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Email — sent over SMTP.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two emails exist: confirm your address, and reset your password. Each carries
 * a one-time link to a page on THIS server (api/auth/pages.js) — an https link,
 * not a link straight into the app. Mail clients such as Gmail strip links with
 * custom schemes like `aiinfluencer://`, and a web page also works when the
 * email is opened on a computer.
 *
 * Needs SMTP_HOST, SMTP_USER, SMTP_PASS and EMAIL_FROM. Without them, outside
 * production, the email is written to the log instead — so sign-up and password
 * reset can be tried locally. In production missing settings are an error, never
 * a silent skip.
 *
 * ── Why SMTP and not a provider's HTTP API ───────────────────────────────────
 *
 * This used to post to SendGrid's REST API, which meant an account, a verified
 * sending domain and an API key before a single email could go out. SMTP works
 * with any mailbox that offers it — a Gmail app password, a hosting provider's
 * mailbox, or a transactional service later on — and changing provider becomes
 * four environment variables rather than a code change.
 *
 * Nothing rewrites the links. A provider's click tracking would route one-time
 * verification and reset tokens through a third party's redirector, which both
 * leaks the token and breaks the link when the tracker expires.
 */

import nodemailer from 'nodemailer'

const SMTP_HOST = process.env.SMTP_HOST || ''
const SMTP_PORT = Number(process.env.SMTP_PORT || 465)
const SMTP_USER = process.env.SMTP_USER || ''
const SMTP_PASS = process.env.SMTP_PASS || ''

/**
 * 465 is implicit TLS; 587 starts plain and upgrades with STARTTLS. Derived
 * from the port so the two settings cannot contradict each other, and
 * overridable for a server that does something unusual.
 */
const SMTP_SECURE = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE === 'true'
  : SMTP_PORT === 465

/**
 * Gmail — and most providers — require the From address to be the mailbox that
 * authenticated, and silently rewrite or reject anything else. So it defaults to
 * the SMTP user rather than being a third value to keep in step by hand.
 */
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || process.env.APP_NAME || 'AI Influencer'
const APP_NAME = process.env.APP_NAME || 'AI Influencer'
const isProduction = process.env.NODE_ENV === 'production'

/**
 * `EMAIL_TRANSPORT=log` writes every email to the server log instead of sending
 * it, so a server can be tested before its sending domain is verified: the link
 * is read out of `docker compose logs api`.
 *
 * It has to be asked for by name. Falling back to logging on its own would mean
 * a server with a mistyped key quietly never delivering anything, while sign-up
 * still told people to check their inbox.
 */
const LOG_ONLY = process.env.EMAIL_TRANSPORT === 'log'

export function emailConfigured() {
  return LOG_ONLY || !!(SMTP_HOST && SMTP_USER && SMTP_PASS && EMAIL_FROM)
}

/** Whether mail is only being logged — the server says so loudly at startup. */
export function emailLogOnly() {
  return LOG_ONLY
}

/**
 * The public address of this server, for links in emails —
 * e.g. https://api.your-domain.com. Locally it defaults to the dev server.
 */
export function publicBaseUrl() {
  const configured = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  if (configured) return configured
  if (isProduction) throw new Error('PUBLIC_BASE_URL is not set on the server.')
  return `http://localhost:${process.env.PORT || 8080}`
}

const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * One pooled connection, made on first use.
 *
 * Built lazily so importing this module never opens a socket — the tests and
 * the worker both load it without sending anything. Pooled because sign-up
 * bursts would otherwise pay a TLS handshake per email, and every timeout is
 * bounded: a mail server that accepts a connection and then goes quiet must not
 * hold a request open.
 */
let transport = null
function transporter() {
  transport ??= nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  })
  return transport
}

/**
 * Open a connection and authenticate, without sending anything.
 *
 * What you want after changing SMTP settings: it separates "the mailbox refused
 * these credentials" from "nothing was configured" and from "the mail server is
 * unreachable", none of which look different once a real send fails inside
 * sendInBackground.
 *
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function verifyTransport() {
  if (LOG_ONLY) return { ok: true, reason: 'EMAIL_TRANSPORT=log — nothing is sent' }
  if (!emailConfigured()) return { ok: false, reason: 'SMTP is not configured' }
  try {
    await transporter().verify()
    return { ok: true, reason: null }
  } catch (e) {
    return { ok: false, reason: [e?.code, e?.response || e?.message].filter(Boolean).join(' — ') }
  }
}

export async function sendEmail({ to, subject, text, html }) {
  if (LOG_ONLY || !emailConfigured()) {
    if (isProduction && !LOG_ONLY) {
      throw new Error('SMTP_HOST, SMTP_USER, SMTP_PASS and EMAIL_FROM must be set on the server.')
    }
    const why = LOG_ONLY ? 'EMAIL_TRANSPORT=log' : 'SMTP is not configured'
    console.log(`[email] ${why} — logging instead of sending.\n  to: ${to}\n  subject: ${subject}\n\n${text}\n`)
    return
  }

  try {
    await transporter().sendMail({
      from: { name: EMAIL_FROM_NAME, address: EMAIL_FROM },
      to,
      subject,
      text,
      html,
    })
  } catch (e) {
    // Never include the credentials in what propagates: this message reaches the
    // server log, and a stack from an auth failure is a common place for one to
    // surface. `code` and `response` are the useful parts (EAUTH, ECONNECTION,
    // and the server's own refusal line).
    const detail = [e?.code, e?.response || e?.message].filter(Boolean).join(' — ')
    throw new Error(`The mail server refused the email: ${String(detail).slice(0, 300)}`)
  }
}

/**
 * Send without making the request wait, and without letting a failure escape.
 *
 * Forgot-password and resend must answer identically whether or not the account
 * exists; waiting for the mail server only when it does would make "exists"
 * measurably slower. The failure still goes to the log, where someone can act
 * on it.
 */
export function sendInBackground(promiseFactory, what) {
  Promise.resolve()
    .then(promiseFactory)
    .catch(e => console.error(`[email] ${what} failed:`, e?.message ?? e))
}

function layout(heading, paragraphs, link, buttonText, footer) {
  const body = paragraphs.map(p => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join('')
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
<h1 style="font-size:22px;margin:0 0 16px">${escapeHtml(heading)}</h1>
${body}
<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#6d4aff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${escapeHtml(buttonText)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#6e6e73;word-break:break-all">Or open this link: ${escapeHtml(link)}</p>
<p style="margin:0;font-size:13px;color:#6e6e73">${escapeHtml(footer)}</p>
</div></body></html>`
}

export function confirmationEmail({ to, displayName, link }) {
  const hello = displayName ? `Hi ${displayName},` : 'Hi,'
  const intro = `Thank you for signing up for ${APP_NAME}. Please verify your email address to activate your account.`
  const footer = 'This link can be used once and expires in 24 hours. If you did not create an account, you can ignore this email.'
  return {
    to,
    subject: `Verify your email address for ${APP_NAME}`,
    text: `${hello}\n\n${intro}\n\n${link}\n\n${footer}`,
    html: layout('Verify your email', [hello, intro], link, 'Verify email', footer),
  }
}

export function passwordResetEmail({ to, link }) {
  const intro = `We received a request to reset the password for your ${APP_NAME} account. Use the link below to set a new password.`
  const footer = 'This link can be used once and expires in 1 hour. If you did not request a password reset, you can ignore this email and your password will remain unchanged.'
  return {
    to,
    subject: `Reset your ${APP_NAME} password`,
    text: `Hi,\n\n${intro}\n\n${link}\n\n${footer}`,
    html: layout('Reset your password', ['Hi,', intro], link, 'Reset password', footer),
  }
}
