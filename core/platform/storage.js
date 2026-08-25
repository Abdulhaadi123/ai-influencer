/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Storage — a small synchronous key/value abstraction over persistent storage.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nothing in the app should touch `localStorage` directly — always go through
 * this module. That gives us ONE place to change when we port to React Native.
 *
 * Why synchronous?
 *   The whole app reads storage synchronously (e.g. inside `useState` initialisers
 *   and startup migrations). Keeping this interface synchronous means the call
 *   sites never change.
 *     • Web            → localStorage (synchronous).
 *     • React Native   → swap the primitives below for `react-native-mmkv`, which
 *                        is ALSO synchronous. (We deliberately avoid AsyncStorage,
 *                        whose async API would force every read to be rewritten.)
 *
 * Behaviour: on the web this is a thin passthrough to localStorage and preserves
 * its exact semantics — notably, `setItem` still throws on quota, so existing
 * `try/catch` quota handling keeps working. The in-memory Map is used ONLY when
 * real storage is entirely unavailable (private mode / SSR / disabled), so the
 * app degrades gracefully instead of crashing.
 */

const hasLocalStorage = (() => {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return false
    const probe = '__storage_probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
})()

// Complete in-memory fallback, used only when localStorage is unavailable.
const mem = new Map()

export function getItem(key) {
  if (!hasLocalStorage) return mem.has(key) ? mem.get(key) : null
  return localStorage.getItem(key)
}

// Preserves localStorage semantics: may throw (e.g. QuotaExceededError) so that
// callers' existing try/catch quota handling behaves exactly as before.
export function setItem(key, value) {
  if (!hasLocalStorage) { mem.set(key, value); return }
  localStorage.setItem(key, value)
}

export function removeItem(key) {
  if (!hasLocalStorage) { mem.delete(key); return }
  localStorage.removeItem(key)
}

// Enumerate all keys. In React Native (MMKV) this maps to `storage.getAllKeys()`.
export function getAllKeys() {
  if (!hasLocalStorage) return [...mem.keys()]
  return Object.keys(localStorage)
}

// ── JSON convenience helpers (optional; adopt where it reads cleaner) ─────────
export function getJSON(key, fallback = null) {
  const raw = getItem(key)
  if (raw == null) return fallback
  try { return JSON.parse(raw) } catch { return fallback }
}

export function setJSON(key, value) {
  setItem(key, JSON.stringify(value))
}
