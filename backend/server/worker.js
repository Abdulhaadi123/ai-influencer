/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The generation worker.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * KIE is asynchronous: a task is created, and some minutes later a result
 * appears at a URL that expires 24 hours after that. Something has to be
 * watching. Without this process the phone is the only thing watching — so
 * closing the app stops it, and a result left a day is lost with the credits
 * spent on it. This process watches every user's running jobs, collects results
 * into S3 as they land, and files them in the gallery. The user opens the app
 * and the video is simply there.
 *
 * ── Trusted code ─────────────────────────────────────────────────────────────
 *
 * It works on behalf of every user, so every query below carries the job's own
 * `user_id`, and every file goes under that user's prefix. It never infers an
 * owner; it carries the one the job was created with.
 *
 * ── Pacing ───────────────────────────────────────────────────────────────────
 *
 * KIE allows 20 new generations per 10 seconds and answers 429 when pushed.
 * Polling is serial with a gap between calls, and a 429 backs the whole cycle
 * off. Run exactly ONE worker; two would double the rate against that limit.
 *
 * ── Who collects what ────────────────────────────────────────────────────────
 *
 * The app polls too, so it often sees a job finish first. Each cycle therefore
 * also sweeps finished jobs nobody collected, after a grace period that leaves
 * the app time to finish the download it already started. Collection is
 * idempotent (api/_lib/results.js), so the two can never store or file a result
 * twice.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { many, query, closeDb } from '../api/_lib/db.js'
import { storeGeneratedResult, ResultError } from '../api/_lib/results.js'
import { fetchKieTaskStatus, applyKieStatus, ACTIVE_STATES } from '../api/_lib/kieStatus.js'

/** How often to sweep for work. */
const CYCLE_MS = Number(process.env.WORKER_CYCLE_MS || 15_000)

/** Gap between individual KIE calls inside one cycle. */
const CALL_GAP_MS = 400

/** Most jobs to ask KIE about per cycle. */
const BATCH = 25

/**
 * How many running jobs are read to choose that batch from.
 *
 * Choosing only the 25 oldest meant 25 jobs that never resolve — stuck on KIE's
 * side, or made-up task ids — filled every batch for six hours and nobody
 * else's job was looked at. See pickFairBatch.
 */
const POOL = 500

/** Give up on a job that has been running implausibly long. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * How long a finished, uncollected job is left to the app before the worker
 * takes it. A watching screen saves its result within seconds; three minutes
 * covers a slow video download without leaving results near their expiry.
 */
export const COLLECT_GRACE_MS = 3 * 60 * 1000

/** KIE's retention window. Past it there is nothing left to collect. */
const RESULT_TTL_MS = 24 * 60 * 60 * 1000

/** When each job was last asked about, by job id. A restart just evens them out. */
const lastChecked = new Map()

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Copy a finished result into the owner's storage and file it in the gallery.
 * @returns {Promise<boolean>} whether the result is now stored
 */
export async function collect(job) {
  let stored
  try {
    stored = await storeGeneratedResult({
      userId: job.user_id,
      influencerId: job.influencer_id,
      sourceUrl: job.result_url,
    })
  } catch (e) {
    if (!(e instanceof ResultError) || !e.permanent) throw e
    // Expired, unsupported or oversized will never succeed, so the job stops
    // here instead of being retried every cycle for the rest of the day.
    await query(
      `update generation_jobs set state = 'fail', fail_msg = $3 where id = $1 and user_id = $2`,
      [job.id, job.user_id, e.code === 'SOURCE_UNAVAILABLE' ? 'The result expired before it could be saved.' : e.message],
    )
    console.warn(`[worker] giving up on ${job.kie_task_id}: ${e.message}`)
    return false
  }

  // A job with no influencer came from the create wizard, before the record
  // existed: the file is saved and reachable from the Queue, with no gallery to
  // file it in.
  if (job.influencer_id) await fileInGallery(job, stored)

  console.log(`[worker] ${stored.reused ? 'already stored' : 'collected'} ${job.kie_task_id} → ${stored.assetId}`)
  return true
}

/** One gallery entry per file, whichever collector got there first. */
async function fileInGallery(job, { assetId, kind }) {
  try {
    await query(
      `insert into generations (user_id, influencer_id, asset_id, kind, label)
       values ($1, $2, $3, $4, $5)
       on conflict (asset_id) do nothing`,
      [job.user_id, job.influencer_id, assetId, kind || job.kind || 'image', job.label || 'Generation'],
    )
  } catch (e) {
    console.warn('[worker] gallery entry failed:', e.message)
  }
}

