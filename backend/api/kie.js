/**
 * /api/kie — authenticated proxy to api.kie.ai
 *
 * Callers pass the upstream path in `__kiepath` (set from the URL by
 * server/index.js) and this attaches the server-side key.
 *
 * ── What changed and why ─────────────────────────────────────────────────────
 *
 * This used to be an open edge function: anyone who found the URL could spend
 * the account's generation credits, and the mobile app skipped it entirely,
 * shipping EXPO_PUBLIC_KIE_API_KEY inside the .apk where anyone could extract
 * it. Both are now closed — the key exists only here, and every request must
 * carry a valid session.
 *
 * It also moved off the edge runtime so it can share the same JWT verification
 * as every other endpoint. The responses are small JSON payloads, so nothing of
 * value is lost by buffering them.
 */

import { requireUser, applyCors } from './_lib/auth.js'
import { sendServerError } from './_lib/errors.js'
import { isModelEnabled, modeOf, MODEL_UNAVAILABLE_MESSAGE } from './_lib/prices.js'
import { withProviderFilters } from './_lib/moderation/kieFilters.js'
import { screenCreateRequest, screenBase64Upload, ModerationRefusal } from './_lib/moderation/service.js'
import { callbackUrl } from './kie-callback.js'
import { reserve, attachTask, giveBack, BillingRefusal } from './_lib/billing.js'
import { rateLimit } from '../lib/rateLimit.js'

// KIE_BASE_URL only points tests at a local stand-in; production leaves it unset.
const KIE_BASE = process.env.KIE_BASE_URL || 'https://api.kie.ai'
// File uploads live on a different host to the rest of the API. Overridable only
// so tests can stand in for it, like KIE_BASE_URL.
const REDPANDA_BASE = process.env.KIE_FILE_BASE_URL || 'https://kieai.redpandaai.co'

const API_KEY = process.env.KIE_API_KEY || ''

/**
 * The credit check tells the app whether generation is working. Its answer also
 * carries the account's remaining balance, which is the studio's business, not
 * every user's — so the number is removed unless this is explicitly turned on
 * (worth doing on a development server, where the diagnostics show it).
 */
const CREDIT_PATH = '/api/v1/chat/credit'
const EXPOSE_CREDIT_BALANCE = process.env.EXPOSE_CREDIT_BALANCE === 'true'

/** The path the app starts its work with, and so the one that asks for a callback. */
const CREATE_TASK_PATH = '/api/v1/jobs/createTask'

/**
 * Every path that starts paid work. All of them are checked before anything is
 * sent: a refused request must cost nothing, and a path left out of this list
 * would be a way round the check.
 */
const PAID_PATHS = new Set([CREATE_TASK_PATH, '/api/v1/veo/generate'])

/** Files go to KIE through here, so this is where they are checked. */
const UPLOAD_PATH = '/api/file-base64-upload'

/**
 * A job's status. KIE's answer carries `creditsConsumed` — what the job cost the
 * studio. The server records it for admins (generation_jobs.kie_credits); like the
 * account balance above, it is not something every user's app is shown.
 */
const RECORD_INFO_PATHS = new Set(['/api/v1/jobs/recordInfo', '/api/v1/veo/record-info'])

/** `text` (KIE's JSON answer) without `data.creditsConsumed`; anything else untouched. */
export function withoutStudioCost(text) {
  try {
    const json = JSON.parse(text)
    if (json && typeof json === 'object' && json.data && typeof json.data === 'object' && 'creditsConsumed' in json.data) {
      const { creditsConsumed: _studioCost, ...data } = json.data
      return JSON.stringify({ ...json, data })
    }
  } catch { /* not JSON: there is nothing in it to remove */ }
  return text
}

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

/** The request body as an object, or null when there is none or it is not JSON. */
function readPayload(req) {
  const body = req.body ?? {}
  if (typeof body !== 'string') return body
  try { return JSON.parse(body) } catch { return null }
}

/**
 * The body to forward.
 *
 * A createTask request also carries `callBackUrl`, so KIE tells us the moment
 * the job finishes (api/kie-callback.js) instead of the worker discovering it
 * on its next sweep. The app never sends this and cannot influence it: the URL
 * and the secret that signs its callbacks are the server's alone. With
 * callbacks not configured, nothing is added and the worker collects as before.
 *
 * It also switches on KIE's own content filter (`nsfw_checker`) for the models
 * that have one — same rule, the server's alone. See moderation/kieFilters.js.
 */
