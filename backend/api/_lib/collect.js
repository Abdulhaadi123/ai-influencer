/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Collecting one finished job — shared by the worker and the webhook.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two things now learn that a job has finished: KIE's callback
 * (api/kie-callback.js), which arrives within seconds, and server/worker.js,
 * which polls and sweeps whatever the callback never delivered. Both end here,
 * so a result is stored and filed the same way whichever got there first.
 *
 * Collection is idempotent on (user, source URL) — see _lib/results.js — so the
 * two racing on the same job cannot store or file it twice.
 */

import { query } from './db.js'
import { storeGeneratedResult, ResultError } from './results.js'

/**
 * Copy a finished result into the owner's storage and file it in the gallery.
 *
 * @param {{id, user_id, influencer_id, kie_task_id, kind, label, result_url}} job
 * @param {string} [tag]  which collector is speaking, for the log
 * @returns {Promise<boolean>} whether the result is now stored
 */
export async function collect(job, tag = '[collect]') {
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
    console.warn(`${tag} giving up on ${job.kie_task_id}: ${e.message}`)
    return false
  }

  // A job with no influencer came from the create wizard, before the record
  // existed: the file is saved and reachable from the Queue, with no gallery to
  // file it in.
  if (job.influencer_id) await fileInGallery(job, stored, tag)

  console.log(`${tag} ${stored.reused ? 'already stored' : 'collected'} ${job.kie_task_id} → ${stored.assetId}`)
  return true
}

/** One gallery entry per file, whichever collector got there first. */
async function fileInGallery(job, { assetId, kind }, tag) {
  try {
    await query(
      `insert into generations (user_id, influencer_id, asset_id, kind, label)
       values ($1, $2, $3, $4, $5)
       on conflict (asset_id) do nothing`,
      [job.user_id, job.influencer_id, assetId, kind || job.kind || 'image', job.label || 'Generation'],
    )
  } catch (e) {
    console.warn(`${tag} gallery entry failed:`, e.message)
  }
}
