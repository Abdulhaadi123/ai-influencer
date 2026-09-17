/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The session on this device.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Signing in gives two tokens (backend/api/_lib/sessions.js): an access token
 * sent with every call, valid for an hour, and a refresh token that trades for
 * a fresh pair. They are bearer credentials, so they live in the Keychain /
 * Keystore through platform/authStorage — never in ordinary device storage.
 *
 * ── Refreshing ───────────────────────────────────────────────────────────────
 *
 * The access token is refreshed shortly before it expires, ONE refresh at a
 * time. The server replaces the refresh token on every use and treats an old
 * one coming back as a stolen copy; two refreshes racing each other would look
 * exactly like that and end the session.
 *
 * ── Offline is not signed out ────────────────────────────────────────────────
 *
 * A refresh that cannot reach the server keeps the session and reports a
 * network problem. Only the server rejecting the refresh token ends it.
 */

import * as authStorage from '../platform/authStorage'
import { getApiUrl } from '../platform/apiUrl'
import { AppError, ERROR_CODES, NETWORK_MESSAGE } from '../errors'

const STORAGE_KEY = 'ai_influencer.session'

/** Refresh this long before the access token actually expires. */
const REFRESH_MARGIN_MS = 60_000

const REFRESH_TIMEOUT_MS = 30_000

/** @type {{accessToken: string, refreshToken: string, expiresAt: number, user: object} | null} */
let current = null
let loaded = null
let refreshing = null
const listeners = new Set()

/**
 * Events: SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED, SIGNED_OUT (asked for),
 * SESSION_EXPIRED (the server ended it — revoked, password reset elsewhere…).
 * @param {(event: string, session: object|null) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onSessionChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(event) {
  for (const listener of [...listeners]) {
    try { listener(event, current) } catch (e) { console.warn('[session] listener failed:', e?.message ?? e) }
  }
}

/** Read the stored session once. A device that refuses the Keychain reads as signed out. */
export function loadSession() {
  loaded ??= (async () => {
    try {
      const raw = await authStorage.getItem(STORAGE_KEY)
      const parsed = raw ? JSON.parse(raw) : null
      current = parsed?.refreshToken ? parsed : null
    } catch (e) {
      console.warn('[session] could not read the stored session:', e?.message ?? e)
      current = null
    }
    return current
  })()
  return loaded
}

export function getCurrentSession() {
  return current
}

async function persist() {
  if (current) await authStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  else await authStorage.removeItem(STORAGE_KEY)
}

/** Store what the server issued at sign-in or refresh. */
export async function setSession(issued, event = 'SIGNED_IN') {
  await loadSession()
  current = {
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    expiresAt: Date.now() + Number(issued.expiresIn || 0) * 1000,
    user: issued.user,
  }
  await persist()
  emit(event)
}

export async function updateStoredUser(user) {
  if (!current || !user) return
  current = { ...current, user }
  await persist()
  emit('USER_UPDATED')
}

export async function clearSession(event = 'SIGNED_OUT') {
  await loadSession()
  const hadSession = !!current
  current = null
  refreshing = null
  await persist()
  if (hadSession) emit(event)
}

/**
 * An access token that is good to use, refreshing it first when needed.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh]  refresh even if it looks valid — used
 *        when the server has just refused the current one
 * @returns {Promise<string|null>} null when there is no session
 * @throws {AppError} NETWORK or SERVER_UNAVAILABLE when a needed refresh could
 *         not happen; the session is kept
 */
export async function getAccessToken({ forceRefresh = false } = {}) {
  await loadSession()
  if (!current) return null
  if (!forceRefresh && current.expiresAt - REFRESH_MARGIN_MS > Date.now()) return current.accessToken
  return refreshNow()
}

function refreshNow() {
  refreshing ??= doRefresh().finally(() => { refreshing = null })
  return refreshing
}

async function doRefresh() {
  const presented = current?.refreshToken
  if (!presented) return null

  let url
  try {
    url = getApiUrl('/api/auth/refresh')
  } catch {
    throw new AppError('This app is not configured correctly. Please contact support.', { code: ERROR_CODES.APP_NOT_CONFIGURED })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
  let res
  let json = null
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: presented }),
      signal: controller.signal,
    })
    json = await res.json().catch(() => null)
  } catch {
    throw new AppError(NETWORK_MESSAGE, { code: ERROR_CODES.NETWORK })
  } finally {
    clearTimeout(timer)
  }

  // Signed out (or signed in as someone else) while this was in flight: the
  // answer belongs to a session that no longer exists here.
  if (current?.refreshToken !== presented) return current?.accessToken ?? null

  if (res.status === 401) {
    await clearSession('SESSION_EXPIRED')
    return null
  }
  if (!res.ok || !json?.session) {
    throw new AppError('The service is temporarily unavailable. Please try again shortly.', { code: 'SERVER_UNAVAILABLE' })
  }

  await setSession(json.session, 'TOKEN_REFRESHED')
  return current.accessToken
}
