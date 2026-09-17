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
export const forbidden = (message = 'That is not yours.', code = 'FORBIDDEN') => new HttpError(403, message, code)
export const notFound = (message = 'Not found.', code = 'NOT_FOUND') => new HttpError(404, message, code)

function fail(res, e, opts) {
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

/** @param {(req, res, user) => Promise<void>} handler */
export function userRoute(handler, opts) {
  return async (req, res) => {
    const user = await requireUser(req, res)
    if (!user) return
    try {
      await handler(req, res, user)
    } catch (e) {
      fail(res, e, opts)
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
export function enforceLimit(limiter, key, message = 'Too many attempts. Wait a minute and try again.') {
  const result = limiter(key)
  if (!result.ok) {
    throw new HttpError(429, message, 'RATE_LIMITED', { 'Retry-After': String(result.retryAfter) })
  }
}
