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

/**
 * RevenueCat's public SDK keys. Public by design — they identify the app to
 * RevenueCat and can do nothing a signed-in user could not; the secret API key
 * lives on the server only.
 *
 *   EXPO_PUBLIC_REVENUECAT_ANDROID_KEY   the Google Play key (`goog_…`), for real builds
 *   EXPO_PUBLIC_REVENUECAT_TEST_KEY      the Test Store key (`test_…`), for DEVELOPMENT
 *                                        builds only: the SDK refuses to run with it in
 *                                        a release build, by design (core/platform/purchases.native.js
 *                                        never uses it outside __DEV__).
 */
export const REVENUECAT_ANDROID_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY || ''
export const REVENUECAT_TEST_KEY = process.env.EXPO_PUBLIC_REVENUECAT_TEST_KEY || ''

/**
 * Sign in with Google. The Web application client ID from Google Cloud Console (ending in
 * `.apps.googleusercontent.com`): public, like the keys above — it names this app to Google, and the
 * server accepts a sign-in only if it was made for this same ID (backend GOOGLE_CLIENT_IDS). Empty: the
 * "Continue with Google" buttons are not drawn and email sign-in is all there is.
 */
export const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || ''

/**
 * DEVELOPMENT ONLY: an address that hands out a Google ID token, in place of Google's account picker,
 * so the whole sign-in can be run against a local test server on an emulator with no Google account.
 * Like the RevenueCat test key above it is dead in a release build: `__DEV__` is false there, so this is
 * '' and Metro drops the branch that reads it (core/platform/googleSignIn.native.js).
 */
export const GOOGLE_DEV_TOKEN_URL =
  typeof __DEV__ !== 'undefined' && __DEV__ ? process.env.EXPO_PUBLIC_GOOGLE_DEV_TOKEN_URL || '' : ''
