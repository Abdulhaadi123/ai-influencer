/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Accounts: sign up, sign in, sessions, password, profile.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three rules run through this file.
 *
 * 1. SIGN-IN NEVER SAYS WHICH HALF WAS WRONG.
 *    A failed sign-in says "that email and password combination is not right"
 *    whichever half it was, and takes as long either way (passwords.js hashes
 *    even for a missing account). Guessing a password is the attack; telling a
 *    guesser the address is right would halve it. Resend answers "sent" whether
 *    or not the address is registered.
 *
 *    Sign-up and forgot-password say when the address is the problem: "an
 *    account with this email already exists", "no account was found with this
 *    email". They used to answer as if all was well — "check your email" — and
 *    leave the person waiting for a message that never came (signed up twice;
 *    mistyped the address). A sign-up form has to say the address is taken, so
 *    the fact is no secret; the rate limits below, per caller and per address,
 *    keep these from being a cheap way to list registered addresses.
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
import { normalizeEmail, emailProblem, displayNameOf } from '../_lib/validate.js'
import {
  createSession, refreshSession, revokeSession, revokeAllSessions, newToken, hashToken, publicUser,
} from '../_lib/sessions.js'
import {
  sendEmail, sendInBackground, confirmationEmail, passwordResetEmail, publicBaseUrl,
} from '../_lib/email.js'
import { createRateLimiter } from '../../lib/rateLimit.js'
import { SUSPENDED_MESSAGE } from '../_lib/suspension.js'

/**
 * Whether a new account must confirm its email before it can sign in. On by
 * default; turning it off signs people in straight after sign-up.
 */
export const REQUIRE_EMAIL_CONFIRMATION = process.env.REQUIRE_EMAIL_CONFIRMATION !== 'false'

export const CONFIRM_TOKEN_TTL_SECONDS = 24 * 60 * 60
export const RESET_TOKEN_TTL_SECONDS = 60 * 60

// Sign-in is limited three ways, because one limit per address can be turned against its owner: anyone
// who types ten wrong passwords for an address locks that address out for everybody, the owner included.
//   per caller                       30 in 10 minutes   one machine cannot try many accounts
//   per address FROM that caller     10 in 15 minutes   one machine cannot guess one account; the lockout it
//                                                       causes is its own (the owner signs in from elsewhere)
//   per address, from anywhere      100 in an hour      many machines together cannot guess one account either;
//                                                       high enough that locking an owner out takes a real effort
const signInByIp = createRateLimiter([{ windowMs: 10 * 60_000, max: 30 }])
const signInByEmailAndIp = createRateLimiter([{ windowMs: 15 * 60_000, max: 10 }])
const signInByEmail = createRateLimiter([{ windowMs: 60 * 60_000, max: 100 }])
const signUpByIp = createRateLimiter([{ windowMs: 60 * 60_000, max: 20 }])
const emailsByAddress = createRateLimiter([{ windowMs: 60_000, max: 1 }, { windowMs: 60 * 60_000, max: 5 }])
const emailsByIp = createRateLimiter([{ windowMs: 60 * 60_000, max: 30 }])
const refreshByIp = createRateLimiter([{ windowMs: 60_000, max: 60 }])
const passwordChecksByUser = createRateLimiter([{ windowMs: 15 * 60_000, max: 10 }])

const INVALID_CREDENTIALS = 'Incorrect email or password.'

/** What an administrator is told at the app's sign-in (only after the right password). */
const ADMIN_ACCOUNT_MESSAGE = 'This is an administrator account. Sign in to the admin panel; the app needs a regular account.'

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
    await sendEmail(confirmationEmail({ to: user.email, link }))
  }, 'confirmation email')
}

function sendPasswordReset(user) {
  sendInBackground(async () => {
    const token = await issueEmailToken(user.id, 'reset_password', RESET_TOKEN_TTL_SECONDS)
    const link = `${publicBaseUrl()}/auth/reset-password?token=${encodeURIComponent(token)}`
    await sendEmail(passwordResetEmail({ to: user.email, link }))
  }, 'password reset email')
}

const EMAIL_TAKEN = 'An account with this email already exists. Please sign in instead.'
const NO_ACCOUNT = 'No account was found with this email address. Check the spelling, or sign up for a new account.'

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

  const displayName = displayNameOf(req.body?.displayName)

  const existing = await findUserByEmail(email)
  if (existing) return alreadyRegistered(res, existing, password)

  let user
  try {
    // `on conflict do nothing`: two sign-ups for one address at the same moment are decided by the
    // database's unique index, and the loser simply gets no row back — there is no failed statement,
    // no error to catch, and no aborted connection for whatever request is queued behind it.
    user = await one(
      `insert into users (email, password_hash, display_name, email_confirmed_at)
       values ($1, $2, $3, case when $4::boolean then null else now() end)
       on conflict do nothing
       returning *`,
      [email, await hashPassword(password), displayName, REQUIRE_EMAIL_CONFIRMATION],
    )
  } catch (e) {
    if (e.code === '23505') return alreadyRegistered(res, await findUserByEmail(email), null)
    throw e
  }
  if (!user) return alreadyRegistered(res, await findUserByEmail(email), null)

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
 * A confirmed account is answered with an error the app shows on the sign-up form
 * (409 EMAIL_TAKEN) — no email is sent, because the person is looking at the
 * screen. An account that was never confirmed is the same person coming back to
 * finish: they get the confirmation email again and the usual "check your email"
 * answer. Nothing about the existing account changes either way, so signing up
 * with someone else's address cannot touch their password.
 */
