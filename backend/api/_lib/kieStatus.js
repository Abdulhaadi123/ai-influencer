/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Where a generation job stands — asked of KIE, written to the queue.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Used by the worker (every job, continuously) and by /api/jobs/sync (the job
 * a screen is watching). Only the server writes a job's state and result link,
 * and only from KIE's own answer: a client can ask for a job to be checked, but
 * cannot say what the answer was. Otherwise any user could plant a link in their
 * queue for the worker to fetch into storage.
 */

import { one } from './db.js'
import { recordProviderRefusal } from './moderation/providerRefusals.js'
import { refundTask } from './billing.js'

/** Overridable only so tests can stand in for KIE; production uses the default. */
const KIE_BASE = process.env.KIE_BASE_URL || 'https://api.kie.ai'
const STATUS_TIMEOUT_MS = 30_000

export const ACTIVE_STATES = ['waiting', 'queuing', 'generating']

export const JOB_COLUMNS = `
  id, influencer_id, kie_task_id, kind, label, model, state, result_url, asset_id, fail_msg,
  created_at, updated_at, completed_at
`

/**
 * KIE's `creditsConsumed` as a number, or null when it did not say (absent, or
 * not a plain non-negative number). Null is not zero: zero means "KIE charged
 * nothing", which is what it reports for a failed task.
 */
