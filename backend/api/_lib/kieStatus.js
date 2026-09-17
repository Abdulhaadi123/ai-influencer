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

/** Overridable only so tests can stand in for KIE; production uses the default. */
const KIE_BASE = process.env.KIE_BASE_URL || 'https://api.kie.ai'
const STATUS_TIMEOUT_MS = 30_000

export const ACTIVE_STATES = ['waiting', 'queuing', 'generating']

export const JOB_COLUMNS = `
  id, influencer_id, kie_task_id, kind, label, model, state, result_url, asset_id, fail_msg,
  created_at, updated_at, completed_at
`

/** KIE refused the server's key. Not the caller's fault, and not retryable by them. */
export class EngineKeyRejectedError extends Error {
  constructor() {
    super("Generation is currently unavailable.")
    this.name = 'EngineKeyRejectedError'
  }
}

/**
 * Ask KIE about one task, normalised.
 *
 * @returns {Promise<{state: string, resultUrls: string[], failMsg: string|null, completeTime: number|null}>}
 *   state is KIE's own (waiting/queuing/generating/success/fail), or
 *   'ratelimited' (back off) or 'unknown' (no usable answer this time)
 */
export async function fetchKieTaskStatus(taskId) {
  const key = process.env.KIE_API_KEY || ''
  if (!key) throw new Error('KIE_API_KEY is not set on the server.')

  const res = await fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${key}` },
    // One hung connection must not stall everything waiting behind it.
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  })

  const none = { resultUrls: [], failMsg: null, completeTime: null }
  if (res.status === 401 || res.status === 403) throw new EngineKeyRejectedError()
  if (res.status === 429) return { state: 'ratelimited', ...none }
  if (!res.ok) return { state: 'unknown', ...none }

  const json = await res.json().catch(() => null)
  if (!json) return { state: 'unknown', ...none }
  if (json.code === 429) return { state: 'ratelimited', ...none }
  if (json.code === 401 || json.code === 403) throw new EngineKeyRejectedError()
  if (json.code !== 200) return { state: 'unknown', ...none }

  const d = json.data || {}
  let resultUrls = []
  if (d.resultJson) {
    try { resultUrls = JSON.parse(d.resultJson).resultUrls || [] } catch { /* malformed — treat as none */ }
  }

  return {
    state: d.state || 'unknown',
    resultUrls: resultUrls.filter(u => typeof u === 'string'),
    failMsg: d.failMsg || null,
    completeTime: d.completeTime || null,
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
    const moved = await one(
      `update generation_jobs
          set state = 'success', result_url = $3, completed_at = $4
        where user_id = $1 and kie_task_id = $2 and state = any($5::text[])
        returning ${JOB_COLUMNS}`,
      [userId, taskId, status.resultUrls[0], completedAt, ACTIVE_STATES],
    )
    if (moved) return { job: moved, settledNow: true }
  } else if (state === 'fail') {
    const moved = await one(
      `update generation_jobs
          set state = 'fail', fail_msg = $3, completed_at = now()
        where user_id = $1 and kie_task_id = $2 and state = any($4::text[])
        returning ${JOB_COLUMNS}`,
      [userId, taskId, String(status.failMsg || 'This generation failed.').slice(0, 1000), ACTIVE_STATES],
    )
    if (moved) return { job: moved, settledNow: true }
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
