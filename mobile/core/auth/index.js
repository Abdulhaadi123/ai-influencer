/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Authentication — the only module that talks to the accounts API.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── How passwords are handled ────────────────────────────────────────────────
 *
 * The app never keeps a password. It goes from the input field to our server
 * over TLS, where it is hashed with Argon2id (backend/api/_lib/passwords.js),
 * and is then dropped. It is never stored on the device, logged, or put in an
 * error message. Anyone editing this module: a password may be sent to the
 * server and then forgotten — nothing else.
 *
 * ── Email links ──────────────────────────────────────────────────────────────
 *
 * Confirming an email and resetting a password both happen on web pages the
 * email links open (backend/api/auth/pages.js). The app only asks for the email
 * to be sent; the person then signs in here.
 *
 * ── Account enumeration ──────────────────────────────────────────────────────
 *
 * The server's answers never reveal whether an email is registered, and the
 * messages here do not add that information back. Do not "improve" them.
 */

import { apiFetch } from '../api/client'
import {
  setSession, clearSession, loadSession, getCurrentSession, onSessionChange, updateStoredUser,
} from './session'

// ── Password policy ──────────────────────────────────────────────────────────
//
// Mirrors the server (backend/api/_lib/passwords.js), so problems show while
// typing instead of after a round trip. The server enforces it regardless.

export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 128

/** `code` on the error signIn throws for an account whose email is not confirmed yet. */
export const EMAIL_NOT_CONFIRMED = 'EMAIL_NOT_CONFIRMED'

/** @returns {string|null} a problem to show the user, or null when acceptable */
export function validatePassword(password) {
  const p = password ?? ''
  if (p.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  if (p.length > MAX_PASSWORD_LENGTH) return `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return 'Password must include at least one letter and one number.'
  if (/^(password|12345678|qwerty|letmein|welcome)/i.test(p)) return 'This password is too common. Please choose a stronger one.'
  return null
}

export function validateEmail(email) {
  const e = (email ?? '').trim()
  if (!e) return 'Enter your email address.'
  // Deliberately loose: the confirmation email is the real check.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'Enter a valid email address.'
  return null
}

const normalise = email => (email || '').trim().toLowerCase()

function check(problem) {
  if (problem) throw new Error(problem)
}


// ── Sign up / in / out ───────────────────────────────────────────────────────

/**
 * Create an account.
 * @returns {Promise<{needsEmailConfirmation: boolean}>} false means signed in already
 */
export async function signUp({ email, password, displayName }) {
  check(validateEmail(email))
  check(validatePassword(password))

  const json = await apiFetch('/api/auth/signup', {
    method: 'POST',
    auth: false,
    body: { email: normalise(email), password, displayName: (displayName || '').trim() || null },
  })

  if (json?.session) await setSession(json.session, 'SIGNED_IN')
  return { needsEmailConfirmation: !!json?.needsEmailConfirmation }
}

/**
 * Sign in. A failure carries the server's message, and `code` —
 * EMAIL_NOT_CONFIRMED lets the sign-in screen offer to resend the email.
 */
export async function signIn({ email, password }) {
  check(validateEmail(email))
  if (!password) throw new Error('Enter your password.')

  const json = await apiFetch('/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { email: normalise(email), password },
  })
  await setSession(json.session, 'SIGNED_IN')
  return json.session.user
}

/**
 * Sign out this device.
 *
 * The local session goes first, so signing out holds even with no connection —
 * someone handing over a phone must not stay signed in because the network was
 * down. The server is then told, to end the session there too.
 */
export async function signOut() {
  const session = getCurrentSession()
  await clearSession('SIGNED_OUT')
  if (session?.refreshToken) {
    apiFetch('/api/auth/logout', { method: 'POST', auth: false, body: { refreshToken: session.refreshToken } })
      .catch(e => console.warn('[auth] server sign-out did not complete:', e?.message ?? e))
  }
}


// ── Emails ───────────────────────────────────────────────────────────────────

/** Send a password-reset link. Answers the same whether or not the account exists. */
export async function requestPasswordReset(email) {
  check(validateEmail(email))
  await apiFetch('/api/auth/forgot-password', { method: 'POST', auth: false, body: { email: normalise(email) } })
  return { sent: true }
}

/** Send the confirmation email again. Answers the same whether or not it applies. */
export async function resendConfirmation(email) {
  check(validateEmail(email))
  await apiFetch('/api/auth/resend-confirmation', { method: 'POST', auth: false, body: { email: normalise(email) } })
  return { sent: true }
}


// ── Password and account ─────────────────────────────────────────────────────

/**
 * Change the password of the signed-in account. The server checks the current
 * one first and signs out every other device.
 */
export async function changePassword({ currentPassword, newPassword }) {
  if (!currentPassword) throw new Error('Enter your current password.')
  check(validatePassword(newPassword))
  if (newPassword === currentPassword) throw new Error('New password must be different from your current password.')

  await apiFetch('/api/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } })
}

/**
 * Permanently delete the signed-in account and everything in it. The server
 * checks the password before deleting anything.
 */
export async function deleteAccount({ password }) {
  if (!password) throw new Error('Enter your password to continue.')
  await apiFetch('/api/account/delete', { method: 'POST', body: { password }, timeoutMs: 120_000 })
  await clearSession('SIGNED_OUT')
}

/** Re-read the user from the server — also how a stored session is checked at launch. */
export async function refreshUser() {
  const json = await apiFetch('/api/auth/me')
  if (json?.user) await updateStoredUser(json.user)
  return json?.user ?? null
}

export async function updateDisplayName(displayName) {
  const json = await apiFetch('/api/auth/me', { method: 'POST', body: { displayName } })
  if (json?.user) await updateStoredUser(json.user)
  return json?.user ?? null
}


// ── Session ──────────────────────────────────────────────────────────────────

export function getSession() {
  return loadSession()
}

/**
 * @param {(event: string, session: object|null) => void} handler
 * @returns {() => void} unsubscribe
 */
export function onAuthStateChange(handler) {
  return onSessionChange(handler)
}
