/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Calling our own API, as the signed-in user.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every call carries the session's access token; the server looks it up and
 * decides who is asking. The client never says "I am user X" — a client
 * claiming an id in a request body is not authentication, and nothing here does
 * it.
 *
 * The token comes from auth/session.js on every call, which refreshes it when
 * it is about to expire. If the server still refuses it (revoked, or the phone's
 * clock is off), one refresh-and-retry happens before the app treats the session
 * as over.
 */

import { getAccessToken } from '../auth/session'
import { getApiUrl } from '../platform/apiUrl'
import {
  ApiError, ERROR_CODES, NETWORK_MESSAGE, SESSION_ENDED_MESSAGE,
  messageForStatus, codeForStatus, notifySessionEnded,
} from '../errors'

// Re-exported: callers have always imported these from here.
export { ApiError }

/** The code our API sends when the token is not a session. The app signs out on it. */
export const NOT_AUTHENTICATED = ERROR_CODES.NOT_AUTHENTICATED

/**
 * How long a call may take before it is abandoned. Without a limit a server
 * that accepted the connection and never answered left a spinner running
 * forever. Calls that legitimately take longer pass their own.
 */
export const DEFAULT_TIMEOUT_MS = 30_000

function sessionEnded() {
  notifySessionEnded()
  return new ApiError(SESSION_ENDED_MESSAGE, 401, NOT_AUTHENTICATED)
}

async function tokenOrThrow(options) {
  try {
    return await getAccessToken(options)
  } catch (e) {
    // No connection for a needed refresh: not a sign-out, and the call cannot go ahead.
    throw new ApiError(e?.message || NETWORK_MESSAGE, 0, e?.code || ERROR_CODES.NETWORK)
  }
}

/**
 * @param {string} path            e.g. '/api/storage/upload-url'
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {object} [opts.body]     serialised as JSON
 * @param {boolean} [opts.auth]    default true; false for sign-in and the like
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<any>} the parsed JSON body (null for 204)
 * @throws {ApiError} with a message written for the person using the app
 */
export async function apiFetch(path, { method = 'GET', body, auth = true, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // Resolved before anything else, so a build without EXPO_PUBLIC_API_BASE says
  // that — rather than "check your connection", which sends people to fix wifi.
  let url
  try {
    url = getApiUrl(path)
  } catch (e) {
    console.warn('[api]', e?.message ?? e)
    throw new ApiError(
      'This version of the app is not connected to a server yet, so it cannot do this.',
      0, ERROR_CODES.APP_NOT_CONFIGURED,
    )
  }

  let token = null
  if (auth) {
    token = await tokenOrThrow()
    if (!token) throw sessionEnded()
  }

  let result = await send(url, { method, body, token, signal, timeoutMs })

  // The token looked valid here but the server refused it. One forced refresh
  // settles whether the session is really over.
  if (auth && result.status === 401 && result.json?.code === NOT_AUTHENTICATED) {
    token = await tokenOrThrow({ forceRefresh: true })
    if (!token) throw sessionEnded()
    result = await send(url, { method, body, token, signal, timeoutMs })
    if (result.status === 401 && result.json?.code === NOT_AUTHENTICATED) throw sessionEnded()
  }

  const { status, json } = result
  if (status === 204) return null

  if (status < 200 || status >= 300) {
    // Our endpoints send { error, code } with a sentence written for people.
    // Anything else (a proxy's HTML page, the generator's own { code, msg })
    // gets a message chosen by status; the provider re-words generator codes.
    const ours = typeof json?.error === 'string' && json.error
    throw new ApiError(ours || messageForStatus(status), status, json?.code ?? codeForStatus(status), json)
  }

  return json
}

async function send(url, { method, body, token, signal, timeoutMs }) {
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  // Cancelled before it started: do not start a request at all.
  if (signal?.aborted) throw Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' })

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const forwardAbort = () => controller.abort()
  signal?.addEventListener?.('abort', forwardAbort)

  try {
    const res = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    // Read inside the timeout too: a body that never finishes is the same hang.
    const text = res.status === 204 ? '' : await res.text()
    let json = null
    if (text) { try { json = JSON.parse(text) } catch { /* an HTML error page from a proxy */ } }
    return { status: res.status, json }
  } catch (e) {
    if (timedOut) throw new ApiError('The server took too long to respond. Please try again.', 0, ERROR_CODES.TIMEOUT)
    if (signal?.aborted || e?.name === 'AbortError') throw e
    throw new ApiError(NETWORK_MESSAGE, 0, ERROR_CODES.NETWORK)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', forwardAbort)
  }
}
