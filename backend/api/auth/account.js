/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Accounts: sign up, sign in, sessions, password, profile.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three rules run through this file.
 *
 * 1. NOTHING REVEALS WHETHER AN EMAIL IS REGISTERED.
 *    Sign-in failures say "that email and password combination is not right"
 *    whichever half was wrong; forgot-password and resend always answer "sent";
 *    and those answer at the same speed either way (passwords.js hashes even
 *    for a missing account, emails send in the background). Rate limits are
 *    keyed on the address whether or not it exists. Knowing which addresses are
 *    registered is the first step of a phishing or credential-stuffing run.
 *
 * 2. PASSWORDS ARE HASHED AND DROPPED. See passwords.js.
 *
 * 3. SIGNING IN IS RATE LIMITED — by IP and by address — so a password cannot
 *    be guessed at speed from one machine or across many.
 */

import { one, query, transaction } from '../_lib/db.js'
import { clientIp, bearerToken } from '../_lib/auth.js'
import { publicRoute, userRoute, badRequest, HttpError, noStore, enforceLimit } from '../_lib/http.js'
import { passwordProblem, hashPassword, verifyPassword } from '../_lib/passwords.js'
import { normalizeEmail, emailProblem, text } from '../_lib/validate.js'
import {
  createSession, refreshSession, revokeSession, revokeAllSessions, newToken, hashToken, publicUser,
} from '../_lib/sessions.js'
import {
  sendEmail, sendInBackground, confirmationEmail, passwordResetEmail, publicBaseUrl,
} from '../_lib/email.js'
import { createRateLimiter } from '../../lib/rateLimit.js'

/**
 * Whether a new account must confirm its email before it can sign in. On by
 * default; turning it off signs people in straight after sign-up.
 */
export const REQUIRE_EMAIL_CONFIRMATION = process.env.REQUIRE_EMAIL_CONFIRMATION !== 'false'

export const CONFIRM_TOKEN_TTL_SECONDS = 24 * 60 * 60
export const RESET_TOKEN_TTL_SECONDS = 60 * 60

const signInByIp = createRateLimiter([{ windowMs: 10 * 60_000, max: 30 }])
const signInByEmail = createRateLimiter([{ windowMs: 15 * 60_000, max: 10 }])
const signUpByIp = createRateLimiter([{ windowMs: 60 * 60_000, max: 20 }])
const emailsByAddress = createRateLimiter([{ windowMs: 60_000, max: 1 }, { windowMs: 60 * 60_000, max: 5 }])
const emailsByIp = createRateLimiter([{ windowMs: 60 * 60_000, max: 30 }])
const refreshByIp = createRateLimiter([{ windowMs: 60_000, max: 60 }])
const passwordChecksByUser = createRateLimiter([{ windowMs: 15 * 60_000, max: 10 }])

const INVALID_CREDENTIALS = 'Incorrect email or password.'

const findUserByEmail = email => one('select * from users where lower(email) = $1', [email])

/**
 * A one-time link token. Only its hash is stored. Spent and expired tokens for
 * the user are cleared on the way, so the table does not grow forever.
 */
export async function issueEmailToken(userId, purpose, ttlSeconds) {
  const token = newToken()
  await query('delete from email_tokens where user_id = $1 and (used_at is not null or expires_at < now())', [userId])
  await query(
    `insert into email_tokens (user_id, purpose, token_hash, expires_at)
     values ($1, $2, $3, now() + $4::int * interval '1 second')`,
    [userId, purpose, hashToken(token), ttlSeconds],
  )
  return token
}

function sendConfirmation(user) {
  sendInBackground(async () => {
    const token = await issueEmailToken(user.id, 'confirm_email', CONFIRM_TOKEN_TTL_SECONDS)
    const link = `${publicBaseUrl()}/auth/confirm-email?token=${encodeURIComponent(token)}`
    await sendEmail(confirmationEmail({ to: user.email, displayName: user.display_name, link }))
  }, 'confirmation email')
}