async function alreadyRegistered(res, user, password) {
  // Same work as hashing a new password, so the response takes as long.
  if (password) await verifyPassword(null, password)
  if (!user || user.email_confirmed_at || !REQUIRE_EMAIL_CONFIRMATION) {
    throw new HttpError(409, EMAIL_TAKEN, 'EMAIL_TAKEN')
  }
  if (emailsByAddress(`email:${user.email}`).ok) sendConfirmation(user)
  return res.status(201).json({ needsEmailConfirmation: true })
}


// ── Sign in / sessions ───────────────────────────────────────────────────────

/**
 * POST /api/auth/login  { email, password, scope? } → { session }
 *
 * `scope` is where the person is signing in: 'admin' for the admin panel, anything else (the
 * app sends nothing) for the app. Administrator accounts get an admin session and only at the
 * panel; every other account gets an app session and only at the app (sessions.js, "Scope").
 */
export const signIn = publicRoute(async (req, res) => {
  const email = readEmail(req.body)
  const password = req.body?.password
  if (typeof password !== 'string' || !password) throw badRequest('Enter your password.', 'PASSWORD_REQUIRED')
  const scope = req.body?.scope === 'admin' ? 'admin' : 'app'

  const ip = clientIp(req)
  enforceLimit(signInByIp, `ip:${ip}`)
  enforceLimit(signInByEmailAndIp, `email:${email}|ip:${ip}`)
  enforceLimit(signInByEmail, `email:${email}`)

  const user = await findUserByEmail(email)
  const valid = await verifyPassword(user?.password_hash ?? null, password)
  if (!user || !valid) throw new HttpError(401, INVALID_CREDENTIALS, 'INVALID_CREDENTIALS')

  // Only reached with the right password, so it reveals nothing to a guesser.
  if (REQUIRE_EMAIL_CONFIRMATION && !user.email_confirmed_at) {
    throw new HttpError(403, 'Please verify your email address before signing in. Check your inbox for the verification link.', 'EMAIL_NOT_CONFIRMED')
  }

  // Also only after the right password: telling a guesser "suspended" would
  // confirm the address is registered.
  if (user.status === 'suspended') throw new HttpError(403, SUSPENDED_MESSAGE, 'ACCOUNT_SUSPENDED')

  // Also only after the right password. The two places are kept apart in both directions.
  if (scope === 'admin' && user.role !== 'admin') throw new HttpError(403, 'This area is for administrators.', 'NOT_ADMIN')
  if (scope === 'app' && user.role === 'admin') throw new HttpError(403, ADMIN_ACCOUNT_MESSAGE, 'ADMIN_ACCOUNT')

  const session = await createSession(user, { userAgent: userAgentOf(req), scope })
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

// The three that are about the caller's own account (profile, password) are for either kind of
// session: an administrator changes their own password on an admin session.

/** GET /api/auth/me → { user } */
export const me = userRoute(async (req, res, user) => {
  noStore(res)
  // role, status and scope are for the server's own checks, not for the app.
  const { sessionId, role, status, scope, ...visible } = user
  res.json({ user: visible })
}, { audience: 'shared' })

/** POST /api/auth/me  { displayName } → { user } */
export const updateMe = userRoute(async (req, res, user) => {
  const displayName = displayNameOf(req.body?.displayName)
  const row = await one('update users set display_name = $2 where id = $1 returning *', [user.id, displayName])
  noStore(res)
  res.json({ user: publicUser(row) })
}, { audience: 'shared' })


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
}, { audience: 'shared' })

/**
 * POST /api/auth/forgot-password  { email } → { sent: true }
 * → 404 ACCOUNT_NOT_FOUND when no account has this address
 *
 * The owner asked for this to say so (26 October 2026). It used to answer "sent" either way, so a
 * person who mistyped their address was told a link was on its way and waited for one that would never
 * come. Sign-up already says when an address is taken, so the fact is no secret; what keeps this from
 * being a cheap way to list registered addresses is the two limits below, which count before the
 * lookup — 30 an hour per caller, and one a minute (five an hour) per address.
 */
export const forgotPassword = publicRoute(async (req, res) => {
  const email = readEmail(req.body)
  enforceLimit(emailsByIp, `ip:${clientIp(req)}`)
  enforceLimit(emailsByAddress, `email:${email}`)

  const user = await findUserByEmail(email)
  if (!user) throw new HttpError(404, NO_ACCOUNT, 'ACCOUNT_NOT_FOUND')
  sendPasswordReset(user)
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