export function bodyToForward(req, subPath) {
  if (req.method === 'GET' || req.method === 'HEAD') return null

  const payload = readPayload(req)
  if (payload === null) return req.body   // not JSON, and not ours to rewrite
  if (!PAID_PATHS.has(subPath) || !isPlainObject(payload)) return JSON.stringify(payload)

  // Whatever the client put in `callBackUrl` is dropped: KIE would post the result
  // to any address it was given. The server's own goes in, on createTask, if there is one.
  const { callBackUrl: _fromClient, ...own } = payload
  if (subPath !== CREATE_TASK_PATH) return JSON.stringify(own)

  const url = callbackUrl()
  return JSON.stringify(withProviderFilters(url ? { ...own, callBackUrl: url } : own))
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Everything that must be true before a request is sent to KIE. Throws
 * ModerationRefusal (content) or BillingRefusal (credits) for anything refused;
 * resolves when the request may go — with the credits taken for it, if any.
 *
 * The credits are taken LAST, so a request that moderation turns down costs nothing.
 */
async function checkBeforeSending(req, subPath, user) {
  // Something that cannot be read cannot be checked, so it is not sent. (The JSON
  // parser in front of this never lets one through; this is for the day that changes.)
  if ((PAID_PATHS.has(subPath) || subPath === UPLOAD_PATH) && readPayload(req) === null) {
    throw new ModerationRefusal(400, 'BAD_REQUEST', 'The request body must be JSON.')
  }
  if (PAID_PATHS.has(subPath)) {
    const payload = readPayload(req)
    if (!(await isModelEnabled(payload?.model, modeOf(payload)))) {
      throw new ModerationRefusal(403, 'MODEL_UNAVAILABLE', MODEL_UNAVAILABLE_MESSAGE)
    }
    await screenCreateRequest({ user, payload })
    return reserve({ user, payload })
  }
  if (subPath === UPLOAD_PATH) {
    await screenBase64Upload({ user, payload: readPayload(req) })
  }
  return null
}

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET, POST, OPTIONS')) return

  const user = await requireUser(req, res)
  if (!user) return

  if (!API_KEY) {
    console.error('[kie] KIE_API_KEY is not configured')
    return res.status(503).json({ error: 'Generation is currently unavailable.', code: 'ENGINE_NOT_CONFIGURED' })
  }

  // Rate limited per user rather than per IP: several people behind one office
  // NAT should not throttle each other, and a single account hammering the API
  // is the case actually worth stopping.
  const rl = rateLimit(`user:${user.id}`)
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.', code: 'RATE_LIMITED' })
  }

  const url = new URL(req.url, 'http://localhost')
  const subPath = '/' + (url.searchParams.get('__kiepath') || '').replace(/^\/+/, '')
  url.searchParams.delete('__kiepath')
  const qs = url.searchParams.toString()

  if (!isAllowedPath(subPath)) {
    return res.status(400).json({ error: 'This request is not allowed.', code: 'BAD_PATH' })
  }

  let hold = null
  try {
    hold = await checkBeforeSending(req, subPath, user)
  } catch (e) {
    if (e instanceof ModerationRefusal) return res.status(e.status).json({ error: e.message, code: e.code })
    if (e instanceof BillingRefusal) return res.status(e.status).json(e.body)
    return sendServerError(res, e, { tag: '[kie] pre-flight check failed:', message: 'Generation is currently unavailable. Please try again shortly.' })
  }

  // The credits taken for this request are either tied to the task KIE starts or given
  // back — once, whichever way the request ends.
  let holdOpen = hold !== null
  const settleHold = async (accepted, answer) => {
    if (!holdOpen) return
    holdOpen = false
    try {
      let taskId = null
      if (accepted) {
        try { const json = JSON.parse(answer); if (json?.code === 200) taskId = json?.data?.taskId || null } catch { /* not JSON: no task */ }
      }
      if (taskId) {
        // KIE has started (and will charge for) this task, so a database hiccup here must not leave the spend
        // loose: loose spends are given back by the worker after ten minutes.
        try { await attachTask(hold.id, taskId) } catch { await attachTask(hold.id, taskId) }
      } else {
        await giveBack(hold.id, 'The generator did not start the task')
      }
    } catch (e) {
      console.error('[kie] could not settle the credits taken for a request:', e?.message ?? e)
    }
  }

  const base = subPath.startsWith('/api/file-') ? REDPANDA_BASE : KIE_BASE
  const target = `${base}${subPath}${qs ? `?${qs}` : ''}`
  const body = bodyToForward(req, subPath)

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      ...(body !== null ? { body } : {}),
    })

    let text = await upstream.text()

    if (subPath === CREDIT_PATH && !EXPOSE_CREDIT_BALANCE) {
      try {
        const json = JSON.parse(text)
        if (json && typeof json === 'object' && 'data' in json) text = JSON.stringify({ ...json, data: null })
      } catch { /* not JSON — passed on untouched, it carries no balance we can read */ }
    }
    if (RECORD_INFO_PATHS.has(subPath)) text = withoutStudioCost(text)

    await settleHold(upstream.ok, text)

    // KIE refusing OUR key is not the caller's session failing. Passed through
    // as a 401, the app read it as "your session has ended".
    if (upstream.status === 401 || upstream.status === 403) {
      console.error('[kie] upstream rejected the API key:', upstream.status, text.slice(0, 200))
      return res.status(502).json({
        error: "Generation is currently unavailable.",
        code: 'ENGINE_KEY_REJECTED',
      })
    }

    res.status(upstream.status)
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
    res.setHeader('Cache-Control', 'private, no-store')
    return res.send(text)
  } catch (e) {
    await settleHold(false, '')
    console.error('[kie] upstream failed:', e?.message ?? e)
    return res.status(502).json({ error: 'The generation service could not be reached. Please try again shortly.', code: 'ENGINE_UNREACHABLE' })
  }
}
