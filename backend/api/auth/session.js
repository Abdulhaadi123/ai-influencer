/**
 * /api/auth/session — the browser's session store.
 *
 * GET    → { session } from the cookie, or { session: null }
 * POST   → { session } persisted into an httpOnly cookie
 * DELETE → cookie cleared
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Supabase's browser default is to keep the session in localStorage, where any
 * script running on the page can read it. That turns one XSS bug into a stolen
 * refresh token, and a refresh token is a durable credential — it keeps minting
 * access tokens long after the tab is closed and the user has forgotten about
 * it.
 *
 * An httpOnly cookie is unreadable from JavaScript. Injected script can still
 * make requests as the user while the page is open, which is bad, but it cannot
 * take the credential away with it. That difference is the whole point.
 *
 * ── Why the cookie is chunked ────────────────────────────────────────────────
 *
 * Browsers cap a cookie at roughly 4 KB. A Supabase session — access JWT with
 * claims, refresh token, and the user object — regularly exceeds that. An
 * oversized Set-Cookie is not an error; the browser simply drops it, and the
 * user is silently signed out on every reload with nothing in any log. So the
 * value is split across numbered cookies and reassembled on read, and a write
 * always clears the previous chunks: shrinking from three to two must not leave
 * a stale third to be concatenated onto the next read.
 */

const BASE = 'ai_session'
const CHUNK_SIZE = 3500          // headroom under 4 KB for name and attributes
const MAX_CHUNKS = 8             // ~28 KB; far beyond any real session
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30

/**
 * SameSite=Lax is right when the app and API share an origin, which is the
 * default deployment. A split origin needs 'None' (and therefore Secure), which
 * is why this is configurable rather than hard-coded — getting it wrong means
 * the cookie is silently not sent.
 */
const SAME_SITE = process.env.SESSION_COOKIE_SAMESITE || 'Lax'

/** Secure is mandatory in production. Localhost over http is the exception. */
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL

function parseCookies(header) {
  const out = {}
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function cookieAttrs(maxAge) {
  return [
    'Path=/',
    'HttpOnly',
    `SameSite=${SAME_SITE}`,
    isProduction || SAME_SITE === 'None' ? 'Secure' : null,
    `Max-Age=${maxAge}`,
  ].filter(Boolean).join('; ')
}

function setChunks(res, value) {
  const chunks = []
  for (let i = 0; i < value.length; i += CHUNK_SIZE) chunks.push(value.slice(i, i + CHUNK_SIZE))

  if (chunks.length > MAX_CHUNKS) throw new Error('Session too large to store.')

  const headers = chunks.map((c, i) =>
    `${BASE}.${i}=${encodeURIComponent(c)}; ${cookieAttrs(MAX_AGE_SECONDS)}`,
  )

  // Expire any chunk the previous session used but this one does not.
  for (let i = chunks.length; i < MAX_CHUNKS; i++) {
    headers.push(`${BASE}.${i}=; ${cookieAttrs(0)}`)
  }

  res.setHeader('Set-Cookie', headers)
}

function clearChunks(res) {
  const headers = []
  for (let i = 0; i < MAX_CHUNKS; i++) headers.push(`${BASE}.${i}=; ${cookieAttrs(0)}`)
  res.setHeader('Set-Cookie', headers)
}

function readSession(req) {
  const cookies = parseCookies(req.headers?.cookie)
  let value = ''
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const part = cookies[`${BASE}.${i}`]
    if (part == null) break        // chunks are contiguous; a gap ends the value
    value += part
  }
  return value || null
}

export default async function handler(req, res) {
  const origin = req.headers?.origin
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)

  // Credentialed requests cannot use a wildcard origin, so it is echoed back
  // only for an allow-listed caller. An empty list allows none — this endpoint
  // returns session tokens, the last thing to share with any site that asks.
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  // A cached session response served to another visitor would be catastrophic.
  res.setHeader('Cache-Control', 'private, no-store')

  if (req.method === 'OPTIONS') return res.status(204).end()

  if (req.method === 'GET') {
    return res.status(200).json({ session: readSession(req) })
  }

  if (req.method === 'POST') {
    const { session } = req.body || {}
    if (typeof session !== 'string' || !session) {
      return res.status(400).json({ error: 'session must be a non-empty string.' })
    }
    try {
      setChunks(res, session)
      return res.status(200).json({ ok: true })
    } catch (e) {
      console.error('[auth/session]', e)
      return res.status(413).json({ error: 'Session too large to store.' })
    }
  }

  if (req.method === 'DELETE') {
    clearChunks(res)
    return res.status(204).end()
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
