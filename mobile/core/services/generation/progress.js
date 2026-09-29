/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Progress while a generation runs.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The bar used to move only when a RESULT landed. Everything before that —
 * uploading references, the task being accepted, minutes of queuing and
 * generating — was one number, so a single video sat at 30% for the whole
 * generation and then jumped to 100. The percentage carried no information
 * during the only part of the wait long enough to need one.
 *
 * KIE answers every poll with a state (waiting / queuing / generating) and, for
 * some models, a `progress` number. Both are used here:
 *
 *   • a model that reports progress drives the bar directly;
 *   • a model that does not creeps toward the top of its band on elapsed time,
 *     asymptotically — so the bar always moves, and never reaches the end
 *     before the result does.
 *
 * Reported values are MONOTONIC. KIE can answer 'queuing' after 'generating'
 * when a task is requeued, and a bar that jumps backwards reads as a bug.
 *
 * Pure: no platform APIs, no imports. Kept out of the provider so it can be
 * tested on its own.
 */

const STATE_FRACTION = { waiting: 0.08, queuing: 0.18, generating: 0.35 }

/** Approaches the top of the band, halving what is left roughly every 75s. */
const CREEP_MS = 75_000

/** The ceiling a job with no reported number may creep to. */
const CREEP_CEILING = 0.95

/**
 * How far through its own band one job is, 0..1.
 *
 * @param {{state?: string, progress?: number}} status  a normalised KIE answer
 * @param {number} elapsedMs  since polling began
 */
export function stageFraction(status, elapsedMs) {
  if (status?.state === 'success') return 1
  const base = STATE_FRACTION[status?.state] ?? 0.05
  const reported = Number(status?.progress)
  if (Number.isFinite(reported) && reported > 0) {
    return Math.max(base, Math.min(0.97, reported / 100))
  }
  if (status?.state !== 'generating') return base
  return Math.min(CREEP_CEILING, base + (CREEP_CEILING - base) * (1 - Math.exp(-elapsedMs / CREEP_MS)))
}

/**
 * A monotonic reporter for `total` jobs sharing the band `from`..`to`.
 *
 * @param {((pct: number) => void) | undefined} onProgress
 * @param {number} total  how many jobs share the band
 * @param {number} from   the percentage already reported before polling began
 * @param {number} to     the percentage polling may reach (never 100 — the
 *                        caller reports that once the result is in hand)
 * @param {() => number} [now]  injectable clock, for tests
 */
export function createProgress(onProgress, total, from, to, now = Date.now) {
  const startedAt = now()
  const fractions = new Map()
  let highest = from

  return {
    /** Fold one job's latest answer in and report the total if it moved up. */
    update(taskId, status) {
      fractions.set(taskId, stageFraction(status, now() - startedAt))
      const done = [...fractions.values()].reduce((a, b) => a + b, 0)
      const pct = from + (to - from) * Math.min(1, done / Math.max(1, total))
      if (pct > highest) {
        highest = pct
        onProgress?.(Math.round(pct))
      }
    },
    /** What was last reported — for assertions and for callers that resume. */
    get reported() { return Math.round(highest) },
  }
}
