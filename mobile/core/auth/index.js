/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Authentication — the only module that talks to Supabase Auth.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── How passwords are handled ────────────────────────────────────────────────
 *
 * This application never sees a password beyond the moment it is typed. There
 * is no hashing here, no salting here, no password column anywhere in our
 * schema, and nothing about a password is ever written to disk or logged. The
 * plaintext goes straight from the input field into supabase.auth over TLS;
 * Supabase (GoTrue) hashes it with bcrypt and stores it in `auth.users`, a
 * schema our client cannot read.
 *
 * That is deliberate and it is the single most important property of this file.
 * Rolling our own hashing would be strictly worse. The rule for anyone editing
 * this module: a password may be passed to Supabase and then dropped. It may
 * not be stored in state longer than the form lives, put in a log line, sent to
 * our own API, or included in an error message.
 *
 * ── Why the errors are rewritten ─────────────────────────────────────────────
 *
 * Supabase's raw messages are aimed at developers ("Invalid login credentials",
 * "AuthApiError"). They are shown to end users here, so they are translated —
 * while carefully NOT revealing whether an email exists. "Invalid login
 * credentials" stays deliberately vague for exactly that reason, and
 * requestPasswordReset always reports success.
 */

import { isAuthRetryableFetchError } from '@supabase/supabase-js'

import { supabase } from '../supabase'
import { apiFetch } from '../api/client'
import { NETWORK_MESSAGE } from '../errors'
import { PASSWORD_RESET_REDIRECT, EMAIL_CONFIRM_REDIRECT } from '../config/env'

/** `code` on the error signIn throws for an account whose email is not confirmed yet. */
export const EMAIL_NOT_CONFIRMED = 'EMAIL_NOT_CONFIRMED'

/** A request that never reached Supabase — worth saying so, never worth hiding. */
function isNetworkError(error) {
  return isAuthRetryableFetchError(error) || /network request failed|failed to fetch|fetch failed/i.test(error?.message || '')
}

// ── Password policy ──────────────────────────────────────────────────────────
//
// Length is the requirement that actually matters, so it carries the weight
// here. Supabase enforces its own minimum server-side; this exists to tell the
// user before a round trip, and must stay at least as strict as the dashboard
// setting or the UI will promise something the server rejects.

export const MIN_PASSWORD_LENGTH = 10

/**
 * @returns {string|null} a problem to show the user, or null when acceptable.
 */
export function validatePassword(password) {
  const p = password ?? ''
  if (p.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  if (p.length > 72) {
    // bcrypt silently ignores everything past 72 bytes, so a longer password
    // is not the extra security it looks like. Say so rather than truncate.
    return 'Use 72 characters or fewer.'
  }
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) {
    return 'Include at least one letter and one number.'
  }
  // Catches the small set of passwords that dominate credential-stuffing lists
  // and cost nothing to reject.
  if (/^(password|12345678|qwerty|letmein|welcome)/i.test(p)) {
    return 'That password is too easy to guess.'
  }
  return null
}

export function validateEmail(email) {
  const e = (email ?? '').trim()
  if (!e) return 'Enter your email address.'
  // Deliberately loose: the confirmation email is the real check, and a strict
  // regex rejects valid addresses.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'That does not look like an email address.'
  return null
}

/** Turn a Supabase error into something worth showing a person. */
function humanError(error) {
  const msg = error?.message || ''

  if (/invalid login credentials/i.test(msg)) {
    // Intentionally ambiguous — saying "no such account" would let anyone
    // enumerate which addresses are registered.
    return 'That email and password combination is not right.'
  }
  if (/email not confirmed/i.test(msg)) {
    return 'Check your inbox and confirm your email address first.'
  }
  if (/user already registered|already been registered/i.test(msg)) {
    return 'There is already an account with that email. Try signing in.'
  }
  if (/rate limit|too many|security purposes|only request this after/i.test(msg) || error?.code === 'over_email_send_rate_limit') {
    return 'Too many attempts. Wait a minute and try again.'
  }
  if (/password should be at least/i.test(msg)) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  if (error?.code === 'weak_password' || /password should contain|password is too weak|weak password/i.test(msg)) {
    return 'That password is too easy to guess. Use a longer mix of letters, numbers and symbols.'
  }
  if (error?.code === 'same_password' || /should be different from the old/i.test(msg)) {
    return 'Choose a password you have not used on this account before.'
  }
  if (/signups? not allowed|signup is disabled/i.test(msg)) {
    return 'New accounts cannot be created right now.'
  }
  if (/unable to validate email|invalid format|email address .* is invalid/i.test(msg)) {
    return 'That does not look like an email address.'
  }
  if (/link is invalid|has expired|otp_expired|flow state/i.test(msg)) {
    return 'That link has expired or was already used. Request a new one.'
  }
  if (/network|fetch/i.test(msg) || error?.name === 'AuthRetryableFetchError') {
    return NETWORK_MESSAGE
  }
  // Supabase's remaining messages are written for developers ("AuthApiError",
  // status codes, internal field names). Logged for whoever debugs it; the
  // person gets a sentence.
  console.warn('[auth] unmapped auth error:', error?.name, error?.status, msg)
  return error?.status >= 500
    ? 'The sign-in service is having trouble. Please try again shortly.'
    : 'That did not work. Please check what you entered and try again.'
}


