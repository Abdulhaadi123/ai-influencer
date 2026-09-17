/**
 * ─────────────────────────────────────────────────────────────────────────────
 * What a failed request tells the client.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every endpoint's catch block used to answer every failure with the same 500
 * and a generic sentence — including failures that were not the user's doing
 * and had a precise cause: a server missing its configuration, credentials AWS
 * refuses, a database it cannot reach. Those now say what happened, with a
 * `code` the app can act on. The full error still goes to the server log and
 * never to the client, which only ever sees the sentence and the code.
 */

/** A dependency could not answer — not the caller's fault, and worth retrying. */
export class ServiceUnavailableError extends Error {
  constructor(message, code = 'SERVICE_UNAVAILABLE') {
    super(message)
    this.name = 'ServiceUnavailableError'
    this.code = code
  }
}

/** Thrown by db(), s3() and friends when their environment variables are absent. */
const NOT_CONFIGURED = /must be set|is not set/i

/** Postgres refusing our credentials or database name: a server setup problem. */
const DB_MISCONFIGURED = new Set(['28P01', '28000', '3D000'])

/** Postgres up but not taking connections, or the connection failing outright. */
const DB_UNAVAILABLE = new Set(['57P03', '53300', '08001', '08004', '08006'])

/** AWS SDK error names that mean "storage refused us", not "the request was bad". */
const STORAGE_REFUSED = new Set([
  'CredentialsProviderError', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied',
  'ExpiredToken', 'InvalidToken', 'NoSuchBucket', 'PermanentRedirect', 'AuthorizationHeaderMalformed',
])

/** Node and pg wordings for a connection that never happened. */
const UNREACHABLE = /fetch failed|network request failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|timeout exceeded when trying to connect|Connection terminated/i

/**
 * @returns {{status: number, code: string, error: string} | null} null for a
 *          failure with no better description than the endpoint's own
 */
export function classifyServerError(e) {
  if (e instanceof ServiceUnavailableError) {
    return { status: 503, code: e.code, error: e.message }
  }
  if (e?.name === 'EngineKeyRejectedError') {
    return { status: 502, code: 'ENGINE_KEY_REJECTED', error: e.message }
  }
  if (NOT_CONFIGURED.test(e?.message || '') || DB_MISCONFIGURED.has(e?.code)) {
    return {
      status: 503,
      code: 'SERVER_NOT_CONFIGURED',
      error: 'The server is not fully set up yet, so this cannot be done right now.',
    }
  }
  if (STORAGE_REFUSED.has(e?.name) || STORAGE_REFUSED.has(e?.Code)) {
    return {
      status: 503,
      code: 'STORAGE_UNAVAILABLE',
      error: 'The server could not reach file storage. Please try again later.',
    }
  }
  const text = [e?.message, e?.details, e?.code, e?.cause?.code, e?.cause?.message].filter(Boolean).join(' ')
  if (UNREACHABLE.test(text) || DB_UNAVAILABLE.has(e?.code)) {
    return {
      status: 503,
      code: 'UPSTREAM_UNAVAILABLE',
      error: 'The server could not reach a service it depends on. Please try again shortly.',
    }
  }
  return null
}

/**
 * Log a failure in full and answer with what the client should see.
 *
 * @param {object} res
 * @param {unknown} e
 * @param {{tag: string, message: string}} opts  `message` is the endpoint's own
 *        sentence for a failure nothing more specific describes
 */
export function sendServerError(res, e, { tag, message }) {
  console.error(tag, e)
  const known = classifyServerError(e)
  if (known) return res.status(known.status).json({ error: known.error, code: known.code })
  return res.status(500).json({ error: message, code: 'INTERNAL' })
}