export function creditsFrom(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

/** KIE refused the server's key. Not the caller's fault, and not retryable by them. */
export class EngineKeyRejectedError extends Error {
  constructor() {
    super("Generation is currently unavailable.")
    this.name = 'EngineKeyRejectedError'
  }
}

/**
 * The result links inside a task's `resultJson`, whichever shape the model answers in.
 *
 *   • `{ resultUrls: [...] }` — nearly every model (Kling, Wan, Seedance, Hailuo, MiniMax, Grok, ...).
 *   • `{ data: { result_urls: [...], origin_urls: [...] } }` — Veo, which wraps its own answer. `result_urls` holds
 *     the video at the resolution asked for (1080p/4k); `origin_urls` is the 720p original, kept as a fallback.
 *
 * Reading only the first shape meant a Veo job finished on KIE, was charged, and was never found: the app waited,
 * the worker's sweep found nothing, and the person paid for a video they never received. Found by running every
 * model the app offers once for real (23 October 2026); both Veo models answered in the second shape.
 *
 * @param {unknown} resultJson  the JSON string KIE sends (or the object itself)
 * @returns {string[]}  trimmed links, possibly none
 */
export function resultUrlsFrom(resultJson) {
  let parsed = resultJson
  if (typeof resultJson === 'string') {
    try { parsed = JSON.parse(resultJson) } catch { return [] /* malformed — treat as none */ }
  }
  const clean = value => (Array.isArray(value) ? value.filter(u => typeof u === 'string').map(u => u.trim()).filter(Boolean) : [])
  return [parsed?.resultUrls, parsed?.data?.result_urls, parsed?.result_urls, parsed?.data?.origin_urls]
    .map(clean).find(list => list.length) || []
}

/**
 * Ask KIE about one task, normalised.
 *
 * @returns {Promise<{state: string, resultUrls: string[], failMsg: string|null,
 *                    completeTime: number|null, progress: number, credits: number|null}>}
 *   state is KIE's own (waiting/queuing/generating/success/fail), or
 *   'ratelimited' (back off) or 'unknown' (no usable answer this time).
 *   `progress` is 0-100 where the model reports one, and 0 where it does not —
 *   it was being dropped, which is why a running job could only ever be shown
 *   as "started" or "finished".
 *   `credits` is what KIE charged (`creditsConsumed`), null when it did not say.
 */
export async function fetchKieTaskStatus(taskId) {
  const key = process.env.KIE_API_KEY || ''
  if (!key) throw new Error('KIE_API_KEY is not set on the server.')

  const res = await fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${key}` },
    // One hung connection must not stall everything waiting behind it.
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  })

  const none = { resultUrls: [], failMsg: null, completeTime: null, progress: 0, credits: null }
  if (res.status === 401 || res.status === 403) throw new EngineKeyRejectedError()
  if (res.status === 429) return { state: 'ratelimited', ...none }
  if (!res.ok) return { state: 'unknown', ...none }

  const json = await res.json().catch(() => null)
  if (!json) return { state: 'unknown', ...none }
  if (json.code === 429) return { state: 'ratelimited', ...none }
  if (json.code === 401 || json.code === 403) throw new EngineKeyRejectedError()
  if (json.code !== 200) return { state: 'unknown', ...none }

  const d = json.data || {}
  return {
    state: d.state || 'unknown',
    // Trimmed (inside resultUrlsFrom): the address check refuses padding (api/_lib/results.js), and a result KIE has
    // paid for must not be lost because of a space around its link.
    resultUrls: resultUrlsFrom(d.resultJson),
    failMsg: d.failMsg || null,
    completeTime: d.completeTime || null,
    // Only some models report one. Clamped rather than trusted, and 0 means
    // "this model does not say" — never "no work done".
    progress: Math.max(0, Math.min(100, Number(d.progress) || 0)),
    credits: creditsFrom(d.creditsConsumed),
  }
}

/**
 * Fold KIE's answer into the user's job row.
 *
 * Every write is compare-and-set from a running state: a job that has finished
 * is final, however late a status answer arrives. Rewriting a finished job once
 * put the generator's link back on a job whose result was already stored — and
 * deleting that result then let the worker collect it again.
 *
 * @returns {Promise<{job: object|null, settledNow: boolean}>} `settledNow` is
 *          true only for the caller whose write moved the job to success/fail
 */
export async function applyKieStatus({ userId, taskId, status }) {
  const { state } = status

  if (state === 'success' && status.resultUrls?.[0]) {
    const completedAt = status.completeTime ? new Date(status.completeTime) : new Date()
    // What KIE charged is written in the same statement that settles the job, so
    // it can never be missing from a job that is settled. It is not in
    // JOB_COLUMNS: the app has no use for it; only the admin panel reads it.
    const moved = await one(
      `update generation_jobs
          set state = 'success', result_url = $3, completed_at = $4, kie_credits = $6
        where user_id = $1 and kie_task_id = $2 and state = any($5::text[])
        returning ${JOB_COLUMNS}`,
      [userId, taskId, status.resultUrls[0], completedAt, ACTIVE_STATES, creditsFrom(status.credits)],
    )
    if (moved) return { job: moved, settledNow: true }
  } else if (state === 'fail') {
    const moved = await one(
      `update generation_jobs
          set state = 'fail', fail_msg = $3, completed_at = now(), kie_credits = $5
        where user_id = $1 and kie_task_id = $2 and state = any($4::text[])
        returning ${JOB_COLUMNS}`,
      [userId, taskId, String(status.failMsg || 'This generation failed.').slice(0, 1000), ACTIVE_STATES, creditsFrom(status.credits)],
    )
    if (moved) {
      // Only the write that settled the job gets here, so a refusal that arrives by
      // callback, by sync and by the worker is still recorded once.
      await recordProviderRefusal({ userId, taskId, model: moved.model, failMsg: status.failMsg })
      // KIE charged nothing for it, so the user is not charged either.
      await refundTask(userId, taskId, 'Generation failed')
      return { job: moved, settledNow: true }
    }
  } else if (ACTIVE_STATES.includes(state)) {
    // Only when it actually moved: rewriting "generating" over itself would be a
    // write per poll for no information.
    const moved = await one(
      `update generation_jobs
          set state = $3
        where user_id = $1 and kie_task_id = $2 and state = any($4::text[]) and state <> $3
        returning ${JOB_COLUMNS}`,
      [userId, taskId, state, ACTIVE_STATES],
    )
    if (moved) return { job: moved, settledNow: false }
  }

  const job = await one(
    `select ${JOB_COLUMNS} from generation_jobs where user_id = $1 and kie_task_id = $2`,
    [userId, taskId],
  )
  return { job, settledNow: false }
}
