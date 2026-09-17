/**
 * ─────────────────────────────────────────────────────────────────────────────
 * API URL resolution — WEB implementation (see apiUrl.native.js for mobile).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * In the browser the app is served from the same origin as its `/api` routes —
 * Vite proxies them in development, the backend serves them in production — so a
 * relative path is already correct and needs no rewriting.
 *
 * React Native has no origin to resolve against, which is why the native
 * variant builds absolute URLs instead.
 */

export function getApiUrl(path) {
  return path
}
