/**
 * ─────────────────────────────────────────────────────────────────────────────
 * KIE transport — REACT NATIVE implementation (see kieTransport.js for web).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Calls api.kie.ai DIRECTLY, with no backend of our own in between. There is no
 * CORS in React Native, so a cross-origin call needs no proxy.
 *
 * SECURITY NOTE — read before changing this.
 * The key comes from EXPO_PUBLIC_KIE_API_KEY, and Expo inlines EXPO_PUBLIC_*
 * variables into the JS bundle at build time. That means the key SHIPS INSIDE
 * THE APP: anyone who unpacks the .apk/.ipa can read it and spend the account's
 * credits, and revoking it requires releasing a new build. This is a deliberate
 * trade for not running a backend. If the app is ever distributed publicly,
 * move back to a server-side proxy (see kieTransport.js) or have each user
 * supply their own key.
 */

const KIE_BASE = 'https://api.kie.ai'
// File uploads live on a different host to the rest of the API.
const UPLOAD_BASE = 'https://kieai.redpandaai.co'

const API_KEY = process.env.EXPO_PUBLIC_KIE_API_KEY || ''

/** True when a key is configured — the Settings screen surfaces this. */
export function hasKieKey() {
  return API_KEY.length > 0
}

/**
 * @param {string} path    upstream path, e.g. '/api/v1/jobs/createTask'
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {any}    [opts.body]            already-stringified JSON
 * @param {Record<string,string>} [opts.query]
 * @returns {Promise<Response>}
 */
export function kieFetch(path, { method = 'GET', body, query } = {}) {
  if (!API_KEY) {
    // Fail with something a human can act on, rather than a 401 from upstream.
    return Promise.reject(new Error(
      'No KIE API key configured. Add EXPO_PUBLIC_KIE_API_KEY to mobile/.env and restart the dev server.'
    ))
  }

  const base = path.startsWith('/api/file-') ? UPLOAD_BASE : KIE_BASE
  const qs = query ? `?${new URLSearchParams(query).toString()}` : ''

  return fetch(`${base}${path}${qs}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body } : {}),
  })
}
