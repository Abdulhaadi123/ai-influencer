/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Calling our own API, as the signed-in user.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every /api route that touches user data verifies a Supabase JWT and derives
 * the user id from it. That is the point: the client never says "I am user X",
 * it presents a token the server validates against Supabase's public keys, and
 * the server decides who that is. A client claiming an id in a request body is
 * not authentication, and nothing here does it.
 *
 * The token is read fresh through the Supabase client on every call rather than
 * cached, because the client rotates it. A cached copy is an intermittent 401
 * an hour later — the worst kind of bug to chase.
 */

import { getAccessToken } from '../supabase'
import { getApiUrl } from '../platform/apiUrl'
import {
  ApiError, ERROR_CODES, NETWORK_MESSAGE, SESSION_ENDED_MESSAGE,
  messageForStatus, codeForStatus, notifySessionEnded,
} from '../errors'

// Re-exported: callers have always imported these from here.
export { ApiError }

/** Thrown when the caller is not signed in. The auth provider signs out on it. */
export const NOT_AUTHENTICATED = ERROR_CODES.NOT_AUTHENTICATED

/**
 * How long a call may take before it is abandoned. Without a limit a server
 * that accepted the connection and never answered left a spinner running
 * forever. Calls that legitimately take longer pass their own.
 */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * @param {string} path            e.g. '/api/storage/upload-url'
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {object} [opts.body]     serialised as JSON
 * @param {boolean} [opts.auth]    default true; false for genuinely public routes
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<any>} the parsed JSON body
 * @throws {ApiError} with a message written for the person using the app
 */
export async function apiFetch(path, { method = 'GET', body, auth = true, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // Resolved before anything else. A native build without EXPO_PUBLIC_API_BASE
  // throws here, and inside the request's try that surfaced as "could not reach
  // the server — check your connection", sending people to fix their wifi.
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

  const headers = { Accept: 'application/json' }

  if (auth) {
    let token
    try {
      token = await getAccessToken()
    } catch {
      // The session could not be refreshed with no connection. Not a sign-out.
      throw new ApiError(NETWORK_MESSAGE, 0, ERROR_CODES.NETWORK)
    }
    if (!token) {
      notifySessionEnded()
      throw new ApiError(SESSION_ENDED_MESSAGE, 401, NOT_AUTHENTICATED)
    }
    headers.Authorization = `Bearer ${token}`
  }

  if (body !== undefined) headers['Content-Type'] = 'application/json'

  // Cancelled while the token was being read: do not start a request at all.
  if (signal?.aborted) throw Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' })

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const forwardAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener?.('abort', forwardAbort)
  }

  let res
  let text = ''
  try {
    res = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    // Read inside the timeout too: a body that never finishes is the same hang.
    if (res.status !== 204) text = await res.text()
  } catch (e) {
    if (timedOut) {
      throw new ApiError('The server took too long to respond. Please try again.', 0, ERROR_CODES.TIMEOUT)
    }
    if (signal?.aborted || e?.name === 'AbortError') throw e
    throw new ApiError(NETWORK_MESSAGE, 0, ERROR_CODES.NETWORK)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', forwardAbort)
  }

  // 204 and friends carry no body; asking for JSON would throw.
  if (res.status === 204) return null

  let json = null
  if (text) { try { json = JSON.parse(text) } catch { /* an HTML error page from a proxy */ } }

  if (!res.ok) {
    // Only OUR auth check says NOT_AUTHENTICATED. Anything else that answers
    // 401 must not sign the user out — a generator refusing the server's key
    // once did exactly that.
    if (json?.code === NOT_AUTHENTICATED) {
      notifySessionEnded()
      throw new ApiError(SESSION_ENDED_MESSAGE, 401, NOT_AUTHENTICATED, json)
    }

    // Our endpoints send { error, code } with a sentence written for people.
    // Anything else (a proxy's HTML page, the generator's own { code, msg })
    // gets a message chosen by status; the provider re-words generator codes.
    const ours = typeof json?.error === 'string' && json.error
    throw new ApiError(
      ours || messageForStatus(res.status),
      res.status,
      json?.code ?? codeForStatus(res.status),
      json,
    )
  }

  return json
}
