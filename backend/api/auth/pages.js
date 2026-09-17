/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The pages the email links open.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   GET  /auth/confirm-email?token=…   "Confirm my email" button
 *   POST /auth/confirm-email           confirms, then "open the app"
 *   GET  /auth/reset-password?token=…  new-password form
 *   POST /auth/reset-password          sets it, signs out every device
 *
 * Opening a link does NOT use it up; only pressing the button does. Mail
 * security scanners (and link previews) fetch every URL in an email the moment
 * it arrives — if GET spent the token, people would click their link and be
 * told it was already used.
 *
 * These are web pages rather than screens in the app because a link in an email
 * has to be https: Gmail and others strip `aiinfluencer://` links, and a page
 * also works when the email is read on a computer.
 */

import { one, transaction } from '../_lib/db.js'
import { clientIp } from '../_lib/auth.js'
import { sendPage, escapeHtml, openAppLink } from '../_lib/pages.js'
import { passwordProblem, hashPassword, MIN_PASSWORD_LENGTH } from '../_lib/passwords.js'
import { hashToken, revokeAllSessions } from '../_lib/sessions.js'
import { createRateLimiter } from '../../lib/rateLimit.js'

/** Tokens are 256 random bits, so this is not about guessing them — it caps a flood. */
const submitsByIp = createRateLimiter([{ windowMs: 10 * 60_000, max: 30 }])

const tokenFrom = value => (typeof value === 'string' && value.length >= 20 && value.length <= 200 ? value : null)

function findUsableToken(token, purpose) {
  if (!token) return null
  return one(
    `select t.id, t.user_id, u.email
       from email_tokens t
       join users u on u.id = t.user_id
      where t.token_hash = $1 and t.purpose = $2 and t.used_at is null and t.expires_at > now()`,
    [hashToken(token), purpose],
  )
}

function linkUnusable(res, kind) {
  const what = kind === 'reset' ? 'password reset' : 'verification'
  const next = kind === 'reset'
    ? 'To request a new link, open the app and select Forgot password on the sign-in screen.'
    : 'If you have already verified your email, you can sign in. Otherwise, request a new link from the sign-in screen in the app.'
  return sendPage(res, {
    status: 410,
    title: 'Link expired',
    body: `<h1>This link has expired</h1>
<p>This ${what} link has expired or has already been used. Links can be used once, within a limited time.</p>
<p>${escapeHtml(next)}</p>`,
  })
}

function tooMany(res) {
  return sendPage(res, {
    status: 429,
    title: 'Too many attempts',
    body: '<h1>Too many attempts</h1><p>Please wait a few minutes, then open the link from your email again.</p>',
  })
}

function serverTrouble(res, e, tag) {
  console.error(tag, e)
  return sendPage(res, {
    status: 503,
    title: 'Something went wrong',
    body: '<h1>Something went wrong</h1><p>We could not complete your request. Please open the link from your email again in a few minutes.</p>',
  })
}

const pageRoute = (tag, handler) => async (req, res) => {
  try {
    await handler(req, res)
  } catch (e) {
    serverTrouble(res, e, tag)
  }
}


// ── Confirm email ────────────────────────────────────────────────────────────

export const confirmEmailPage = pageRoute('[pages/confirm GET]', async (req, res) => {
  const token = tokenFrom(req.query?.token)
  const found = await findUsableToken(token, 'confirm_email')
  if (!found) return linkUnusable(res, 'confirm')

  sendPage(res, {
    title: 'Verify your email',
    body: `<h1>Verify your email</h1>
<p>Verify <strong>${escapeHtml(found.email)}</strong> to activate your account.</p>
<form method="post" action="/auth/confirm-email">
  <input type="hidden" name="token" value="${escapeHtml(token)}">
  <button type="submit">Verify email</button>
</form>`,
  })
})

export const confirmEmailSubmit = pageRoute('[pages/confirm POST]', async (req, res) => {
  if (!submitsByIp(`ip:${clientIp(req)}`).ok) return tooMany(res)
  const token = tokenFrom(req.body?.token)
  if (!token) return linkUnusable(res, 'confirm')

  const confirmed = await transaction(async client => {
    const { rows } = await client.query(
      `select id, user_id from email_tokens
        where token_hash = $1 and purpose = 'confirm_email' and used_at is null and expires_at > now()
          for update`,
      [hashToken(token)],
    )
    if (!rows[0]) return false
    await client.query('update email_tokens set used_at = now() where id = $1', [rows[0].id])
    await client.query('update users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1', [rows[0].user_id])
    return true
  })
  if (!confirmed) return linkUnusable(res, 'confirm')

  sendPage(res, {
    title: 'Email verified',
    body: `<h1>Email verified</h1>
<p>Your account is now active. Return to the app and sign in.</p>
${openAppLink()}`,
  })
})


// ── Reset password ───────────────────────────────────────────────────────────

function resetForm(res, token, email, error = null, status = 200) {
  return sendPage(res, {
    status,
    title: 'Set a new password',
    body: `<h1>Set a new password</h1>
<p>For <strong>${escapeHtml(email)}</strong>.</p>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
<form method="post" action="/auth/reset-password">
  <input type="hidden" name="token" value="${escapeHtml(token)}">
  <input type="hidden" name="username" value="${escapeHtml(email)}" autocomplete="username">
  <label for="password">New password</label>
  <input id="password" name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}" maxlength="128">
  <p class="hint">Must be at least ${MIN_PASSWORD_LENGTH} characters and include a letter and a number.</p>
  <label for="confirm">Confirm new password</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" required>
  <button type="submit">Update password</button>
</form>`,
  })
}

export const resetPasswordPage = pageRoute('[pages/reset GET]', async (req, res) => {
  const token = tokenFrom(req.query?.token)
  const found = await findUsableToken(token, 'reset_password')
  if (!found) return linkUnusable(res, 'reset')
  resetForm(res, token, found.email)
})

export const resetPasswordSubmit = pageRoute('[pages/reset POST]', async (req, res) => {
  if (!submitsByIp(`ip:${clientIp(req)}`).ok) return tooMany(res)
  const token = tokenFrom(req.body?.token)
  const found = await findUsableToken(token, 'reset_password')
  if (!found) return linkUnusable(res, 'reset')

  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm : ''
  // A form mistake keeps the link usable — only a successful change spends it.
  const problem = passwordProblem(password) || (password !== confirm ? 'Passwords do not match.' : null)
  if (problem) return resetForm(res, token, found.email, problem, 400)

  const newHash = await hashPassword(password)
  const changed = await transaction(async client => {
    const { rows } = await client.query(
      `select id, user_id from email_tokens
        where token_hash = $1 and purpose = 'reset_password' and used_at is null and expires_at > now()
          for update`,
      [hashToken(token)],
    )
    if (!rows[0]) return false
    const userId = rows[0].user_id
    await client.query(`update email_tokens set used_at = now() where user_id = $1 and purpose = 'reset_password' and used_at is null`, [userId])
    // Following a reset link proves the person reads this inbox, so it confirms it too.
    await client.query(
      `update users set password_hash = $2, password_changed_at = now(),
              email_confirmed_at = coalesce(email_confirmed_at, now())
        where id = $1`,
      [userId, newHash],
    )
    // Someone resetting a password may be locking out whoever else got in.
    await revokeAllSessions(userId, { client })
    return true
  })
  if (!changed) return linkUnusable(res, 'reset')

  sendPage(res, {
    title: 'Password updated',
    body: `<h1>Password updated</h1>
<p>Your password has been changed and you have been signed out on all devices. Sign in with your new password.</p>
${openAppLink()}`,
  })
})
