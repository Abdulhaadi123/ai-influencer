/**
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /webhooks/kie — KIE tells us a generation finished.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every createTask we send carries a `callBackUrl` pointing here (api/kie.js),
 * so a finished job arrives in seconds instead of being discovered by the
 * worker's next sweep. The worker still runs: a callback can be missed — a
 * deploy, a restart, a dropped connection — and this endpoint is the fast path,
 * never the only one.
 *
 * ── Why this is the one endpoint with no session ─────────────────────────────
 *
 * KIE cannot hold a user's session, so this route is open by necessity. That
 * makes it the one place where "who is asking" has to be proved another way:
 *
 *   1. Every request carries an HMAC-SHA256 signature over `taskId.timestamp`,
 *      keyed with KIE_WEBHOOK_SECRET (generated at kie.ai/settings). It is
 *      compared in constant time, and a request without a valid one is refused.
 *      Without the secret configured we refuse EVERY callback rather than
 *      trusting an unsigned one — an unauthenticated "this job is done, here is
 *      the file" would otherwise let anyone put any file into any account.
 *
 *   2. Nothing in the payload is taken as fact except the task id. The owner,
 *      the influencer and the label all come from OUR row for that task. A
 *      callback naming a user id would be a way to write into another account.
 *
 * The bytes are never fetched from a URL in the callback either: applyKieStatus
 * records the result link on the job, and collection re-checks it against the
 * allowlist in _lib/results.js.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

import { one } from './_lib/db.js'
import { collect } from './_lib/collect.js'
import { applyKieStatus } from './_lib/kieStatus.js'
import { createRateLimiter } from '../lib/rateLimit.js'

const SECRET = process.env.KIE_WEBHOOK_SECRET || ''

/** Where KIE is told to send callbacks. */
export const CALLBACK_PATH = '/webhooks/kie'

/**
 * How far out of date a callback's timestamp may be. Defence in depth only —
 * the signature is what proves the sender, and a replayed callback changes
 * nothing (applyKieStatus is compare-and-set, collection is idempotent). Kept
 * loose so a clock a few minutes off does not drop real results.
 */
const TIMESTAMP_TOLERANCE_SECONDS = 15 * 60

/** Callbacks all come from KIE, so this only caps a flood of forgeries. */
const byIp = createRateLimiter([{ windowMs: 10_000, max: 120 }])

/**
 * Whether callbacks can be accepted at all. When false, api/kie.js does not ask
 * for them and this endpoint refuses everything — the worker collects instead.
 */
export function webhooksConfigured() {
  return !!SECRET && !!publicBase()
}

