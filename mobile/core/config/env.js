/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Client configuration.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything the app is allowed to know, read through `process.env`. Expo
 * inlines EXPO_PUBLIC_* at build time, so every value here ends up inside the
 * .apk — nothing secret may ever be added.
 *
 * There is exactly one value: where our backend is. The app has no database
 * address, no storage credentials and no API keys; it reaches all of those
 * through the backend, which checks who is asking.
 */

/**
 * Absolute base URL of our API, e.g. https://api.your-domain.com
 *
 * React Native has no origin to resolve a relative path against, so a native
 * build must have this set or every call fails.
 */
export const API_BASE = process.env.EXPO_PUBLIC_API_BASE || ''

export function isApiConfigured() {
  return API_BASE.length > 0
}
