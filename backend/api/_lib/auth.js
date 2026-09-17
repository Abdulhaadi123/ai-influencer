/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Server-side authentication.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every endpoint that touches user data starts here. The rule it enforces:
 *
 *   The caller does not get to say who they are.
 *
 * The client sends an `Authorization: Bearer <jwt>` header. That token is
 * verified against Supabase, and the user id comes out of the verified token —
 * never out of the request body. An endpoint that read `req.body.userId` would
 * let anyone read anyone's files by editing one number, which is precisely the
 * class of bug this file exists to make impossible.
 *
 * Verification goes through Supabase rather than decoding the JWT locally.
 * Local verification is faster, but it needs the signing key, has to track
 * whether the project uses HS256 or asymmetric keys, and — the part that
 * matters — cannot know the token was revoked. Asking Supabase means a signed
 * -out session stops working immediately.
 */

import { createClient } from '@supabase/supabase-js'

import { ServiceUnavailableError, classifyServerError } from './errors.js'

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

/**
 * The admin client. Bypasses Row Level Security completely.
 *
 * Only for work the user genuinely cannot do themselves — reading a row to
 * check ownership before signing an S3 URL, sweeping objects after a cascade
 * delete. Every use must filter by the verified user id explicitly, because
 * the safety net of RLS is switched off on this client.
 *
 * This key must never reach a client bundle. It is not `EXPO_PUBLIC_` or
 * `VITE_` prefixed for exactly that reason.
 */
export function adminClient() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set on the server.')
  }
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : null
}

/**
 * Verify the request and return the caller.
 *
 * Two failures are kept apart, because the app reacts to them in opposite ways.
 * A token Supabase REJECTS (4xx: expired, revoked, a deleted user) means the
 * caller is not signed in — null. Supabase being UNREACHABLE, or this server
 * missing its configuration, is not the caller's fault — that throws. Both used
 * to return null, so a server outage answered "sign in to continue" and the app
 * signed people out for a problem that was ours.
 *
 * @returns {Promise<{id: string, email: string} | null>} null when unauthenticated
 * @throws when the token cannot be checked at all
 */
export async function getUser(req) {
  const token = bearerToken(req)
  if (!token) return null

  const { data, error } = await adminClient().auth.getUser(token)
  if (error) {
    if (error.status >= 400 && error.status < 500) return null
    throw new ServiceUnavailableError(
      'Your session could not be checked right now. Please try again shortly.',
      'AUTH_UNAVAILABLE',
    )
  }
  if (!data?.user) return null
  return { id: data.user.id, email: data.user.email }
}

/**
 * Guard for a handler. Responds 401 when there is no valid session and 503 when
 * the session cannot be checked, returning null either way so a caller can
 * simply `if (!user) return`.
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

/** Standard CORS + method handling for the JSON endpoints. */
export function applyCors(req, res, methods = 'POST, OPTIONS') {
  const origin = req.headers?.origin
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  // With credentials in play, '*' is not permitted by the browser, so the
  // origin is echoed back only when it is on the allow-list. An empty list
  // allows no website at all: the mobile app sends no Origin and needs no CORS,
  // and "allow everyone" is not a safe thing for a forgotten setting to mean.
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }
  res.setHeader('Access-Control-Allow-Methods', methods)
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') { res.status(204).end(); return true }
  return false
}
