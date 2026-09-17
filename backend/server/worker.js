/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The generation worker.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the reason to run a server rather than serverless functions.
 *
 * KIE is asynchronous: a task is created, and some minutes later a result
 * appears at a URL that expires 24 hours after that. Something has to be
 * watching. Until now that something was the phone — which means closing the
 * app stopped the watching, and a video that finished while the user was on the
 * bus sat uncollected until they happened to reopen the Queue tab. If they left
 * it a day, the result expired and the credits were spent for nothing.
 *
 * A serverless function cannot fix that; it only exists while a request is in
 * flight. A process can. This one watches every user's running jobs, collects
 * results into S3 as they land, and writes them into the gallery. The user opens
 * the app and the video is simply there.
 *
 * ── Why it holds the service-role key ────────────────────────────────────────
 *
 * It works on behalf of every user, so it cannot use a user's session and Row
 * Level Security does not apply to it. That makes it trusted code: every query
 * below carries the job's own `user_id` explicitly, and every file it writes
 * goes under that user's prefix. The safety net is off, so the care has to be
 * in the code.
 *
 * ── Pacing ───────────────────────────────────────────────────────────────────
 *
 * KIE allows 20 new generations per 10 seconds and answers 429 when pushed.
 * Polling is serial with a gap between calls, and a 429 backs the whole cycle
 * off rather than hammering. One worker for the whole deployment; running two
 * would double the request rate against that limit for no benefit.
 *
 * ── Who collects what ────────────────────────────────────────────────────────
 *
 * The app polls too, so it often notices a job finish first and marks it
 * 'success'. This worker used to look only at running jobs, so a job the app
 * had seen finish was never its concern — and if the user left the screen
 * before the app saved the result, nothing saved it. Each cycle now also
 * sweeps finished jobs nobody collected, after a grace period that leaves the
 * app time to finish the download it already started. Collection is idempotent
 * (api/_lib/results.js), so the two can never store or file a result twice.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { adminClient } from '../api/_lib/auth.js'
import { storeGeneratedResult, ResultError } from '../api/_lib/results.js'

const KIE_BASE = 'https://api.kie.ai'
const API_KEY = process.env.KIE_API_KEY || ''

/** How often to sweep for work. */
const CYCLE_MS = Number(process.env.WORKER_CYCLE_MS || 15_000)

/** Gap between individual KIE calls inside one cycle. */
const CALL_GAP_MS = 400

/** Most jobs to ask KIE about per cycle. */
const BATCH = 25

/**
 * How many running jobs are read to choose that batch from.
 *
 * Choosing only the 25 oldest meant 25 jobs that never resolve — stuck on
 * KIE's side, or rows a client inserted with made-up task ids — filled every
 * batch for six hours and nobody else's job was looked at. See pickFairBatch.
 */
const POOL = 500

/** A status call that has not answered by now is abandoned for this cycle. */
const STATUS_TIMEOUT_MS = 30_000

/** When each job was last asked about, by job id. Process memory is enough —
 *  a restart just means every job starts equal again. */
const lastChecked = new Map()

/** Give up on a job that has been running implausibly long. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000

const ACTIVE_STATES = ['waiting', 'queuing', 'generating']

/**
 * How long a finished, uncollected job is left to the app before the worker
 * takes it. A watching screen saves its result within seconds; three minutes
 * covers a slow video download without leaving results near their expiry.
 */
export const COLLECT_GRACE_MS = 3 * 60 * 1000

/** KIE's retention window. Past it there is nothing left to collect. */
const RESULT_TTL_MS = 24 * 60 * 60 * 1000

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Ask KIE about one task. Mirrors the client's normalisation exactly. */
async function fetchTaskStatus(taskId) {
  const res = await fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    // One hung connection must not stall every other user's jobs.
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  })

  if (res.status === 429) return { state: 'ratelimited' }
  if (!res.ok) return { state: 'unknown' }

  const json = await res.json().catch(() => null)
  if (!json || json.code === 429) return { state: json ? 'ratelimited' : 'unknown' }
  if (json.code !== 200) return { state: 'unknown' }

  const d = json.data || {}
  let resultUrls = []
  if (d.resultJson) {
    try { resultUrls = JSON.parse(d.resultJson).resultUrls || [] } catch {}
  }

  return {
    state: d.state || 'unknown',
    resultUrls,
    failMsg: d.failMsg || null,
    completeTime: d.completeTime || null,
  }
}

