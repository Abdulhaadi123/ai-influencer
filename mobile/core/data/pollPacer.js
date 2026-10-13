/**
 * ─────────────────────────────────────────────────────────────────────────────
 * How often the app asks "what changed?" (jobs.js).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The poller used to ask every 5 seconds for as long as anyone was signed in — an
 * open app with nothing generating cost the server an authenticated request and
 * two queries twelve times a minute, forever, for an answer that was almost always
 * "nothing". Now it is quick (5 s) only while something is going on, and slow
 * (30 s) otherwise:
 *
 *   • quick while the server says a job is running (`activeCount`), and for a
 *     minute and a half after anything happened — a row changed, a job was just
 *     started, the app came back to the front. That tail covers the moments just
 *     after a job finishes, when its result is being stored and the last change
 *     arrives;
 *   • slow when nothing has happened for that long;
 *   • not at all while the app is in the background (jobs.js `setPollingPaused`);
 *     coming back to the front is itself something that happened, so it asks at once.
 *
 * Pure on purpose — no timers, no network — so the rules are easy to check.
 */

export const BUSY_INTERVAL_MS = 5_000
export const IDLE_INTERVAL_MS = 30_000
export const LINGER_MS = 90_000

/**
 * @param {{busyMs?: number, idleMs?: number, lingerMs?: number, now?: () => number}} [options]
 */
export function createPollPacer({ busyMs = BUSY_INTERVAL_MS, idleMs = IDLE_INTERVAL_MS, lingerMs = LINGER_MS, now = Date.now } = {}) {
  let busyUntil = 0

  return {
    /** Something is going on (a job was started, the app came forward): stay quick for a while. */
    touch() { busyUntil = now() + lingerMs },

    /** Fold in what the server just said: a running job or a changed row keeps it quick. */
    observe({ activeCount = 0, changed = 0 } = {}) {
      if (Number(activeCount) > 0 || Number(changed) > 0) busyUntil = now() + lingerMs
    },

    /** Milliseconds until the next ask. */
    delay() { return now() < busyUntil ? busyMs : idleMs },

    /** Start over (the last listener left, or another account signed in). */
    reset() { busyUntil = 0 },
  }
}
