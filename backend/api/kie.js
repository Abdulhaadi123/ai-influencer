/**
 * /api/kie — authenticated proxy to api.kie.ai
 *
 * Callers pass the upstream path in `__kiepath` (injected by the vercel.json
 * rewrite) and this attaches the server-side key.
 *
 * ── What changed and why ─────────────────────────────────────────────────────
 *
 * This used to be an open edge function: anyone who found the URL could spend
 * the account's generation credits, and the mobile app skipped it entirely,
 * shipping EXPO_PUBLIC_KIE_API_KEY inside the .apk where anyone could extract
 * it. Both are now closed — the key exists only here, and every request must
 * carry a valid Supabase session.
 *
 * It also moved off the edge runtime so it can share the same JWT verification
 * as every other endpoint. The responses are small JSON payloads, so nothing of
 * value is lost by buffering them.
 */

import { requireUser, applyCors } from './_lib/auth.js'
import { rateLimit } from '../lib/rateLimit.js'

const KIE_BASE = 'https://api.kie.ai'
// File uploads live on a different host to the rest of the API.
const REDPANDA_BASE = 'https://kieai.redpandaai.co'

const API_KEY = process.env.KIE_API_KEY || ''

/**
 * The credit check tells the app whether generation is working. Its answer also
 * carries the account's remaining balance, which is the studio's business, not
 * every user's — so the number is removed unless this is explicitly turned on
 * (worth doing on a development server, where the diagnostics show it).
 */
const CREDIT_PATH = '/api/v1/chat/credit'
const EXPOSE_CREDIT_BALANCE = process.env.EXPOSE_CREDIT_BALANCE === 'true'

/**
 * Only the routes the app actually uses. An open proxy would let an
 * authenticated user reach any KIE endpoint on the account's dime, including
 * ones with different billing or destructive semantics.
 */
const ALLOWED_PATHS = [
  '/api/v1/jobs/createTask',
  '/api/v1/jobs/recordInfo',
  '/api/v1/veo/generate',
  '/api/v1/veo/record-info',
  '/api/v1/chat/credit',
  '/api/file-base64-upload',
]

function isAllowedPath(p) {
  return ALLOWED_PATHS.includes(p)
}

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET, POST, OPTIONS')) return

  const user = await requireUser(req, res)
  if (!user) return

  if (!API_KEY) {
    console.error('[kie] KIE_API_KEY is not configured')
    return res.status(503).json({ error: 'The generation engine is not configured.', code: 'ENGINE_NOT_CONFIGURED' })
  }

  // Rate limited per user rather than per IP: several people behind one office
  // NAT should not throttle each other, and a single account hammering the API
  // is the case actually worth stopping.
  const rl = rateLimit(`user:${user.id}`)
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    return res.status(429).json({ error: 'Too many requests — slow down a moment and try again.', code: 'RATE_LIMITED' })
  }

  const url = new URL(req.url, 'http://localhost')
  const subPath = '/' + (url.searchParams.get('__kiepath') || '').replace(/^\/+/, '')
  url.searchParams.delete('__kiepath')
  const qs = url.searchParams.toString()

  if (!isAllowedPath(subPath)) {
    return res.status(400).json({ error: 'That upstream path is not allowed.', code: 'BAD_PATH' })
  }

  const base = subPath.startsWith('/api/file-') ? REDPANDA_BASE : KIE_BASE
  const target = `${base}${subPath}${qs ? `?${qs}` : ''}`

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      ...(req.method !== 'GET' && req.method !== 'HEAD'
        ? { body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}) }
        : {}),
    })

    let text = await upstream.text()

    if (subPath === CREDIT_PATH && !EXPOSE_CREDIT_BALANCE) {
      try {
        const json = JSON.parse(text)
        if (json && typeof json === 'object' && 'data' in json) text = JSON.stringify({ ...json, data: null })
      } catch { /* not JSON — passed on untouched, it carries no balance we can read */ }
    }

    // KIE refusing OUR key is not the caller's session failing. Passed through
    // as a 401, the app read it as "your session has ended".
    if (upstream.status === 401 || upstream.status === 403) {
      console.error('[kie] upstream rejected the API key:', upstream.status, text.slice(0, 200))
      return res.status(502).json({
        error: "The generation engine rejected the server's API key.",
        code: 'ENGINE_KEY_REJECTED',
      })
    }

    res.status(upstream.status)
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
    res.setHeader('Cache-Control', 'private, no-store')
    return res.send(text)
  } catch (e) {
    console.error('[kie] upstream failed:', e?.message ?? e)
    return res.status(502).json({ error: 'The generation engine could not be reached.', code: 'ENGINE_UNREACHABLE' })
  }
}
