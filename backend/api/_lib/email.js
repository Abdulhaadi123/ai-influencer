/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Email — sent through SendGrid.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two emails exist: confirm your address, and reset your password. Each carries
 * a one-time link to a page on THIS server (api/auth/pages.js) — an https link,
 * not a link straight into the app. Mail clients such as Gmail strip links with
 * custom schemes like `aiinfluencer://`, and a web page also works when the
 * email is opened on a computer.
 *
 * Needs SENDGRID_API_KEY and EMAIL_FROM (an address on a domain verified in
 * SendGrid). Without them, outside production, the email is written to the log
 * instead — so sign-up and password reset can be tried locally. In production a
 * missing key is an error, never a silent skip.
 *
 * SendGrid's click tracking is turned off for every message: it rewrites links
 * through SendGrid's own domain, which would send one-time tokens through a
 * third party and break the link besides.
 */

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || ''
const EMAIL_FROM = process.env.EMAIL_FROM || ''
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || process.env.APP_NAME || 'AI Influencer'
const APP_NAME = process.env.APP_NAME || 'AI Influencer'
const isProduction = process.env.NODE_ENV === 'production'

export function emailConfigured() {
  return !!(SENDGRID_API_KEY && EMAIL_FROM)
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

export async function sendEmail({ to, subject, text, html }) {
  if (!emailConfigured()) {
    if (isProduction) throw new Error('SENDGRID_API_KEY and EMAIL_FROM must be set on the server.')
    console.log(`[email] SendGrid is not configured — logging instead of sending.\n  to: ${to}\n  subject: ${subject}\n\n${text}\n`)
    return
  }

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: { email: EMAIL_FROM, name: EMAIL_FROM_NAME },
      personalizations: [{ to: [{ email: to }] }],
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
      tracking_settings: {
        click_tracking: { enable: false, enable_text: false },
        open_tracking: { enable: false },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`SendGrid refused the email (HTTP ${res.status}): ${detail.slice(0, 300)}`)
  }
}

/**
 * Send without making the request wait, and without letting a failure escape.
 *
 * Forgot-password and resend must answer identically whether or not the account
 * exists; waiting for SendGrid only when it does would make "exists" measurably
 * slower. The failure still goes to the log, where someone can act on it.
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
  const intro = `Confirm your email address to finish creating your ${APP_NAME} account.`
  const footer = 'The link works once and expires in 24 hours. If you did not create an account, you can ignore this email.'
  return {
    to,
    subject: `Confirm your email for ${APP_NAME}`,
    text: `${hello}\n\n${intro}\n\n${link}\n\n${footer}`,
    html: layout('Confirm your email', [hello, intro], link, 'Confirm my email', footer),
  }
}

export function passwordResetEmail({ to, link }) {
  const intro = `Someone asked to reset the password for your ${APP_NAME} account. Choose a new password here:`
  const footer = 'The link works once and expires in 1 hour. If this was not you, ignore this email — your password stays the same.'
  return {
    to,
    subject: `Reset your ${APP_NAME} password`,
    text: `Hi,\n\n${intro}\n\n${link}\n\n${footer}`,
    html: layout('Reset your password', ['Hi,', intro], link, 'Choose a new password', footer),
  }
}