// ── Sign up ──────────────────────────────────────────────────────────────────

/**
 * Create an account.
 *
 * Whether the user is signed in immediately or has to confirm by email is a
 * project setting, not something the client decides — so the caller is told
 * which happened via `needsEmailConfirmation` rather than guessing.
 *
 * @returns {Promise<{user: object|null, session: object|null, needsEmailConfirmation: boolean}>}
 */
export async function signUp({ email, password, displayName }) {
  const emailProblem = validateEmail(email)
  if (emailProblem) throw new Error(emailProblem)

  const passwordProblem = validatePassword(password)
  if (passwordProblem) throw new Error(passwordProblem)

  const { data, error } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: {
      // Lands in raw_user_meta_data, which the handle_new_user trigger reads
      // when it creates the profile row.
      data: { display_name: (displayName || '').trim() || null },
      // Its own screen. It used to reuse the reset-password link, so confirming
      // an account opened "Choose a new password".
      emailRedirectTo: EMAIL_CONFIRM_REDIRECT,
    },
  })

  if (error) throw new Error(humanError(error))

  return {
    user: data.user ?? null,
    session: data.session ?? null,
    // No session but a user means confirmation is on and the email is in flight.
    needsEmailConfirmation: !data.session && !!data.user,
  }
}


// ── Sign in / out ────────────────────────────────────────────────────────────

export async function signIn({ email, password }) {
  const emailProblem = validateEmail(email)
  if (emailProblem) throw new Error(emailProblem)
  if (!password) throw new Error('Enter your password.')

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  })

  if (error) {
    const failure = new Error(humanError(error))
    // The message already said this; the code lets the screen offer to resend.
    if (error.code === 'email_not_confirmed' || /email not confirmed/i.test(error.message || '')) {
      failure.code = EMAIL_NOT_CONFIRMED
    }
    throw failure
  }
  return { user: data.user, session: data.session }
}

/**
 * Sign out.
 *
 * `scope: 'local'` clears this device only, which is what a sign-out button
 * should do — signing out every device from a shared laptop would be a nasty
 * surprise. Revoking everywhere is a separate, explicit action below.
 *
 * The local session is cleared even if the network call fails, so a user on a
 * dead connection is not stuck signed in on a device they are handing over.
 */
export async function signOut() {
  const { error } = await supabase.auth.signOut({ scope: 'local' })
  if (error) console.warn('[auth] sign out reported:', error.message)
}

/** Revoke every refresh token for this user, on every device. */
export async function signOutEverywhere() {
  const { error } = await supabase.auth.signOut({ scope: 'global' })
  if (error) throw new Error(humanError(error))
}


// ── Password reset ───────────────────────────────────────────────────────────

/**
 * Send a reset link.
 *
 * ALWAYS reports success, even for an address with no account. Reporting "no
 * such user" would turn this endpoint into an account-enumeration oracle, which
 * is the classic mistake in a forgot-password flow. Supabase behaves the same
 * way; this makes the intent explicit so nobody "helpfully" adds an error later.
 */
export async function requestPasswordReset(email) {
  const emailProblem = validateEmail(email)
  if (emailProblem) throw new Error(emailProblem)

  const { error } = await supabase.auth.resetPasswordForEmail(
    email.trim().toLowerCase(),
    PASSWORD_RESET_REDIRECT ? { redirectTo: PASSWORD_RESET_REDIRECT } : undefined,
  )

  // Rate limiting and a dropped connection are worth surfacing — they are about
  // this device, not about whether the account exists. Reporting "sent" with no
  // connection left people waiting for an email that was never requested.
  if (error && isNetworkError(error)) throw new Error(NETWORK_MESSAGE)
  if (error && /rate limit|too many|security purposes/i.test(error.message || '')) {
    throw new Error(humanError(error))
  }
  if (error) console.warn('[auth] reset request:', error.message)

  return { sent: true }
}


// ── Email confirmation ───────────────────────────────────────────────────────

/**
 * Send the sign-up confirmation email again.
 *
 * Reports success whether or not an unconfirmed account exists for the address,
 * for the same reason requestPasswordReset does: anything else would let anyone
 * test which addresses are registered. Only a dropped connection and rate
 * limiting are surfaced.
 */
export async function resendConfirmation(email) {
  const emailProblem = validateEmail(email)
  if (emailProblem) throw new Error(emailProblem)

  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: EMAIL_CONFIRM_REDIRECT },
  })

  if (error && isNetworkError(error)) throw new Error(NETWORK_MESSAGE)
  if (error && /rate limit|too many|security purposes|only request this after/i.test(error.message || '')) {
    throw new Error(humanError(error))
  }
  if (error) console.warn('[auth] resend confirmation:', error.message)

  return { sent: true }
}

