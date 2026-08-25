/**
 * ─────────────────────────────────────────────────────────────────────────────
 * App lifecycle — REACT NATIVE implementation (see app.js for the web one).
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Restart the app so freshly-written store data is re-read from scratch.
 *
 * expo-updates is an optional dependency here: it is only present in builds
 * configured for OTA updates, and calling `reloadAsync` in Expo Go or a plain
 * dev build throws. So we resolve it lazily and degrade to a no-op rather than
 * crashing — a missed reload just means the seeded data appears on next launch,
 * which is far better than taking the app down at startup.
 */
export function reloadApp() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Updates = require('expo-updates')
    if (typeof Updates?.reloadAsync === 'function') {
      Updates.reloadAsync().catch(e =>
        console.warn('[app] reloadAsync failed — data will apply next launch:', e?.message)
      )
      return
    }
  } catch {
    // expo-updates not installed in this build
  }
  console.warn('[app] reload unavailable — seeded data will apply on next launch')
}
