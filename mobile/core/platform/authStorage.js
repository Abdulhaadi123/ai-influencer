/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Session storage — WEB (see authStorage.native.js for mobile).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Supabase's browser default is localStorage. That is convenient and it is also
 * the reason a single XSS bug becomes a full account takeover: injected script
 * can read localStorage, lift the refresh token, and mint access tokens long
 * after the tab is closed. Nothing about the token being "in the browser
 * anyway" makes that equivalent — a refresh token is a durable credential.
 *
 * So the session never touches web storage here:
 *
 *   • The session lives in a module-scoped variable — memory only, gone on
 *     reload, unreadable from another tab or origin.
 *   • The durable copy is held by our own API in an httpOnly, Secure,
 *     SameSite=Lax cookie. Script cannot read an httpOnly cookie; only the
 *     server can. A reload asks the server for the session back.
 *
 * The cost is one network round trip on cold load, which is why `prime()`
 * exists: the auth provider calls it once at boot so the very first getItem
 * Supabase makes is already warm.
 *
 * The cost of getting this wrong is a logged-out user, never a leaked token —
 * every failure path below resolves to "no session".
 */

import { getApiUrl } from './apiUrl'

const ENDPOINT = () => getApiUrl('/api/auth/session')

/**
 * The live session, keyed the way Supabase keys it. Memory only.
 * @type {Map<string, string>}
 */
const mem = new Map()

/** Set once the server has been asked, so a signed-out user pays the trip once. */
let primed = false
let priming = null

/**
 * Ask the API for the session behind the httpOnly cookie.
 *
 * Resolves to null for a signed-out visitor, an expired cookie, or an API that
 * cannot be reached — all of which mean the same thing to the caller.
 */
async function fetchStoredSession() {
  try {
    const res = await fetch(ENDPOINT(), {
      method: 'GET',
      // Without this the browser will not attach the httpOnly cookie.
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    const json = await res.json().catch(() => null)
    return json?.session ?? null
  } catch {
    return null
  }
}

/**
 * Warm the in-memory copy from the cookie. Safe to call repeatedly and
 * concurrently — the in-flight promise is shared so a burst of callers makes
 * one request.
 */
export async function prime(key) {
  if (primed) return
  if (priming) return priming

  priming = (async () => {
    const stored = await fetchStoredSession()
    if (stored && key) mem.set(key, stored)
    primed = true
    priming = null
  })()

  return priming
}

export async function getItem(key) {
  if (mem.has(key)) return mem.get(key)

  if (!primed) {
    await prime(key)
    if (mem.has(key)) return mem.get(key)
  }

  return null
}

export async function setItem(key, value) {
  mem.set(key, value)
  primed = true

  try {
    await fetch(ENDPOINT(), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: value }),
    })
  } catch (e) {
    // The user stays signed in for this tab; they will simply have to sign in
    // again after a reload. Better than tearing down a working session.
    console.warn('[authStorage] could not persist session cookie:', e?.message ?? e)
  }
}

export async function removeItem(key) {
  mem.delete(key)
  primed = true

  try {
    await fetch(ENDPOINT(), { method: 'DELETE', credentials: 'include' })
  } catch (e) {
    console.warn('[authStorage] could not clear session cookie:', e?.message ?? e)
  }
}
