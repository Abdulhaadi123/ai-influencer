/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Storage — REACT NATIVE implementation (see storage.js for the web one).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Metro resolves this file ahead of `storage.js` on native platforms, so the
 * web build is untouched. The exported interface must stay identical to the
 * web module's — every call site in core depends on it.
 *
 * Backed by expo-sqlite's key/value store, used through its SYNCHRONOUS API.
 * Sync is the whole reason this abstraction exists: the app reads storage
 * inside `useState` initialisers, and an async store would force every one of
 * those call sites to be rewritten.
 *
 * Why not react-native-mmkv: MMKV is faster, but it is a third-party native
 * module, so it cannot run in Expo Go — the app would need a development build
 * before anyone could try it on a phone. expo-sqlite ships with Expo Go and is
 * far quicker than this app's data volume needs (a handful of influencer
 * records and some form settings). If the app later moves to a custom dev
 * build and storage ever becomes a bottleneck, swapping back is this one file.
 */

import Storage from 'expo-sqlite/kv-store'

/** expo-sqlite returns null for a missing key, matching the web contract. */
export function getItem(key) {
  return Storage.getItemSync(key)
}

/**
 * Mirrors the web module, which lets localStorage's quota error propagate so
 * callers' existing try/catch quota handling still runs. Any underlying failure
 * here is likewise left to propagate rather than silently swallowed.
 */
export function setItem(key, value) {
  Storage.setItemSync(key, value)
}

export function removeItem(key) {
  Storage.removeItemSync(key)
}

export function getAllKeys() {
  return Storage.getAllKeysSync()
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