function publicBase() {
  return (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
}

/** The absolute URL to put in `callBackUrl`, or null when not configured. */
export function callbackUrl() {
  return webhooksConfigured() ? `${publicBase()}${CALLBACK_PATH}` : null
}

export function signPayload(taskId, timestampSeconds, secret = SECRET) {
  return createHmac('sha256', secret).update(`${taskId}.${timestampSeconds}`).digest('base64')
}

/** Constant-time compare, so a wrong signature cannot be found byte by byte. */
export function signatureMatches(expected, received) {
  const a = Buffer.from(String(expected))
  const b = Buffer.from(String(received ?? ''))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** KIE's own field naming differs between its docs and its payloads. */
function taskIdOf(body) {
  const id = body?.data?.taskId ?? body?.data?.task_id ?? body?.taskId
  return typeof id === 'string' && id && id.length <= 200 ? id : null
}

const urlsFrom = value => (Array.isArray(value) ? value.filter(u => typeof u === 'string') : [])

/**
 * KIE's answer, in the shape _lib/kieStatus.js already folds into a job —
 * the same shape fetchKieTaskStatus returns, so both paths write identically.
 *
 * ── Two payload shapes, because KIE has two families of API ──────────────────
 *
 * The unified Jobs API this app creates its tasks with reports a task the way
 * `recordInfo` does: `data.state`, and the URLs inside `data.resultJson` as a
 * JSON *string*.
 *
 * The per-model APIs (Veo, 4o image, Suno) instead send no `data.state` at all
 * — success is the top-level `code` being 200 — and put the URLs in
 * `data.info.resultUrls`. Reading only `resultJson` meant such a callback
 * arrived, verified, and yielded no result: nothing was collected and the job
 * silently waited for the worker's sweep instead. Veo is selectable in the
 * studio, so that is a shape we do receive.
 *
 * Both are read here. A job that KIE describes in some third way still resolves
 * — applyKieStatus leaves it untouched without a URL, and the worker asks KIE
 * directly on its next pass.
 */
export function statusFromCallback(body) {
  const data = body?.data || {}
  const state = data.state || (body?.code === 200 ? 'success' : 'fail')

  let resultUrls = []
  if (data.resultJson) {
    try {
      const parsed = typeof data.resultJson === 'string' ? JSON.parse(data.resultJson) : data.resultJson
      resultUrls = urlsFrom(parsed?.resultUrls)
    } catch { /* malformed — treat as none, the worker will ask KIE directly */ }
  }
  if (!resultUrls.length) resultUrls = urlsFrom(data.info?.resultUrls ?? data.resultUrls)

  return {
    state,
    resultUrls,
    // The per-model shape carries no data.failMsg — its reason is the top-level
    // `msg` ("Failed", "Client error"), which is worth keeping rather than
    // filing every such failure as a bare "This generation failed."
    failMsg: data.failMsg || data.failCode || (state === 'fail' ? body?.msg : null) || null,
    completeTime: data.completeTime || null,
  }
}

/**
 * Record the answer and collect the file. Runs after the response has been
 * sent: downloading a 50 MB video takes minutes, and KIE must not be left
 * holding the connection for it. A failure here is logged and left to the
 * worker's sweep.
 */
export async function processCallback(taskId, status) {
  // The owner comes from our row, never from the payload. Two rows can only
  // exist if a second account registered someone else's task id, in which case
  // the first registration is the real one.
  const job = await one(
    `select id, user_id, influencer_id, kie_task_id, kind, label, state, result_url
       from generation_jobs where kie_task_id = $1 order by created_at asc limit 1`,
    [taskId],
  )
  if (!job) {
    // The app registers a job immediately after KIE accepts it, but a very fast
    // job can finish first. The worker picks it up once the row exists.
    console.warn(`[webhook] no job for ${taskId}; leaving it to the worker`)
    return
  }

  const { job: updated, settledNow } = await applyKieStatus({ userId: job.user_id, taskId, status })

  if (settledNow && updated?.state === 'success' && updated.result_url) {
    await collect({ ...job, result_url: updated.result_url }, '[webhook]')
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  if (!webhooksConfigured()) {
    console.error('[webhook] a callback arrived but KIE_WEBHOOK_SECRET / PUBLIC_BASE_URL are not set — refusing it')
    return res.status(503).json({ error: 'Callbacks are not enabled on this server.' })
  }

  const ip = req.ip || req.socket?.remoteAddress || 'unknown'
  if (!byIp(`ip:${ip}`).ok) return res.status(429).json({ error: 'Too many requests.' })

  const timestamp = req.headers['x-webhook-timestamp']
  const signature = req.headers['x-webhook-signature']
  if (!timestamp || !signature) {
    console.warn('[webhook] refused: the signature headers are missing')
    return res.status(401).json({ error: 'Missing signature headers.' })
  }

  const taskId = taskIdOf(req.body)
  if (!taskId) return res.status(400).json({ error: 'Missing task id.' })

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp))
  if (!Number.isFinite(age) || age > TIMESTAMP_TOLERANCE_SECONDS) {
    console.warn(`[webhook] refused ${taskId}: the timestamp is ${age}s out`)
    return res.status(401).json({ error: 'Stale signature.' })
  }

  if (!signatureMatches(signPayload(taskId, timestamp), signature)) {
    console.warn(`[webhook] refused ${taskId}: the signature does not match`)
    return res.status(401).json({ error: 'Invalid signature.' })
  }

  // Answered before the work starts — see processCallback.
  res.status(200).json({ code: 200, msg: 'success' })

  const status = statusFromCallback(req.body)
  console.log(`[webhook] ${taskId} → ${status.state}`)
  processCallback(taskId, status).catch(e =>
    console.error(`[webhook] could not process ${taskId}:`, e?.message ?? e))
}
