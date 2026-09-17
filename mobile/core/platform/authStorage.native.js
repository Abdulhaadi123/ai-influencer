/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Session storage — REACT NATIVE (see authStorage.js for web).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The session — access token, refresh token, user — is a bearer
 * credential. Anything holding it can act as the user until it expires, so it
 * does NOT go in the same place as ordinary app data.
 *
 * expo-secure-store puts it in the iOS Keychain and the Android Keystore:
 * encrypted at rest, tied to this app's identity, and not readable by another
 * app or by anyone browsing the filesystem of a rooted device. That is the
 * whole reason this file exists rather than reusing platform/storage.native.js,
 * which is expo-sqlite and stores plaintext.
 *
 * ── The 2048-byte problem ────────────────────────────────────────────────────
 *
 * SecureStore warns above 2048 bytes and iOS can refuse outright. A session
 * holds two tokens and the user object, and must never be cut off by that
 * limit as it grows, so values are split across numbered chunks and
 * reassembled on read. The chunk count lives in its own key, and a
 * write always clears the previous chunks first: shrinking from five chunks to
 * three must not leave chunks four and five behind to be concatenated onto the
 * next read.
 *
 * Every operation is best-effort. A device that refuses the Keychain should
 * land the user on the sign-in screen, not crash the app on launch.
 */

import * as SecureStore from 'expo-secure-store'

/** Comfortably under the 2048-byte warning, leaving room for key overhead. */
const CHUNK_SIZE = 1600

/** Where the number of chunks for `key` is recorded. */
const countKey = key => `${key}__chunks`
const chunkKey = (key, i) => `${key}__${i}`

/**
 * SecureStore rejects keys outside [A-Za-z0-9._-]. The session key is fine as it
 * is, but a future key might not be; normalising here avoids a silent write failure.
 */
function safeKey(key) {
  return String(key).replace(/[^A-Za-z0-9._-]/g, '_')
}

async function readCount(key) {
  const raw = await SecureStore.getItemAsync(countKey(key))
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Remove every chunk of a previous value so stale tails cannot survive. */
async function clearChunks(key, count) {
  const deletions = []
  for (let i = 0; i < count; i++) deletions.push(SecureStore.deleteItemAsync(chunkKey(key, i)))
  deletions.push(SecureStore.deleteItemAsync(countKey(key)))
  await Promise.all(deletions.map(p => p.catch(() => {})))
}

export async function getItem(key) {
  const k = safeKey(key)
  try {
    const count = await readCount(k)
    if (count === 0) return null

    const parts = await Promise.all(
      Array.from({ length: count }, (_, i) => SecureStore.getItemAsync(chunkKey(k, i))),
    )

    // A missing chunk means the stored value is torn — treat it as absent
    // rather than returning a half-session that will fail to parse later.
    if (parts.some(p => p == null)) {
      await clearChunks(k, count)
      return null
    }

    return parts.join('')
  } catch (e) {
    console.warn('[authStorage] read failed:', e?.message ?? e)
    return null
  }
}

export async function setItem(key, value) {
  const k = safeKey(key)
  try {
    await clearChunks(k, await readCount(k))

    const str = String(value)
    const count = Math.max(1, Math.ceil(str.length / CHUNK_SIZE))

    for (let i = 0; i < count; i++) {
      await SecureStore.setItemAsync(chunkKey(k, i), str.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE))
    }
    // Written last: until the count exists, a partial write reads as absent
    // rather than as a corrupt session.
    await SecureStore.setItemAsync(countKey(k), String(count))
  } catch (e) {
    console.warn('[authStorage] write failed:', e?.message ?? e)
  }
}

export async function removeItem(key) {
  const k = safeKey(key)
  try {
    await clearChunks(k, await readCount(k))
  } catch (e) {
    console.warn('[authStorage] delete failed:', e?.message ?? e)
  }
}