/**
 * Finish a confirmation link: trade its code for a session, so the user lands
 * in the app without typing their password again.
 *
 * Supabase confirms the address BEFORE the link reaches the app — the code only
 * signs the user in. When it cannot be used here (the link was opened on a
 * different phone, or a newer email request on this one replaced the check the
 * code is matched against), the account is still confirmed, and the honest
 * answer is "sign in", not "that link failed".
 *
 * @returns {Promise<'signed-in' | 'confirmed'>}
 * @throws when there is no connection, so the screen can offer to try again
 */
export async function completeEmailConfirmation(code) {
  if (!code) throw new Error('That confirmation link is not valid.')

  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (!error) return 'signed-in'
  if (isNetworkError(error)) throw new Error(NETWORK_MESSAGE)

  console.warn('[auth] confirmation code not usable on this device:', error.code || error.message)
  return 'confirmed'
}

/**
 * Exchange the code from a reset link for a temporary session.
 *
 * With flowType 'pkce' the link carries a single-use code rather than tokens.
 * Trading it here gives a session with just enough authority to set a new
 * password, which updatePassword then does.
 */
export async function exchangeRecoveryCode(code) {
  if (!code) throw new Error('That reset link is not valid.')

  const { data, error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    throw new Error(
      /expired|invalid/i.test(error.message || '')
        ? 'That reset link has expired. Request a new one.'
        : humanError(error),
    )
  }
  return data.session
}

/**
 * Set a new password for the currently-authenticated user.
 *
 * Used by both the reset flow (session came from a recovery link) and by an
 * ordinary signed-in user changing their password in settings.
 *
 * Supabase revokes other sessions on a password change, so a stolen session
 * elsewhere dies here — which is exactly what someone resetting a password
 * after a scare expects to happen.
 */
export async function updatePassword(newPassword) {
  const problem = validatePassword(newPassword)
  if (problem) throw new Error(problem)

  const { data, error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw new Error(humanError(error))
  return data.user
}

/**
 * Change the password of a signed-in user, re-checking the current one first.
 *
 * updateUser alone does not ask for the existing password, which means an
 * unattended signed-in device could be used to lock the real owner out. Signing
 * in again with the old password is the check — it costs one request and closes
 * that hole.
 */
export async function changePassword({ email, currentPassword, newPassword }) {
  if (!currentPassword) throw new Error('Enter your current password.')
  // Checked before signing in again, so an unusable new password costs no request.
  const problem = validatePassword(newPassword)
  if (problem) throw new Error(problem)
  if (newPassword === currentPassword) throw new Error('Choose a password different from your current one.')

  const { error: reauthError } = await supabase.auth.signInWithPassword({
    email: (email || '').trim().toLowerCase(),
    password: currentPassword,
  })
  if (reauthError) throw new Error(reauthMessage(reauthError, 'Your current password is not right.'))

  return updatePassword(newPassword)
}

/**
 * The message for a failed password re-check. Only a genuine refusal means the
 * password was wrong — a dropped connection used to be reported as one.
 */
function reauthMessage(error, wrongPassword) {
  if (isNetworkError(error)) return NETWORK_MESSAGE
  if (/rate limit|too many/i.test(error?.message || '')) return humanError(error)
  return wrongPassword
}


// ── Account deletion ─────────────────────────────────────────────────────────

/**
 * Permanently delete the signed-in account and everything in it.
 *
 * Re-checks the password first, as changePassword does: an unattended phone
 * that happens to be signed in must not be enough to wipe someone's work. The
 * server removes every stored file and then the auth user, which cascades to
 * every row (backend/api/account/delete.js).
 *
 * The local session is cleared last. Its refresh token belongs to a user that
 * no longer exists, so clearing it cannot meaningfully fail.
 */
export async function deleteAccount({ email, password }) {
  if (!password) throw new Error('Enter your password to confirm.')

  const { error: reauthError } = await supabase.auth.signInWithPassword({
    email: (email || '').trim().toLowerCase(),
    password,
  })
  if (reauthError) throw new Error(reauthMessage(reauthError, 'That password is not right.'))

  await apiFetch('/api/account/delete', { method: 'POST' })

  const { error } = await supabase.auth.signOut({ scope: 'local' })
  if (error) console.warn('[auth] local sign-out after deletion:', error.message)
}


// ── Session ──────────────────────────────────────────────────────────────────

export async function getSession() {
  const { data, error } = await supabase.auth.getSession()
  if (error) return null
  return data?.session ?? null
}

/**
 * Subscribe to sign-in / sign-out / token-refresh.
 * @returns {() => void} unsubscribe
 */
export function onAuthStateChange(handler) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    handler(event, session)
  })
  return () => data?.subscription?.unsubscribe?.()
}
