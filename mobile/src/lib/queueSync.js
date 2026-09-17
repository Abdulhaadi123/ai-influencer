/**
 * One shared pass over the running jobs.
 *
 * Something has to ask KIE whether a task has finished — Postgres cannot know
 * on its own, and there is no webhook we could receive without a public
 * endpoint. This is that something: it reads the active rows, asks KIE about
 * each, and writes the answers back. Every screen then learns about the change
 * through the Realtime subscription rather than by polling.
 *
 * Three callers want this — the Queue screen's timer, its pull-to-refresh, and
 * the app-wide sync that keeps the tab badge honest. They share one in-flight
 * promise so a burst produces a single pass; overlapping passes would be
 * duplicate requests against a rate-limited API for no extra information.
 */

import { listJobs, isActive } from '@core/data/jobs'
import { refreshJobs } from '@core/services/generation'

let inFlight = null

/**
 * Refresh every job KIE might still be working on.
 *
 * Never rejects. A failed refresh is not something any caller can act on, and
 * it must not take a screen down — the next pass will pick it up.
 *
 * @returns {Promise<Array>} the jobs whose state changed
 */
export function syncActiveJobs() {
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const active = (await listJobs()).filter(isActive)
      if (!active.length) return []
      return await refreshJobs(active.map(j => j.taskId))
    } catch (e) {
      console.warn('[queueSync] refresh failed:', e?.message ?? e)
      return []
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}