/**
 * Choose this cycle's jobs: least recently checked first, taking one job from
 * each user in turn. A job that never resolves is checked, goes to the back,
 * and waits its turn; an account with many jobs cannot crowd out one with few.
 *
 * @param {object[]} jobs  running jobs, oldest first
 * @param {Map<string, number>} checked  job id → when it was last asked about
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

/** Finished jobs nobody collected — usually ones the app saw finish and then stopped watching. */
export async function sweepUncollected(now = Date.now()) {
  let jobs
  try {
    jobs = await many(
      `select id, user_id, influencer_id, kie_task_id, kind, label, state, result_url, updated_at
         from generation_jobs
        where state = 'success' and asset_id is null and result_url is not null
          and updated_at < $1 and updated_at > $2
        order by updated_at asc
        limit $3`,
      [new Date(now - COLLECT_GRACE_MS), new Date(now - RESULT_TTL_MS), BATCH],
    )
  } catch (e) {
    console.error('[worker] could not read uncollected jobs:', e.message)
    return
  }

  // No gap between these: collecting reads KIE's CDN, not its rate-limited API.
  for (const job of jobs) {
    try {
      await collect(job)
    } catch (e) {
      console.error(`[worker] collecting ${job.kie_task_id} failed:`, e?.message ?? e)
    }
  }
}

export async function cycle() {
  await sweepUncollected()

  const jobs = await many(
    `select id, user_id, influencer_id, kie_task_id, kind, label, state, result_url, created_at
       from generation_jobs
      where state = any($1::text[])
      order by created_at asc
      limit $2`,
    [ACTIVE_STATES, POOL],
  )
  if (!jobs.length) { lastChecked.clear(); return }

  // Stale jobs are failed across the whole pool, not only the batch, so a
  // backlog of dead ones clears in one pass instead of 25 at a time.
  const live = []
  for (const job of jobs) {
    if (Date.now() - new Date(job.created_at).getTime() > STALE_AFTER_MS) {
      await query(
        `update generation_jobs set state = 'fail', fail_msg = 'Timed out — the generator never reported a result.'
          where id = $1 and state = any($2::text[])`,
        [job.id, ACTIVE_STATES],
      )
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
      const status = await fetchKieTaskStatus(job.kie_task_id)

      if (status.state === 'ratelimited') {
        // Back off the whole cycle — the limit is per account, so the next job
        // would be refused too.
        console.warn('[worker] rate limited; backing off')
        await sleep(10_000)
        return
      }

      if (status.state !== 'unknown') {
        const { job: updated, settledNow } = await applyKieStatus({ userId: job.user_id, taskId: job.kie_task_id, status })
        // Only the collector whose write settled the job collects it here. If a
        // screen got there first it is already saving the result, and the sweep
        // takes over should it never finish.
        if (settledNow && updated?.state === 'success' && updated.result_url) {
          await collect({ ...job, result_url: updated.result_url })
        }
      }
    } catch (e) {
      // One bad job must not stop the cycle — the next pass retries it.
      console.error(`[worker] job ${job.kie_task_id} failed:`, e?.message ?? e)
    }

    await sleep(CALL_GAP_MS)
  }
}

async function main() {
  if (!process.env.KIE_API_KEY) {
    console.error('[worker] KIE_API_KEY is not set — nothing to poll with. Exiting.')
    process.exit(1)
  }

  console.log(`[worker] started; cycle ${CYCLE_MS}ms, batch ${BATCH}`)

  let running = true
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => { console.log(`[worker] ${signal} — stopping`); running = false })
  }

  while (running) {
    try {
      await cycle()
    } catch (e) {
      // Never let the loop die. A worker that exits silently looks exactly like
      // a worker with nothing to do. (Before the API has created the tables,
      // this is where "relation does not exist" lands, and the next cycle
      // simply tries again.)
      console.error('[worker] cycle failed:', e?.message ?? e)
    }
    await sleep(CYCLE_MS)
  }

  await closeDb()
  process.exit(0)
}

// Start the loop only when run as a process (node server/worker.js), so tests
// can import the functions above. Compared case-insensitively because Windows
// may report the same path with a different drive-letter case.
const entry = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : ''
if (entry && entry === fileURLToPath(import.meta.url).toLowerCase()) main()
