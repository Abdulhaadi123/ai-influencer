/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The generation queue.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * KIE is asynchronous and slow, and its result URLs expire in 24 hours, so the
 * taskId is the only durable handle to work already paid for. It is a row on
 * the server, so a video started on a phone can be collected from anywhere.
 *
 * ── Who writes a job's state ─────────────────────────────────────────────────
 *
 * Only the server, from KIE's own answer. The app asks for a job to be checked
 * (syncJob) and gets the answer back; it cannot report a result itself.
 *
 * ── Hearing about changes ────────────────────────────────────────────────────
 *
 * `subscribe()` keeps its old shape — a handler receiving `{ eventType, new }`
 * for each changed job — but there is no push channel behind it any more. One
 * shared poller asks the server what changed since it last looked, every few
 * seconds while anything is subscribed, however many screens are listening.
 * A change can occasionally be reported twice; every handler treats a repeat as
 * a no-op.
 *
 * The pure predicates below are synchronous on purpose: they run inside render.
 */

import { apiFetch } from '../api/client'
import { isSessionEnded } from '../errors'

/** KIE's own vocabulary for "still working". */
export const ACTIVE_STATES = ['waiting', 'queuing', 'generating']

/** KIE's retention window for a finished result. */
export const RESULT_TTL_MS = 24 * 60 * 60 * 1000

function toApp(row) {
  return {
    id: row.id,
    influencerId: row.influencer_id,
    taskId: row.kie_task_id,
    kind: row.kind,
    label: row.label,
    model: row.model,
    state: row.state,
    resultUrl: row.result_url,
    assetId: row.asset_id,
    failMsg: row.fail_msg,
    createdAt: new Date(row.created_at).getTime(),
    completedAt: row.completed_at ? new Date(row.completed_at).getTime() : null,
  }
}

export function isActive(job) {
  return ACTIVE_STATES.includes(job?.state)
}

/**
 * Finished on KIE's side, bytes not yet in our own storage.
 *
 * Requires the result URL: a collected job whose file was later deleted also
 * has no asset, but there is nothing left to collect.
 */
export function isCollectable(job) {
  return job?.state === 'success' && !job?.assetId && !!job?.resultUrl && !isExpired(job)
}

/** Finished, never collected, and past the point where KIE still serves it. */
export function isExpired(job) {
  if (job?.state !== 'success' || job?.assetId || !job?.resultUrl) return false
  return Date.now() - (job.completedAt || job.createdAt || 0) > RESULT_TTL_MS
}

/** Collected once, and the stored file has since been deleted. */
export function isDeleted(job) {
  return job?.state === 'success' && !job?.assetId && !job?.resultUrl
}

/** Every job for the signed-in user, newest first. */
export async function listJobs({ limit = 60 } = {}) {
  const { jobs } = await apiFetch(`/api/jobs?limit=${limit}`)
  return (jobs || []).map(toApp)
}

/** One job by its KIE task id, or null. */
export async function getJobByTaskId(taskId) {
  if (!taskId) return null
  const { job } = await apiFetch(`/api/jobs/by-task?taskId=${encodeURIComponent(taskId)}`)
  return job ? toApp(job) : null
}

export async function countActive() {
  try {
    const { count } = await apiFetch('/api/jobs/active-count')
    return count ?? 0
  } catch (e) {
    console.warn('[jobs] count failed:', e?.message ?? e)
    return 0
  }
}

/**
 * Whether any of this influencer's jobs is still running.
 *
 * The generator downloads a job's reference images when the job STARTS, which
 * can be minutes after it was queued, so a file can be deleted only once nothing
 * running might still need it. Fails safe: when the answer is unknown it says
 * yes, because the question is always "is it safe to delete?".
 */
export async function hasActiveJobs(influencerId) {
  if (!influencerId) return false
  try {
    const { count } = await apiFetch(`/api/jobs/active-count?influencerId=${encodeURIComponent(influencerId)}`)
    return (count ?? 0) > 0
  } catch (e) {
    console.warn('[jobs] active check failed:', e?.message ?? e)
    return true
  }
}

/**
 * Record jobs the moment their taskIds exist — before any polling starts.
 * From that instant KIE is doing paid work, so it must be recoverable even if
 * the app dies a second later. Recording the same task twice changes nothing.
 */
export async function registerJobs(entries) {
  const valid = (entries || []).filter(e => e?.taskId).map(e => ({
    taskId: e.taskId,
    influencerId: e.influencerId || null,
    kind: e.kind || 'image',
    label: e.label || 'Generation',
    model: e.model || null,
  }))
  if (!valid.length) return []

  const { jobs } = await apiFetch('/api/jobs/register', { method: 'POST', body: { entries: valid } })
  return (jobs || []).map(toApp)
}

/**
 * Have the server ask KIE about a task and record the answer.
 *
 * @returns {Promise<{status: {state, resultUrls, failMsg, completeTime}, job: object|null}>}
 *   `status.state` is KIE's own word, or 'ratelimited' / 'unknown'
 */
export async function syncJob(taskId) {
  const { status, job } = await apiFetch(`/api/jobs/sync?taskId=${encodeURIComponent(taskId)}`)
  return { status, job: job ? toApp(job) : null }
}

export async function removeJob(id) {
  await apiFetch('/api/jobs/remove', { method: 'POST', body: { id } })
}

/**
 * Clear everything finished with. Anything still running stays, and so does a
 * finished result that has not been saved yet — its row is the only way left
 * to collect it.
 */
export async function clearSettled() {
  await apiFetch('/api/jobs/clear-settled', { method: 'POST' })
}


// ── Change notifications ─────────────────────────────────────────────────────

/** How often the shared poller asks what changed. */
const POLL_INTERVAL_MS = 5000

const subscribers = new Set()
let pollUserId = null
let cursor = null
let timer = null
let polling = false

async function pollOnce() {
  if (polling || !subscribers.size) return
  polling = true
  const forUser = pollUserId
  try {
    const query = cursor ? `?since=${encodeURIComponent(cursor)}` : ''
    const json = await apiFetch(`/api/jobs/changes${query}`)
    // The user changed while the request was out: its answer belongs to nobody here.
    if (forUser !== pollUserId) return

    const firstPoll = !cursor
    cursor = json?.cursor ?? cursor
    // The first answer only sets the starting point; each screen loads its own
    // current state when it subscribes.
    if (firstPoll) return

    for (const row of json?.jobs || []) {
      const payload = { eventType: 'UPDATE', new: row }
      for (const handler of [...subscribers]) {
        try { handler(payload) } catch (e) { console.warn('[jobs] subscriber failed:', e?.message ?? e) }
      }
    }
  } catch (e) {
    if (!isSessionEnded(e)) console.warn('[jobs] could not check for changes:', e?.message ?? e)
  } finally {
    polling = false
  }
}

/**
 * Listen for changes to this user's jobs.
 *
 * @param {string} userId  the signed-in user; a different id starts over
 * @param {(payload: {eventType: string, new: object}) => void} handler
 * @returns {() => void} unsubscribe
 */
export function subscribe(userId, handler) {
  if (!userId) return () => {}

  if (userId !== pollUserId) {
    pollUserId = userId
    cursor = null
  }

  subscribers.add(handler)
  if (!timer) {
    pollOnce()
    timer = setInterval(pollOnce, POLL_INTERVAL_MS)
  }

  return () => {
    subscribers.delete(handler)
    if (!subscribers.size && timer) {
      clearInterval(timer)
      timer = null
      cursor = null
    }
  }
}
