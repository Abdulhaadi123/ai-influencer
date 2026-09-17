/**
 * ─────────────────────────────────────────────────────────────────────────────
 * API URL resolution — REACT NATIVE (see apiUrl.js for web).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The browser is served from the same origin as its /api routes, so a relative
 * path already works there. React Native has no origin: `fetch('/api/x')` is
 * not a relative request, it is an invalid URL. Every call has to be absolute.
 *
 * The base comes from EXPO_PUBLIC_API_BASE. Without it the app cannot upload a
 * file, mint a download URL, or reach the generation proxy — so a missing value
 * fails loudly and by name here, rather than as a confusing fetch error at the
 * first upload.
 */

import { API_BASE } from '../config/env'

export function getApiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`

  if (!API_BASE) {
    throw new Error(
      'EXPO_PUBLIC_API_BASE is not set. The mobile app needs an absolute URL ' +
      'for the backend (e.g. https://your-app.vercel.app). Add it to ' +
      'mobile/.env and restart the dev server.',
    )
  }

  return `${API_BASE.replace(/\/+$/, '')}${p}`
}
