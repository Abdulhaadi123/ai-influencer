/**
 * Waiting for a file's small preview, for a screen that has just stored the file.
 *
 * The server makes a preview a second or two after it stores a file (backend api/_lib/thumbnails.js),
 * and often before the phone has even heard that the job finished, because KIE's callback reaches the
 * server first. A screen that shows the big picture (the create wizard, a regenerated main image, a
 * reference sheet) asks for the preview at once and then a few more times, quickly, so there is
 * something on screen while the full file is still coming down.
 *
 * Pure: the asking and the waiting are passed in, so the schedule can be tested without a network.
 */

/** When to ask, counted from the start: at once, then a little later each time. */
export const PREVIEW_WAIT_MS = Object.freeze([0, 700, 1500, 3000, 6000, 12000])

/**
 * @param {() => Promise<string|null>} ask       the preview's URL, or null when there is none yet
 * @param {{delays?: readonly number[], isCancelled?: () => boolean, sleep?: (ms: number) => Promise<void>}} [options]
 *        delays       moments to ask at, in milliseconds from the start, ascending
 *        isCancelled  checked before every ask; true stops the wait (the screen moved on)
 * @returns {Promise<string|null>} the preview's URL, or null when none came (or the wait was cancelled)
 */
export async function waitFor(ask, { delays = PREVIEW_WAIT_MS, isCancelled = () => false, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let elapsed = 0
  for (const at of delays) {
    if (at > elapsed) { await sleep(at - elapsed); elapsed = at }
    if (isCancelled()) return null
    let url = null
    try {
      url = await ask()
    } catch {
      // A failed ask is the same as "not yet": the next one may well work.
    }
    if (isCancelled()) return null
    if (url) return url
  }
  return null
}
