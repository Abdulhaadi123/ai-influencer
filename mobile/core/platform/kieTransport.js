/**
 * ─────────────────────────────────────────────────────────────────────────────
 * KIE transport — WEB implementation (see kieTransport.native.js for mobile).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The browser must NOT hold the API key: anything shipped to a web page is
 * readable by anyone who opens devtools. So web traffic goes through our own
 * /api/kie proxy, which attaches the key server-side.
 *
 * React Native has no such exposure through the page, so the native variant
 * calls api.kie.ai directly and skips the proxy entirely.
 *
 * Callers pass the UPSTREAM path (e.g. '/api/v1/jobs/createTask'); each
 * implementation decides how to reach it.
 */

import { getApiUrl } from './apiUrl'

/**
 * @param {string} path    upstream path, e.g. '/api/v1/jobs/createTask'
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {any}    [opts.body]            already-stringified JSON
 * @param {Record<string,string>} [opts.query]
 * @returns {Promise<Response>}
 */
export function kieFetch(path, { method = 'GET', body, query } = {}) {
  const params = new URLSearchParams({ __kiepath: path, ...(query || {}) })
  const url = getApiUrl(`/api/kie${path}?${params.toString()}`)

  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body } : {}),
  })
}
