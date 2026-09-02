/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The generation queue — every job this device has started, and where it got to.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * KIE is asynchronous: createTask returns a taskId immediately and the work
 * happens on their side, for anywhere from twenty seconds to many minutes. The
 * app used to hold that entirely in screen state — poll in a loop, and if the
 * loop ran out of rounds, throw. Three things fell out of that:
 *
 *   • A slow job was reported as a FAILURE. The video poll gave up at ~9
 *     minutes with "Video generation failed", when in fact KIE was still
 *     working and the credits were already spent.
 *   • Leaving the screen, backgrounding the app, or a reload lost the taskId,
 *     so a finished job could never be collected.
 *   • Only one generation could be watched at a time, because the only place a
 *     job existed was the screen that started it.
 *
 * The taskId is the durable handle KIE gives us, so it is what gets persisted.
 * A job survives navigation, backgrounding and restarts, and the Queue screen
 * can pick any of them back up with a plain recordInfo call.
 *
 * ── Why the results are downloaded on sight ──────────────────────────────────
 *
 * KIE deletes result URLs 24 hours after completion (their docs are explicit).
 * A queue that only stored the URL would hand back dead links to anyone who
 * left a job overnight, which is the same class of bug persistMedia already
 * exists to prevent. So a completed job is only "done" once its bytes are on
 * the device; until then it is "ready to collect", and past 24 hours it is
 * marked expired rather than pretending it can still be fetched.
 *
 * ── Why there is no server-side list ─────────────────────────────────────────
 *
 * KIE has no "list my tasks" endpoint — task history exists only in their web
 * dashboard. recordInfo takes exactly one taskId. So the local record is not a
 * cache of remote state we could rebuild; it is the ONLY index we have. Losing
 * it loses the job. That is why every launch path writes here before it starts
 * polling, rather than on success.
 */

import * as storage from './platform/storage'

const KEY = 'generation_queue_v1'

/** KIE's own retention window for a finished result. */
export const RESULT_TTL_MS = 24 * 60 * 60 * 1000

/** Plenty of history without letting a synchronous store grow unbounded. */
const MAX_JOBS = 60

/** The three states that mean KIE still has work to do. */
export const ACTIVE_STATES = ['waiting', 'queuing', 'generating']

export function isActive(job) {
  return ACTIVE_STATES.includes(job?.state)
}

/** Finished on KIE's side, bytes not yet on this device. */
export function isCollectable(job) {
  return job?.state === 'success' && !job?.savedUrl && !isExpired(job)
}

/** Completed, never collected, and past the point where KIE still serves it. */
export function isExpired(job) {
  if (job?.state !== 'success' || job?.savedUrl) return false
  return Date.now() - (job.completedAt || job.updatedAt || job.createdAt || 0) > RESULT_TTL_MS
}

function read() {
  try {
    const raw = JSON.parse(storage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function write(jobs) {
  try {
    // Active jobs are never dropped by the cap — losing one would strand a
    // task that is still running and still costing credits. Finished rows are
    // sorted BEFORE the cap is applied, so what gets trimmed is the oldest
    // history rather than whatever happened to be last in the array.
    const active = jobs.filter(isActive)
    const rest = jobs
      .filter(j => !isActive(j))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, Math.max(0, MAX_JOBS - active.length))
    storage.setItem(KEY, JSON.stringify(
      [...active, ...rest].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    ))
  } catch (e) {
    console.warn('[jobQueue] could not persist:', e?.message ?? e)
  }
}

export function listJobs() {
  return read().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

export function getJob(id) {
  return read().find(j => j.id === id) || null
}

export function getJobByTaskId(taskId) {
  return read().find(j => j.taskId === taskId) || null
}

/**
 * Register jobs the moment their taskIds exist — before any polling starts, so
 * an app kill one second later still leaves a recoverable record.
 *
 * @param {Array<{taskId:string, kind:string, influencerId?:string,
 *                influencerName?:string, label?:string, model?:string}>} entries
 * @returns {string[]} the local job ids, in the same order
 */
export function registerJobs(entries) {
  const now = Date.now()
  const jobs = read()
  const created = []

  for (const e of entries) {
    if (!e?.taskId) continue
    // A retry of the same task must not create a second row.
    const existing = jobs.find(j => j.taskId === e.taskId)
    if (existing) { created.push(existing.id); continue }

    const job = {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      taskId: e.taskId,
      kind: e.kind || 'image',
      influencerId: e.influencerId || null,
      influencerName: e.influencerName || '',
      label: e.label || 'Generation',
      model: e.model || '',
      createdAt: now,
      updatedAt: now,
      state: 'waiting',
      resultUrl: null,
      savedUrl: null,
      completedAt: null,
      failMsg: null,
    }
    jobs.push(job)
    created.push(job.id)
  }

  write(jobs)
  return created
}

export function updateJob(id, patch) {
  const jobs = read()
  const i = jobs.findIndex(j => j.id === id)
  if (i === -1) return null
  jobs[i] = { ...jobs[i], ...patch, updatedAt: Date.now() }
  write(jobs)
  return jobs[i]
}

/**
 * Fold a recordInfo result into whichever job owns that taskId.
 *
 * Returns early when nothing has actually changed. The foreground poll loops
 * every 2–3 seconds for up to ten minutes, and storage here is synchronous
 * SQLite — re-serialising the whole queue on every tick just to rewrite the
 * same "generating" would put hundreds of pointless writes on the JS thread
 * during the exact window the user is watching a progress bar.
 */
export function applyStatus(taskId, status) {
  const jobs = read()
  const i = jobs.findIndex(j => j.taskId === taskId)
  if (i === -1) return null

  const prev = jobs[i]
  const settled = status.state === 'success' || status.state === 'fail'
  if (prev.state === status.state && !settled) return prev

  const patch = { state: status.state, updatedAt: Date.now() }
  if (status.state === 'success') {
    patch.resultUrl = status.resultUrls?.[0] || jobs[i].resultUrl
    patch.completedAt = status.completeTime || Date.now()
  }
  if (status.state === 'fail') {
    patch.failMsg = status.failMsg || 'Generation failed'
    patch.completedAt = status.completeTime || Date.now()
  }

  jobs[i] = { ...jobs[i], ...patch }
  write(jobs)
  return jobs[i]
}

/**
 * Mark a job's bytes as safely on the device. Called both by the screen that
 * started it (when the user stayed and watched) and by the Queue screen (when
 * they did not), so a result is never written to history twice.
 */
export function markSaved(taskId, savedUrl) {
  const jobs = read()
  const i = jobs.findIndex(j => j.taskId === taskId)
  if (i === -1) return null
  jobs[i] = { ...jobs[i], state: 'success', savedUrl, updatedAt: Date.now(), completedAt: jobs[i].completedAt || Date.now() }
  write(jobs)
  return jobs[i]
}

/**
 * Same as markSaved, keyed on the KIE result URL instead of the taskId.
 *
 * The studio screens receive result URLs from the generation layer but never
 * see the taskIds behind them, and widening those return shapes would ripple
 * into the web app, which imports the very same functions. Matching on the
 * URL that polling already recorded keeps the change on this side of the line.
 */
export function markSavedByResultUrl(resultUrl, savedUrl) {
  if (!resultUrl) return null
  const job = read().find(j => j.resultUrl === resultUrl)
  return job ? markSaved(job.taskId, savedUrl) : null
}

export function removeJob(id) {
  write(read().filter(j => j.id !== id))
}

/** Clear everything that is finished with — keeps anything still running. */
export function clearSettled() {
  write(read().filter(isActive))
}

export function countActive() {
  return read().filter(isActive).length
}
