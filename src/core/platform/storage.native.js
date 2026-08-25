/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Storage — REACT NATIVE implementation (see storage.js for the web one).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Metro resolves this file ahead of `storage.js` on native platforms, so the
 * web build is untouched. The exported interface must stay identical to the
 * web module's — every call site in core depends on it.
 *
 * Backed by react-native-mmkv, which is SYNCHRONOUS, matching the web's
 * localStorage semantics. This is the whole reason the abstraction is sync:
 * the app reads storage inside `useState` initialisers, and AsyncStorage would
 * force every one of those call sites to be rewritten as async.
 *
 * NOTE: react-native-mmkv is a native module, so it needs a development build
 * (`npx expo run:android`) — it does not run in Expo Go.
 */

import { MMKV } from 'react-native-mmkv'

const mmkv = new MMKV()

/**
 * MMKV returns `undefined` for a missing key; the web contract is `null`.
 * Normalise here so callers behave identically on both platforms.
 */
export function getItem(key) {
  const v = mmkv.getString(key)
  return v === undefined ? null : v
}

/**
 * Mirrors the web module, which lets localStorage's quota error propagate so
 * callers' existing try/catch quota handling still runs. MMKV has no quota,
 * but any underlying failure is likewise left to propagate rather than
 * silently swallowed.
 */
export function setItem(key, value) {
  mmkv.set(key, value)
}

export function removeItem(key) {
  mmkv.delete(key)
}

export function getAllKeys() {
  return mmkv.getAllKeys()
}

// ── JSON convenience helpers — identical semantics to the web module ─────────
export function getJSON(key, fallback = null) {
  const raw = getItem(key)
  if (raw == null) return fallback
  try { return JSON.parse(raw) } catch { return fallback }
}

export function setJSON(key, value) {
  setItem(key, JSON.stringify(value))
}
