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
import { createPollPacer } from './pollPacer'
import { refreshCredits } from './billing'

/** KIE's own vocabulary for "still working". */
export const ACTIVE_STATES = ['waiting', 'queuing', 'generating']

/** KIE's retention window for a finished result. */
export const RESULT_TTL_MS = 24 * 60 * 60 * 1000

/** A job row from the server, as the app uses it. Rows from the change feed carry no `cursor`. */
export function toApp(row) {
  return {
    cursor: row.cursor ?? null,
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

/** Every job for the signed-in user, newest first — or, with `activeOnly`, just the ones still running. */
export async function listJobs({ limit = 60, activeOnly = false } = {}) {
  const { jobs } = await apiFetch(`/api/jobs?limit=${limit}${activeOnly ? '&active=1' : ''}`)
  return (jobs || []).map(toApp)
}

/** How many jobs the Queue shows per page. */
export const QUEUE_PAGE = 20

/**
 * One page of the Queue, newest first. Pass the previous page's `nextCursor` to
 * continue after it (core/data/paging.js).
 *
 * @param {object} [opts]
 * @param {string|null} [opts.cursor]
 * @param {boolean} [opts.summary]  also the account's totals — running, ready to save, the rest —
 *   which a screen holding one page cannot count for itself
 * @returns {Promise<{jobs: object[], hasMore: boolean, nextCursor: string|null,
 *   summary: {active: number, ready: number, settled: number}|null}>}
 */
export async function listJobsPage({ cursor = null, summary = false, limit = QUEUE_PAGE } = {}) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  if (summary) params.set('summary', '1')
  const json = await apiFetch(`/api/jobs?${params.toString()}`)
  return {
    jobs: (json?.jobs || []).map(toApp),
    hasMore: !!json?.hasMore,
    nextCursor: json?.nextCursor ?? null,
    summary: json?.summary ?? null,
  }
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
  nudgePolling()
  // A generation just started, and its price was taken: the balance has moved.
  refreshCredits()
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

/**
 * How often to ask is decided by pollPacer.js: quick while a job is running or
 * something has just happened, slow when nothing has, and not at all while the
 * app is in the background.
 */
const pacer = createPollPacer()

const subscribers = new Set()
let pollUserId = null
let cursor = null
let timer = null
let polling = false
let paused = false

async function pollOnce() {
  if (polling || paused || !subscribers.size) return
  polling = true
  const forUser = pollUserId
  try {
    const query = cursor ? `?since=${encodeURIComponent(cursor)}` : ''
    const json = await apiFetch(`/api/jobs/changes${query}`)
    // The user changed while the request was out: its answer belongs to nobody here.
    if (forUser !== pollUserId) return

    const rows = json?.jobs || []
    pacer.observe({ activeCount: json?.activeCount, changed: rows.length })
    // A job that failed gave its credits back; one that finished is settled. Either way the balance may have moved.
    if (rows.length && cursor) refreshCredits()

    const firstPoll = !cursor
    cursor = json?.cursor ?? cursor
    // The first answer only sets the starting point; each screen loads its own
    // current state when it subscribes.
    if (firstPoll) return

    for (const row of rows) {
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

function stopTimer() {
  if (timer) { clearTimeout(timer); timer = null }
}

/** Ask once more after the pacer's delay — a single pending timer at any moment. */
function scheduleNext() {
  stopTimer()
  if (!subscribers.size || paused) return
  timer = setTimeout(tick, pacer.delay())
}

async function tick() {
  timer = null
  await pollOnce()
  scheduleNext()
}

function pollNow() {
  stopTimer()
  tick()
}

/**
 * Something just started (a job was recorded, the app came to the front): ask at
 * once, and stay quick for a while. Safe to call with nobody listening.
 */
export function nudgePolling() {
  pacer.touch()
  if (subscribers.size && !paused) pollNow()
}

/**
 * The app went to the background (true) or came back (false). A backgrounded app
 * asks nothing; coming back is something that happened, so it asks at once.
 */
export function setPollingPaused(value) {
  const next = Boolean(value)
  if (next === paused) return
  paused = next
  if (paused) stopTimer()
  else nudgePolling()
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
  if (subscribers.size === 1) {
    pacer.touch()
    if (!paused) pollNow()
  }

  return () => {
    subscribers.delete(handler)
    if (!subscribers.size) {
      stopTimer()
      cursor = null
      pacer.reset()
    }
  }
}
