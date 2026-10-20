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
import { SUSPENDED_MESSAGE } from './suspension.js'

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
 * @returns {Promise<{id, email, displayName, emailConfirmed, role, status, sessionId} | null>}
 * @throws when the database cannot be asked — that is not the caller's fault,
 *         and must not be answered as "sign in again"
 */
export async function getUser(req) {
  const token = bearerToken(req)
  if (!token) return null
  return findSessionByAccessToken(token)
}

/**
 * Which sessions may use an endpoint (see sessions.js, "Scope"):
 *
 *   'app'     an 'app' session of an account that is not an administrator — the default
 *   'shared'  that, or an 'admin' session of an administrator: the endpoints about the
 *             caller's own account (profile, password)
 *   'admin'   anything valid: adminRoute makes its own, more specific refusals
 *
 * An account's role is read on every call, so the pairing is checked every call too: an app
 * session whose owner has since been made an administrator stops working (the person signs in
 * again, and is told this is an administrator account), and so does an admin session whose
 * owner has been demoted.
 */
function fitsAudience(user, audience) {
  const asApp = user.scope === 'app' && user.role !== 'admin'
  const asAdmin = user.scope === 'admin' && user.role === 'admin'
  if (audience === 'app') return asApp
  if (audience === 'shared') return asApp || asAdmin
  return true
}

/**
 * Guard for a handler. Responds 401 when there is no valid session and 503 when
 * the session cannot be checked, returning null either way so a caller can
 * simply `if (!user) return`.
 *
 * The app signs out on `code: 'NOT_AUTHENTICATED'` and on nothing else, so that
 * code must only ever mean "this token is not a session" — which includes a
 * session that is not one for this place (an admin token on an app endpoint).
 *
 * @param {{audience?: 'app'|'shared'|'admin'}} [opts]  who may call — see fitsAudience
 */
export async function requireUser(req, res, { audience = 'app' } = {}) {
  let user
  try {
    user = await getUser(req)
  } catch (e) {
    console.error('[auth] could not verify a session:', e?.message ?? e)
    const known = classifyServerError(e) || {
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      error: 'Your session could not be verified. Please try again shortly.',
    }
    res.status(known.status).json({ error: known.error, code: known.code })
    return null
  }

  if (!user) {
    res.status(401).json({ error: 'Please sign in to continue.', code: 'NOT_AUTHENTICATED' })
    return null
  }

  // Suspending an account deletes its sessions, so this is rarely reached — it is
  // the second lock on the same door, for a session that somehow outlived it.
  if (user.status !== 'active') {
    res.status(403).json({ error: SUSPENDED_MESSAGE, code: 'ACCOUNT_SUSPENDED' })
    return null
  }

  if (!fitsAudience(user, audience)) {
    res.status(401).json({ error: 'Please sign in to continue.', code: 'NOT_AUTHENTICATED' })
    return null
  }
  return user
}

/**
 * Middleware, mounted at /api before the body parsers: a request that carries a body is not read —
 * let alone parsed — unless it comes with a session.
 *
 * A body is read in full before any handler runs, and the generation proxy's allowance is 10 MB. Without this,
 * anyone on the internet could make the server buffer and parse 10 MB per request just to answer "please sign
 * in". Now that answer is sent first (Node then throws the unread body away as it arrives, without keeping it).
 * Only the sign-in family under /api/auth is open to callers with no session, and it has a 16 KB ceiling of
 * its own; the handlers check the session again, for the audience and the role.
 */
export async function requireSessionBeforeBody(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  if (req.path.startsWith('/auth/')) return next()
  // 'admin' is the widest audience: any valid, active session. What it may do is each handler's business.
  const user = await requireUser(req, res, { audience: 'admin' })
  if (user) next()
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
