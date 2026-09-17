/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Errors — what went wrong, in words a person can act on.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Screens used to show `e.message` from wherever an error came from: a raw
 * database message ("Could not load influencers: TypeError: Network request
 * failed"), a status ("Image generate failed (HTTP 503)"), a vendor code ("KIE
 * returned code 999"), or the wrong explanation entirely (an ended session
 * reported as "the server key was rejected"). This module is the one place that
 * turns a failure into a sentence, so every screen says the same true thing.
 *
 * Plain JavaScript, no platform APIs — both apps import it.
 */

export const ERROR_CODES = Object.freeze({
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  APP_NOT_CONFIGURED: 'APP_NOT_CONFIGURED',
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  DATABASE: 'DATABASE',
  GENERATION_FAILED: 'GENERATION_FAILED',
  REFERENCE_FAILED: 'REFERENCE_FAILED',
  SHARE_FAILED: 'SHARE_FAILED',
})

/**
 * An error whose message was written for the person using the app. Anything
 * thrown as an AppError is shown as it is; anything else goes through
 * userMessage() first.
 */
export class AppError extends Error {
  constructor(message, { code = null, status = null, cause = null } = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = status
    if (cause) this.cause = cause
  }
}

/** A failed call to our own API. `body` is the parsed response, when there was one. */
export class ApiError extends AppError {
  constructor(message, status, code, body = null) {
    super(message, { code, status })
    this.name = 'ApiError'
    this.body = body
  }
}

export const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.'
export const SESSION_ENDED_MESSAGE = 'Your session has ended. Sign in again to continue.'

const NETWORK_PATTERN = /network request failed|failed to fetch|fetch failed|network error|load failed|internet connection/i

export function isNetworkFailure(e) {
  return e?.code === ERROR_CODES.NETWORK || NETWORK_PATTERN.test(`${e?.message || ''} ${e?.details || ''}`)
}

/**
 * Sentinels thrown as bare messages by the generation layer. Screens handle
 * them first; these are what a person sees if one ever reaches a generic path.
 */
const SENTINELS = {
  STILL_RUNNING: 'Still generating — this is taking longer than usual, but it has not failed. It is in the Queue tab.',
  CANCELLED: 'Cancelled.',
  NO_MAIN_IMAGE: 'Add a main image first — it is the face reference.',
  NO_CREATION_PARAMS: 'There is no record of what this influencer was generated from, so it cannot be regenerated.',
}

/** JavaScript's own error types: bugs, never something to show a person. */
const PROGRAMMING_ERRORS = new Set(['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError', 'URIError'])

/**
 * The sentence to show for a failure.
 *
 * @param {unknown} e
 * @param {string} fallback  what to say when the error carries nothing a person
 *        should read — make it specific to the action ("Could not save the image")
 */
export function userMessage(e, fallback = 'That did not work. Please try again.') {
  if (!e) return fallback
  if (typeof e === 'string') return SENTINELS[e] || e
  if (e instanceof AppError) return e.message || fallback
  if (SENTINELS[e.message]) return SENTINELS[e.message]
  if (isNetworkFailure(e)) return NETWORK_MESSAGE
  if (PROGRAMMING_ERRORS.has(e.name) || !e.message) {
    console.warn('[error] unexpected failure:', e)
    return fallback
  }
  // A plain Error from our own code (a validation message, a picker limit).
  return e.message
}

/** Whether this failure means the session is gone — the app signs out instead of showing it. */
export function isSessionEnded(e) {
  return e?.code === ERROR_CODES.NOT_AUTHENTICATED
}


// ── Session ended ────────────────────────────────────────────────────────────
//
// Any layer can discover the session is gone — an API call answering
// NOT_AUTHENTICATED, a database call rejecting the JWT. The auth provider
// listens and signs out with a notice, rather than every screen showing its own
// "sign in again" error while the user is still inside the app.