function sendPasswordReset(user) {
  sendInBackground(async () => {
    const token = await issueEmailToken(user.id, 'reset_password', RESET_TOKEN_TTL_SECONDS)
    const link = `${publicBaseUrl()}/auth/reset-password?token=${encodeURIComponent(token)}`
    await sendEmail(passwordResetEmail({ to: user.email, link }))
  }, 'password reset email')
}

function readEmail(body) {
  const email = normalizeEmail(body?.email)
  const problem = emailProblem(email)
  if (problem) throw badRequest(problem, 'INVALID_EMAIL')
  return email
}

const userAgentOf = req => req.headers['user-agent'] || null


// ── Sign up ──────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/signup  { email, password, displayName? }
 * → 201 { needsEmailConfirmation: true }
 * → 201 { needsEmailConfirmation: false, session }   when confirmation is off
 */
export const signUp = publicRoute(async (req, res) => {
  const email = readEmail(req.body)
  const password = req.body?.password
  const problem = passwordProblem(password)
  if (problem) throw badRequest(problem, 'WEAK_PASSWORD')
  enforceLimit(signUpByIp, `ip:${clientIp(req)}`)

  const displayName = text(req.body?.displayName, 80)?.trim() || null

  const existing = await findUserByEmail(email)
  if (existing) return alreadyRegistered(res, existing, password)

  let user
  try {
    user = await one(
      `insert into users (email, password_hash, display_name, email_confirmed_at)
       values ($1, $2, $3, case when $4::boolean then null else now() end)
       returning *`,
      [email, await hashPassword(password), displayName, REQUIRE_EMAIL_CONFIRMATION],
    )
  } catch (e) {
    // Two sign-ups for the same address at the same moment.
    if (e.code === '23505') return alreadyRegistered(res, await findUserByEmail(email), null)
    throw e
  }

  if (REQUIRE_EMAIL_CONFIRMATION) {
    if (emailsByAddress(`email:${email}`).ok) sendConfirmation(user)
    return res.status(201).json({ needsEmailConfirmation: true })
  }

  const session = await createSession(user, { userAgent: userAgentOf(req) })
  noStore(res)
  return res.status(201).json({ needsEmailConfirmation: false, session })
})

/**
 * Sign-up for an address that already has an account.
 *
 * With confirmation on, the answer is identical to a new sign-up — telling the
 * two apart would reveal who is registered — and an unconfirmed account gets
 * its confirmation email again. With confirmation off there is no way to hide
 * it (a new account would be signed in, this one cannot be), so it says so.
 */
async function alreadyRegistered(res, user, password) {
  // Same work as hashing a new password, so the response takes as long.
  if (password) await verifyPassword(null, password)
  if (!REQUIRE_EMAIL_CONFIRMATION) {
    throw new HttpError(409, 'An account with this email already exists. Please sign in instead.', 'EMAIL_TAKEN')
  }
  if (user && !user.email_confirmed_at && emailsByAddress(`email:${user.email}`).ok) sendConfirmation(user)
  return res.status(201).json({ needsEmailConfirmation: true })
}


// ── Sign in / sessions ───────────────────────────────────────────────────────

/** POST /api/auth/login  { email, password } → { session } */
export const signIn = publicRoute(async (req, res) => {
  const email = readEmail(req.body)
  const password = req.body?.password
  if (typeof password !== 'string' || !password) throw badRequest('Enter your password.', 'PASSWORD_REQUIRED')

  enforceLimit(signInByIp, `ip:${clientIp(req)}`)
  enforceLimit(signInByEmail, `email:${email}`)

  const user = await findUserByEmail(email)
  const valid = await verifyPassword(user?.password_hash ?? null, password)
  if (!user || !valid) throw new HttpError(401, INVALID_CREDENTIALS, 'INVALID_CREDENTIALS')

  // Only reached with the right password, so it reveals nothing to a guesser.
  if (REQUIRE_EMAIL_CONFIRMATION && !user.email_confirmed_at) {
    throw new HttpError(403, 'Please verify your email address before signing in. Check your inbox for the verification link.', 'EMAIL_NOT_CONFIRMED')
  }

  const session = await createSession(user, { userAgent: userAgentOf(req) })
  noStore(res)
  res.json({ session })
})

