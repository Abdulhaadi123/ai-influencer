/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Session storage — WEB (see authStorage.native.js for the app).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The web build is kept only as a reference, and a browser has nowhere as safe
 * as the Keychain to put a bearer token: anything in localStorage is readable by
 * any script on the page. So on web the session lives in memory and ends when
 * the tab closes. That is deliberate — it keeps the tokens out of browser
 * storage entirely.
 */

const memory = new Map()

export async function getItem(key) {
  return memory.has(key) ? memory.get(key) : null
}

export async function setItem(key, value) {
  memory.set(key, value)
}

export async function removeItem(key) {
  memory.delete(key)
}