const sessionListeners = new Set()

export function onSessionEnded(listener) {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

export function notifySessionEnded() {
  for (const listener of [...sessionListeners]) {
    try { listener() } catch (err) { console.warn('[error] session listener failed:', err) }
  }
}

/** For a write that found no signed-in user: signs out, and says so. */
export function signedOutError() {
  notifySessionEnded()
  return new AppError(SESSION_ENDED_MESSAGE, { code: ERROR_CODES.NOT_AUTHENTICATED })
}


// ── Database ─────────────────────────────────────────────────────────────────

/**
 * Turn a supabase-js error into an AppError for `action` ("load your
 * influencers"). The raw message goes to the log; the person gets a sentence.
 */
export function dbError(action, error) {
  const message = error?.message || ''
  console.warn(`[db] could not ${action}:`, message, error?.code || '')

  if (isNetworkFailure(error)) {
    return new AppError(NETWORK_MESSAGE, { code: ERROR_CODES.NETWORK, cause: error })
  }
  if (/jwt|token is expired|invalid claim/i.test(message) || /^PGRST30/.test(error?.code || '')) {
    notifySessionEnded()
    return new AppError(SESSION_ENDED_MESSAGE, { code: ERROR_CODES.NOT_AUTHENTICATED, cause: error })
  }
  if (error?.code === '42501' || /row-level security|permission denied/i.test(message)) {
    return new AppError(`You do not have permission to ${action}.`, { code: ERROR_CODES.FORBIDDEN, cause: error })
  }
  return new AppError(`Could not ${action}. Please try again.`, { code: ERROR_CODES.DATABASE, cause: error })
}


// ── Our API, by status ───────────────────────────────────────────────────────

/** For responses that carried no message of their own — an HTML error page from a proxy, say. */
export function messageForStatus(status) {
  if (status === 400) return 'The server could not understand that request.'
  if (status === 403) return 'You do not have permission to do that.'
  if (status === 404) return 'The server you are connected to does not support this. It may need updating.'
  if (status === 408) return 'The server took too long to respond. Please try again.'
  if (status === 413) return 'That is too large to send.'
  if (status === 429) return 'Too many requests — wait a moment and try again.'
  if (status === 502 || status === 503 || status === 504) return 'The server is not responding right now. Please try again shortly.'
  if (status >= 500) return 'The server hit an unexpected error. Please try again.'
  return 'The server refused that request.'
}

export function codeForStatus(status) {
  if (status === 403) return ERROR_CODES.FORBIDDEN
  if (status === 408) return ERROR_CODES.TIMEOUT
  if (status === 429) return 'RATE_LIMITED'
  if (status === 502 || status === 503 || status === 504) return 'SERVER_UNAVAILABLE'
  return `HTTP_${status}`
}


// ── The generator ────────────────────────────────────────────────────────────
//
// KIE's documented codes, written for the person using the app. The key and
// the credits belong to the studio, not to them, so nothing here tells them to
// fix either — and the vendor's name means nothing to them, so it never appears.

const GENERATOR_MESSAGES = {
  401: "Generation is unavailable right now — the server's generator key was rejected.",
  402: 'Generation is paused — the studio has run out of generation credits.',
  404: 'The generator could not find that job.',
  422: 'The generator did not accept these settings. Try a different model.',
  429: 'The generator is busy right now. Wait a moment and try again.',
  433: 'Generation is paused — the studio has reached its usage limit.',
  455: 'The generator is down for maintenance. Try again shortly.',
  500: 'The generator had a problem on its side. Try again in a moment.',
  501: 'The generator could not create this. Try again, or change the prompt.',
  505: 'That model is not enabled for this studio. Pick a different model.',
}

/** @param {number|string} code  KIE's body-level or HTTP code */
export function generatorMessage(code) {
  return GENERATOR_MESSAGES[code] || `The generator could not start this (code ${code}). Please try again.`
}
