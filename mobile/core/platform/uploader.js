/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Sending bytes to a presigned S3 URL — WEB.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Straightforward here: the browser has real Blob support, so a data: URL can
 * be turned into one and PUT directly at S3. The bytes never touch our API.
 *
 * The bucket must allow PUT from the app's origin in its CORS rules, or the
 * browser blocks this before the request is even sent. That configuration is
 * listed in the setup notes — it is the most common reason a first upload fails
 * on web while working fine on the phone.
 */

/**
 * The number of bytes an upload of `uri` will send — signed into the upload URL
 * by the server, so it has to be exact.
 *
 * @param {string} uri  data: URL, blob: URL, or object URL
 * @returns {Promise<number>}
 */
export async function getByteSize(uri) {
  return (await (await fetch(uri)).blob()).size
}

/**
 * @param {object} input
 * @param {string} input.uploadUrl   presigned PUT
 * @param {string} input.uri         data: URL, blob: URL, or object URL
 * @param {string} input.contentType must match what the URL was signed for
 */
export async function uploadToPresignedUrl({ uploadUrl, uri, contentType }) {
  // Works for data:, blob: and http(s): alike, and keeps the bytes out of a
  // JS string — atob would balloon a video into memory as a UTF-16 string.
  const blob = await (await fetch(uri)).blob()

  const res = await fetch(uploadUrl, {
    method: 'PUT',
    // S3 signs Content-Type into the signature; a mismatch here surfaces as an
    // opaque SignatureDoesNotMatch rather than anything about content types.
    headers: { 'Content-Type': contentType },
    body: blob,
  })

  if (!res.ok) {
    throw new Error(
      res.status === 0
        ? 'The storage bucket refused the request. Check its CORS configuration.'
        : `Upload rejected by storage (HTTP ${res.status}).`,
    )
  }
}