/**
 * Copy a finished result into the owner's storage and file it in the gallery.
 *
 * Everything here is keyed on `job.user_id` — the file lands under that user's
 * prefix, the asset belongs to them, the gallery entry is theirs. The worker
 * never infers an owner; it carries the one the job was created with.
 *
 * @returns {Promise<boolean>} whether the result is now stored
 */
export async function collect(db, job) {
  let stored
  try {
    stored = await storeGeneratedResult(db, {
      userId: job.user_id,
      influencerId: job.influencer_id,
      sourceUrl: job.result_url,
    })
  } catch (e) {
    if (!(e instanceof ResultError) || !e.permanent) throw e
    // Expired, unsupported or oversized will never succeed, so the job stops
    // here instead of being retried every cycle for the rest of the day.
    await db.from('generation_jobs')
      .update({
        state: 'fail',
        fail_msg: e.code === 'SOURCE_UNAVAILABLE' ? 'The result expired before it could be saved.' : e.message,
      })
      .eq('id', job.id)
    console.warn(`[worker] giving up on ${job.kie_task_id}: ${e.message}`)
    return false
  }

  // A job with no influencer came from the create wizard, before the record
  // existed. The asset is saved and reachable from the Queue; there is simply
  // no gallery to file it under.
  if (job.influencer_id) await fileInGallery(db, job, stored)

  console.log(`[worker] ${stored.reused ? 'already stored' : 'collected'} ${job.kie_task_id} → ${stored.assetId}`)
  return true
}

/** One gallery entry per asset, whichever collector got there first. */
async function fileInGallery(db, job, { assetId, kind }) {
  const { data: existing, error } = await db
    .from('generations')
    .select('id')
    .eq('user_id', job.user_id)
    .eq('asset_id', assetId)
    .limit(1)
  if (error) { console.warn('[worker] gallery check failed:', error.message); return }
  if (existing?.length) return

  const { error: genError } = await db.from('generations').insert({
    user_id: job.user_id,
    influencer_id: job.influencer_id,
    asset_id: assetId,
    kind: kind || job.kind || 'image',
    label: job.label || 'Generation',
  })
  // 23505: the screen filed it at the same moment (unique index, migration 0003).
  if (genError && genError.code !== '23505') console.warn('[worker] gallery entry failed:', genError.message)
}

/**
 * Choose this cycle's jobs: least recently checked first, taking one job from
 * each user in turn. A job that never resolves is checked, goes to the back,
 * and waits its turn — it can no longer hold a place in every batch — and an
 * account with many jobs cannot crowd out an account with one.
 *
 * @param {object[]} jobs  running jobs, oldest first
 * @param {Map<string, number>} checked  job id → when it was last asked about
 * @param {number} [size]
 */
