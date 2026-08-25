/**
 * ─────────────────────────────────────────────────────────────────────────────
 * API URL resolution — REACT NATIVE implementation (see apiUrl.js for web).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * On the web a relative path like `/api/kie/...` resolves against the page
 * origin, so `getApiUrl` can return it untouched. React Native has no origin
 * and no dev proxy, so EVERY path must be made absolute against the deployed
 * backend — the same backend that holds the server-side KIE key.
 *
 * The base comes from EXPO_PUBLIC_API_BASE (app.json `extra` is the fallback).
 * `EXPO_PUBLIC_`-prefixed vars are inlined into the bundle at build time.
 *
 * This is a PUBLIC base URL only — never put the KIE key here. The key stays
 * server-side; the app calls our own /api proxy, which attaches it.
 */

import Constants from 'expo-constants'

const RAW_BASE =
  process.env.EXPO_PUBLIC_API_BASE ||
  Constants?.expoConfig?.extra?.apiBase ||
  ''

const BASE = RAW_BASE.replace(/\/+$/, '')

export function getApiUrl(path) {
  const rel = String(path).replace(/^\/+/, '')

  if (!BASE) {
    // Fail loudly: with no base every request would hit an unresolvable
    // relative path and surface as a confusing generic network error.
    throw new Error(
      'EXPO_PUBLIC_API_BASE is not set — the mobile app has no backend to call. ' +
      'Set it in mobile/.env (e.g. https://your-app.vercel.app).'
    )
  }

  return `${BASE}/${rel}`
}
