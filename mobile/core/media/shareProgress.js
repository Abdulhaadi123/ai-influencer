/**
 * What is said while a file is being got ready to share.
 *
 * Sharing needs the file on the phone, and a generated picture or clip is megabytes (a 2K PNG was nearly
 * 10 MB, a clip can be 30). Tapping Share used to start that download with nothing on screen at all: twenty
 * seconds of no sign anything had happened, so people tapped again. Now a small pill says it is working, with
 * the share of the file already here when the server announced its size.
 *
 * Pure, so the wording and the arithmetic are tested without a phone.
 */

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * How far along, as a whole number 0 to 99, or null when the size is not known (no Content-Length).
 * Never 100: that is only for when it is done, and by then the pill is gone.
 *
 * @param {{bytesWritten?: number, totalBytes?: number}|null|undefined} progress
 * @returns {number|null}
 */
export function progressPercent(progress) {
  const done = Number(progress?.bytesWritten)
  const total = Number(progress?.totalBytes)
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done < 0) return null
  return Math.min(99, Math.floor((done / total) * 100))
}

/**
 * The words for the pill.
 *   no numbers yet            "Preparing to share…"
 *   the size is known         "Preparing to share… 42%"
 *   only bytes so far         "Preparing to share… 3.1 MB"
 *
 * @param {{bytesWritten?: number, totalBytes?: number}|null|undefined} progress
 */
export function progressLabel(progress) {
  const percent = progressPercent(progress)
  if (percent !== null) return `Preparing to share… ${percent}%`
  const done = Number(progress?.bytesWritten)
  if (Number.isFinite(done) && done > 0) return `Preparing to share… ${formatBytes(done)}`
  return 'Preparing to share…'
}

/** How long a share may be under way before the pill is drawn: an instant one (a file already here) never flashes it. */
export const PILL_DELAY_MS = 350
