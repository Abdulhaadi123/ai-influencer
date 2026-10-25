/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoint wrappers.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every endpoint answers failures the same way: a refusal the endpoint meant
 * (HttpError) goes out as written; anything else goes through sendServerError,
 * which logs it in full and tells the client only a sentence and a code.
 *
 *   userRoute   — the caller must be signed in; the handler receives the user
 *   publicRoute — no session needed (sign in, sign up, forgot password…)
 */

import { requireUser } from './auth.js'
import { sendServerError } from './errors.js'
import { createRateLimiter } from '../../lib/rateLimit.js'

export class HttpError extends Error {
  constructor(status, message, code = 'BAD_REQUEST', headers = null) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.headers = headers
  }
}

export const badRequest = (message, code = 'BAD_REQUEST') => new HttpError(400, message, code)
export const forbidden = (message = 'You do not have permission to do this.', code = 'FORBIDDEN') => new HttpError(403, message, code)
export const notFound = (message = 'Not found.', code = 'NOT_FOUND') => new HttpError(404, message, code)

function fail(res, e, opts = {}) {
  if (e instanceof HttpError) {
    for (const [name, value] of Object.entries(e.headers || {})) res.setHeader(name, value)
    return res.status(e.status).json({ error: e.message, code: e.code })
  }
  return sendServerError(res, e, opts)
}

/** @param {(req, res) => Promise<void>} handler */
export function publicRoute(handler, opts) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (e) {
      fail(res, e, opts)
    }
  }
}

/**
 * How fast one signed-in account may call the API in all. Only the generation proxy, the status check, the
 * prompt assistant and reports had a limit of their own, so a script holding any account could write rows
 * (uploads, influencers, jobs) as fast as the database allowed. These numbers are several times what the
 * app does on its busiest screen (a Queue poll every few seconds), so a person never meets them.
 */
const requestsByUser = createRateLimiter([
  { windowMs: 10_000, max: Number(process.env.USER_REQUESTS_PER_10S) || 150 },
  { windowMs: 60_000, max: Number(process.env.USER_REQUESTS_PER_MINUTE) || 600 },
])

/**
 * @param {(req, res, user) => Promise<void>} handler
 * @param {{audience?: 'app'|'shared'|'admin', tag?: string, message?: string}} [opts]
 *        `audience` says which sessions may call (auth.js requireUser); the rest is
 *        what an unexpected failure is logged and answered with
 */
export function userRoute(handler, opts = {}) {
  const { audience, ...failure } = opts
  return async (req, res) => {
    const user = await requireUser(req, res, { audience })
    if (!user) return
    try {
      enforceLimit(requestsByUser, `user:${user.id}`, 'Too many requests. Please wait a moment and try again.')
      await handler(req, res, user)
    } catch (e) {
      fail(res, e, failure)
    }
  }
}

/** Responses carrying a user's data or tokens must never be cached anywhere. */
export function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store')
}

/**
 * Refuse with 429 when `limiter` says the key has used its allowance.
 * @param {(key: string) => {ok: boolean, retryAfter?: number}} limiter
 */
export function enforceLimit(limiter, key, message = null) {
  const result = limiter(key)
  if (!result.ok) {
    throw new HttpError(429, message || waitMessage(result.retryAfter), 'RATE_LIMITED', { 'Retry-After': String(result.retryAfter) })
  }
}

/** Say how long the wait really is — sign-in locks for up to fifteen minutes,
 *  and "wait a minute" sent people straight back into the same refusal. */
function waitMessage(retryAfterSeconds) {
  const minutes = Math.ceil((Number(retryAfterSeconds) || 0) / 60)
  if (minutes <= 1) return 'Too many attempts. Please try again in a minute.'
  return `Too many attempts. Please try again in ${minutes} minutes.`
}
