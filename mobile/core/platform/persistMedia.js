/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Persisting generated media — WEB implementation.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * KIE serves results from a TEMPORARY host (tempfile.aiquickdraw.com) and
 * deletes them within 24 hours to 3 days. Anything we store as a bare KIE URL
 * silently turns into a dead link, which is why generations appeared to "not
 * save" — the record was there, the file was gone.
 *
 * The native implementation downloads the file into the app's document
 * directory and returns a permanent local URI. The browser has no equivalent
 * writable location that survives cheaply, so on web this is a passthrough and
 * the expiry limitation remains.
 */

/**
 * @param {string} url       remote media URL
 * @param {string} filename  suggested filename
 * @returns {Promise<string>} a URI safe to store long-term
 */
export async function persistMedia(url /* , filename */) {
  return url
}

/** Build a stable, unique filename for a generated item. */
export function mediaFilename(kind, id, ext) {
  return `${kind}_${id}.${ext}`
}
