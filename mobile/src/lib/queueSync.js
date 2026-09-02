/**
 * One shared refresh of the generation queue.
 *
 * Three things want to ask KIE how the running jobs are doing — the Queue
 * screen's own timer, its pull-to-refresh, and the app-wide poller that keeps
 * the tab badge honest. Letting them all call `refreshJobs` directly would
 * mean overlapping passes over the same taskIds, which is wasted requests
 * against a rate-limited API for no extra information.
 *
 * So they share one in-flight promise: whoever asks first starts the pass,
 * anyone asking while it runs gets handed the same promise and waits for it.
 */

import { listJobs, isActive } from '@core/jobQueue'
import { refreshJobs } from '@core/services/generation'

let inFlight = null

/**
 * Refresh every job KIE might still be working on.
 *
 * Resolves to the updated job rows. Never rejects — a refresh failing is not
 * something any caller can act on, and it must not take a screen down.
 */
export function syncActiveJobs() {
  if (inFlight) return inFlight

  const active = listJobs().filter(isActive)
  if (!active.length) return Promise.resolve([])

  inFlight = refreshJobs(active.map(j => j.taskId))
    .catch(e => {
      console.warn('[queueSync] refresh failed:', e?.message ?? e)
      return []
    })
    .finally(() => { inFlight = null })

  return inFlight
}