/** POST /api/auth/refresh  { refreshToken } → { session } */
export const refresh = publicRoute(async (req, res) => {
  enforceLimit(refreshByIp, `ip:${clientIp(req)}`)
  const session = await refreshSession(req.body?.refreshToken, { userAgent: userAgentOf(req) })
  if (!session) throw new HttpError(401, 'Your session has expired. Please sign in again.', 'SESSION_EXPIRED')
  noStore(res)
  res.json({ session })
})

/**
 * POST /api/auth/logout  { refreshToken? }  (+ bearer access token)
 *
 * No valid session is required: signing out must work with an expired access
 * token, and holding a token is all it takes to end that token's own session.
 */
export const signOut = publicRoute(async (req, res) => {
  const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null
  await revokeSession({ accessToken: bearerToken(req), refreshToken })
  res.status(204).end()
})


// ── Profile ──────────────────────────────────────────────────────────────────

/** GET /api/auth/me → { user } */
export const me = userRoute(async (req, res, user) => {
  noStore(res)
  const { sessionId, ...visible } = user
  res.json({ user: visible })
})

/** POST /api/auth/me  { displayName } → { user } */
export const updateMe = userRoute(async (req, res, user) => {
  const displayName = text(req.body?.displayName, 80)?.trim() || null
  const row = await one('update users set display_name = $2 where id = $1 returning *', [user.id, displayName])
  noStore(res)
  res.json({ user: publicUser(row) })
})


// ── Passwords ────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/change-password  { currentPassword, newPassword }
 *
 * Asks for the current password, so a phone left signed in is not enough to
 * lock the owner out. Every other device is signed out; this one stays in.
 */
export const changePassword = userRoute(async (req, res, user) => {
  const { currentPassword, newPassword } = req.body || {}
  if (typeof currentPassword !== 'string' || !currentPassword) {
    throw badRequest('Enter your current password.', 'PASSWORD_REQUIRED')
  }
  const problem = passwordProblem(newPassword)
  if (problem) throw badRequest(problem, 'WEAK_PASSWORD')
  if (newPassword === currentPassword) {
    throw badRequest('New password must be different from your current password.', 'SAME_PASSWORD')
  }

  enforceLimit(passwordChecksByUser, `user:${user.id}`)

  const row = await one('select password_hash from users where id = $1', [user.id])
  if (!(await verifyPassword(row?.password_hash ?? null, currentPassword))) {
    throw new HttpError(403, 'Your current password is incorrect.', 'WRONG_PASSWORD')
  }

  const newHash = await hashPassword(newPassword)
  await transaction(async client => {
    await client.query('update users set password_hash = $2, password_changed_at = now() where id = $1', [user.id, newHash])
    // A reset link sent before the change must not undo it.
    await client.query(`delete from email_tokens where user_id = $1 and purpose = 'reset_password'`, [user.id])
    await revokeAllSessions(user.id, { exceptSessionId: user.sessionId, client })
  })

  res.json({ ok: true })
})

/** POST /api/auth/forgot-password  { email } → { sent: true }, whether or not the account exists */
export const forgotPassword = publicRoute(async (req, res) => {
  const email = readEmail(req.body)
  enforceLimit(emailsByIp, `ip:${clientIp(req)}`)
  enforceLimit(emailsByAddress, `email:${email}`)

  const user = await findUserByEmail(email)
  if (user) sendPasswordReset(user)
  res.json({ sent: true })
})

/** POST /api/auth/resend-confirmation  { email } → { sent: true }, whether or not it applies */
export const resendConfirmation = publicRoute(async (req, res) => {
  const email = readEmail(req.body)
  enforceLimit(emailsByIp, `ip:${clientIp(req)}`)
  enforceLimit(emailsByAddress, `email:${email}`)

  const user = await findUserByEmail(email)
  if (user && !user.email_confirmed_at) sendConfirmation(user)
  res.json({ sent: true })
})

/** For account deletion, which asks for the password the same way. */
export async function checkPasswordForUser(user, password) {
  enforceLimit(passwordChecksByUser, `user:${user.id}`)
  const row = await one('select password_hash from users where id = $1', [user.id])
  return verifyPassword(row?.password_hash ?? null, password)
}
