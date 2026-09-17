/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Server-side authentication.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every endpoint that touches user data starts here. The rule it enforces:
 *
 *   The caller does not get to say who they are.
 *
 * The app sends `Authorization: Bearer <access token>`. The token is looked up
 * in `sessions` (see sessions.js), and the user id comes out of that row —
 * never out of the request body. An endpoint that read `req.body.userId` would
 * let anyone read anyone's files by editing one value, which is precisely the
 * class of bug this file exists to make impossible.
 */

import { findSessionByAccessToken } from './sessions.js'
import { classifyServerError } from './errors.js'

export function bearerToken(req) {
  const header = req.headers?.authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  const token = match ? match[1].trim() : null
  // A real token is 43 characters; anything far off is not worth a query.
  return token && token.length <= 200 ? token : null
}

/**
 * The signed-in caller, or null.
 *
 * @returns {Promise<{id, email, displayName, emailConfirmed, sessionId} | null>}
 * @throws when the database cannot be asked — that is not the caller's fault,
 *         and must not be answered as "sign in again"
 */
export async function getUser(req) {
  const token = bearerToken(req)
  if (!token) return null
  return findSessionByAccessToken(token)
}

/**
 * Guard for a handler. Responds 401 when there is no valid session and 503 when
 * the session cannot be checked, returning null either way so a caller can
 * simply `if (!user) return`.
 *
 * The app signs out on `code: 'NOT_AUTHENTICATED'` and on nothing else, so that
 * code must only ever mean "this token is not a session".
 */
export async function requireUser(req, res) {
  let user
  try {
    user = await getUser(req)
  } catch (e) {
    console.error('[auth] could not verify a session:', e?.message ?? e)
    const known = classifyServerError(e) || {
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      error: 'Your session could not be checked right now. Please try again shortly.',
    }
    res.status(known.status).json({ error: known.error, code: known.code })
    return null
  }

  if (!user) {
    res.status(401).json({ error: 'Sign in to continue.', code: 'NOT_AUTHENTICATED' })
    return null
  }
  return user
}

/** The caller's IP. Correct behind Caddy because server/index.js trusts one proxy hop. */
export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

/**
 * CORS for browser callers. The mobile app sends no Origin and is not subject
 * to CORS, so an empty ALLOWED_ORIGINS allows no website at all.
 */
export function applyCors(req, res, methods = 'GET, POST, OPTIONS') {
  const origin = req.headers?.origin
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', methods)
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') { res.status(204).end(); return true }
  return false
}