export function pickFairBatch(jobs, checked, size = BATCH) {
  const ordered = [...jobs].sort((a, b) =>
    (checked.get(a.id) ?? 0) - (checked.get(b.id) ?? 0) ||
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

  const perUser = new Map()
  for (const job of ordered) {
    if (!perUser.has(job.user_id)) perUser.set(job.user_id, [])
    perUser.get(job.user_id).push(job)
  }

  const queues = [...perUser.values()]
  const picked = []
  while (picked.length < size && queues.some(q => q.length)) {
    for (const queue of queues) {
      if (picked.length >= size) break
      if (queue.length) picked.push(queue.shift())
    }
  }
  return picked
}

/**
 * Finished jobs nobody collected — usually ones the app saw finish and then
 * stopped watching. See "Who collects what" at the top of this file.
 */
export async function sweepUncollected(db, now = Date.now()) {
  const { data: jobs, error } = await db
    .from('generation_jobs')
    .select('id, user_id, influencer_id, kie_task_id, kind, label, state, result_url, updated_at')
    .eq('state', 'success')
    .is('asset_id', null)
    .not('result_url', 'is', null)
    .lt('updated_at', new Date(now - COLLECT_GRACE_MS).toISOString())
    .gt('updated_at', new Date(now - RESULT_TTL_MS).toISOString())
    .order('updated_at', { ascending: true })
    .limit(BATCH)

  if (error) { console.error('[worker] could not read uncollected jobs:', error.message); return }

  // No gap between these: collecting reads KIE's CDN, not its rate-limited API.
  for (const job of jobs || []) {
    try {
      await collect(db, job)
    } catch (e) {
      console.error(`[worker] collecting ${job.kie_task_id} failed:`, e?.message ?? e)
    }
  }
}

export async function cycle(db) {
  await sweepUncollected(db)

  const { data: jobs, error } = await db
    .from('generation_jobs')
    .select('id, user_id, influencer_id, kie_task_id, kind, label, state, result_url, created_at')
    .in('state', ACTIVE_STATES)
    .order('created_at', { ascending: true })
    .limit(POOL)

  if (error) { console.error('[worker] could not read jobs:', error.message); return }
  if (!jobs?.length) { lastChecked.clear(); return }

  // Stale jobs are failed across the whole pool, not only the batch, so a
  // backlog of dead ones is cleared in one pass instead of 25 at a time.
  const live = []
  for (const job of jobs) {
    if (Date.now() - new Date(job.created_at).getTime() > STALE_AFTER_MS) {
      await db.from('generation_jobs')
        .update({ state: 'fail', fail_msg: 'Timed out — the generator never reported a result.' })
        .eq('id', job.id)
      continue
    }
    live.push(job)
  }

  // Forget jobs that are no longer running, so the map cannot grow forever.
  const liveIds = new Set(live.map(j => j.id))
  for (const id of lastChecked.keys()) if (!liveIds.has(id)) lastChecked.delete(id)

  for (const job of pickFairBatch(live, lastChecked)) {
    lastChecked.set(job.id, Date.now())

    try {
      const status = await fetchTaskStatus(job.kie_task_id)

      if (status.state === 'ratelimited') {
        // Back off the whole cycle rather than the one job — the limit is per
        // account, so the next job would be rejected too.
        console.warn('[worker] rate limited; backing off')
        await sleep(10_000)
        return
      }
      if (status.state === 'unknown') continue

      if (status.state === 'fail') {
        await db.from('generation_jobs')
          .update({
            state: 'fail',
            fail_msg: status.failMsg || 'Generation failed.',
            completed_at: new Date().toISOString(),
          })
          .eq('id', job.id)
        continue
      }

      if (status.state === 'success' && status.resultUrls?.[0]) {
        // Compare-and-set: only whoever moves the row out of a running state
        // collects it here. If the app got there first it is already saving the
        // result, and the sweep takes over should it never finish.
        const { data: moved, error: moveError } = await db.from('generation_jobs')
          .update({
            state: 'success',
            result_url: status.resultUrls[0],
            completed_at: status.completeTime ? new Date(status.completeTime).toISOString() : new Date().toISOString(),
          })
          .eq('id', job.id)
          .in('state', ACTIVE_STATES)
          .select('id')

        if (moveError) throw moveError
        if (!moved?.length) continue

        await collect(db, { ...job, result_url: status.resultUrls[0] })
        continue
      }

      // Still working. Only write when the state actually moved, so a job that
      // sits in 'generating' for four minutes does not produce a database write
      // and a Realtime broadcast every fifteen seconds.
      if (status.state !== job.state) {
        await db.from('generation_jobs').update({ state: status.state }).eq('id', job.id)
      }
    } catch (e) {
      // One bad job must not stop the cycle — the next pass will retry it.
      console.error(`[worker] job ${job.kie_task_id} failed:`, e?.message ?? e)
    }

    await sleep(CALL_GAP_MS)
  }
}

async function main() {
  if (!API_KEY) {
    console.error('[worker] KIE_API_KEY is not set — nothing to poll with. Exiting.')
    process.exit(1)
  }

  const db = adminClient()
  console.log(`[worker] started; cycle ${CYCLE_MS}ms, batch ${BATCH}`)

  let running = true
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => { console.log(`[worker] ${signal} — stopping`); running = false })
  }

  while (running) {
    try {
      await cycle(db)
    } catch (e) {
      // Never let the loop die. A worker that exits silently looks exactly like
      // a worker with nothing to do.
      console.error('[worker] cycle failed:', e?.message ?? e)
    }
    await sleep(CYCLE_MS)
  }

  process.exit(0)
}

// Start the loop only when run as a process (node server/worker.js), so tests
// can import the functions above without it. Compared case-insensitively
// because Windows may report the same path with a different drive-letter case.
const entry = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : ''
if (entry && entry === fileURLToPath(import.meta.url).toLowerCase()) main()
