/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Where a long-running generation got to — for a screen still waiting on it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * When foreground polling stops watching (STILL_RUNNING) the job carries on,
 * and something else moves its queue row forward: the app-wide sync, or the
 * server's worker — which may already have collected the result by the time the
 * screen looks again. This answers the waiting screen's one question whichever
 * of those happened, and collects the result if nobody has yet. Collection is
 * idempotent on the server, so racing the worker cannot store it twice.
 */

import { getJobByTaskId, isCollectable, isExpired } from './data/jobs'
import { resolveUrl } from './data/assets'
import { persistGenerated } from './platform/persistMedia'

/**
 * @param {string} taskId
 * @param {object} [opts]
 * @param {'image'|'video'} [opts.kind]
 * @param {string|null} [opts.influencerId]
 * @returns {Promise<
 *   {status: 'waiting'} |
 *   {status: 'failed', message: string} |
 *   {status: 'ready', assetId: string, url: string|null}
 * >}
 */
export async function checkPendingResult(taskId, { kind = 'image', influencerId = null } = {}) {
  const job = await getJobByTaskId(taskId)
  if (!job) return { status: 'waiting' }

  if (job.state === 'fail') {
    return { status: 'failed', message: job.failMsg || 'The generation failed. Please try again.' }
  }
  if (isExpired(job)) {
    return { status: 'failed', message: 'This result finished more than a day ago and has expired.' }
  }

  let assetId = job.assetId
  if (!assetId && isCollectable(job)) {
    ({ assetId } = await persistGenerated({ sourceUrl: job.resultUrl, kind, influencerId }))
  }
  if (!assetId) return { status: 'waiting' }

  return { status: 'ready', assetId, url: await resolveUrl(assetId) }
}
