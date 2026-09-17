/**
 * ─────────────────────────────────────────────────────────────────────────────
 * KIE transport — one implementation for both platforms.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * There used to be two of these. The web build went through our /api/kie proxy
 * so the key stayed server-side; the native build called api.kie.ai directly
 * with EXPO_PUBLIC_KIE_API_KEY compiled into the bundle, on the reasoning that
 * a phone app has no devtools to open.
 *
 * That reasoning does not hold. An .apk is a zip file — anyone who installs the
 * app can extract the key in about a minute and spend the account's credits,
 * and revoking it means rotating the key and shipping a new build to everyone.
 *
 * So both platforms now go through the proxy, which holds the only copy of the
 * key and requires a valid session. There is nothing platform-specific
 * left, which is why the `.native.js` variant is gone: the only difference was
 * the base URL, and getApiUrl already handles that.
 *
 * Callers pass the UPSTREAM path (e.g. '/api/v1/jobs/createTask'); the proxy
 * reads it from `__kiepath` and forwards it.
 */

import { apiFetch } from '../api/client'

/**
 * A fetch-shaped wrapper, because the generation provider was written against
 * `Response` — it checks `res.ok`, reads `res.status`, and calls `res.json()`.
 * Returning a real-enough Response keeps that code unchanged while the
 * authentication and error handling live in apiFetch.
 *
 * @param {string} path    upstream path, e.g. '/api/v1/jobs/createTask'
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {string} [opts.body]   already-stringified JSON
 * @param {Record<string,string>} [opts.query]
 * @returns {Promise<{ok: boolean, status: number, json: () => Promise<any>, text: () => Promise<string>}>}
 */
export async function kieFetch(path, { method = 'GET', body, query } = {}) {
  const params = new URLSearchParams({ __kiepath: path, ...(query || {}) })

  try {
    const json = await apiFetch(`/api/kie${path}?${params.toString()}`, {
      method,
      // The provider hands us a JSON string; apiFetch serialises objects, so it
      // is parsed back rather than double-encoded.
      body: body !== undefined ? JSON.parse(body) : undefined,
    })

    return {
      ok: true,
      status: 200,
      json: async () => json,
      text: async () => JSON.stringify(json),
    }
  } catch (e) {
    // The provider inspects status and body codes (429 to back off), so a
    // failure comes back as a non-ok response rather than thrown — that is the
    // contract it was written against. `error` carries the original, whose
    // message our API wrote for people, so the provider can show it as it is.
    const status = e?.status ?? 0
    const payload = e?.body && typeof e.body === 'object'
      ? e.body
      : { code: status, msg: e?.message || 'Request failed' }
    return {
      ok: false,
      status,
      error: e,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }
  }
}

/**
 * Whether generation is available.
 *
 * The client no longer holds a key, so this is no longer a question it can
 * answer locally — the engine is reachable if the user is signed in and the
 * server is configured. The real check is the diagnostics run in Settings.
 */
export function hasKieKey() {
  return true
}
