/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Sending bytes to a presigned S3 URL — REACT NATIVE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Uploads go straight from the device to S3. Our API only ever mints the URL;
 * it never carries the file. A 60 MB driving video would not fit through a
 * serverless function comfortably, and routing it through one would double the
 * transfer for no benefit.
 *
 * ── Why not just fetch(uri) and PUT the blob ─────────────────────────────────
 *
 * React Native's fetch does not read a file:// URI into a Blob reliably, and
 * passing a Uint8Array as a body is not supported across both engines. The
 * dependable path is expo-file-system's uploadAsync, which streams the file
 * natively — it also avoids holding the whole file in JS memory, which a
 * base64 round trip would (and at 4/3 the size).
 *
 * A data: URL is written to a cache file first so the same streaming path can
 * be used for both cases.
 */

import { uploadAsync, FileSystemUploadType } from 'expo-file-system/legacy'
import { File, Paths } from 'expo-file-system'

import { AppError, NETWORK_MESSAGE, ERROR_CODES } from '../errors'

function extensionFor(contentType) {
  if (!contentType) return 'bin'
  if (contentType.includes('png')) return 'png'
  if (contentType.includes('webp')) return 'webp'
  if (contentType.includes('quicktime')) return 'mov'
  if (contentType.includes('mp4')) return 'mp4'
  if (contentType.includes('webm')) return 'webm'
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg'
  return 'bin'
}

/**
 * Materialise a data: URL as a file so it can be streamed like any other.
 * @returns {File} a cache file the caller must delete
 */
function base64Of(dataUrl) {
  const comma = dataUrl.indexOf(',')
  if (comma === -1) throw new Error('Malformed data URL')
  // Whitespace is not data; stripped here so the size measured below and the
  // bytes written match exactly — S3 refuses an upload one byte off.
  return dataUrl.slice(comma + 1).replace(/\s/g, '')
}

/**
 * The number of bytes an upload of `uri` will send.
 *
 * The server signs this into the upload URL, so it must be exact: a data URL is
 * measured from its base64 length, a file from the file system.
 *
 * @param {string} uri  data: URL or file:// URI
 * @returns {Promise<number>}
 */
export async function getByteSize(uri) {
  if (uri.startsWith('data:')) {
    const base64 = base64Of(uri)
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    return Math.floor((base64.length * 3) / 4) - padding
  }
  const size = new File(uri).size
  if (!Number.isFinite(size) || size <= 0) {
    throw new AppError('That file could not be read. Try choosing it again.')
  }
  return size
}

function writeTempFromDataUrl(dataUrl, contentType) {
  const base64 = base64Of(dataUrl)

  const file = new File(Paths.cache, `upload_${Date.now()}.${extensionFor(contentType)}`)
  if (file.exists) file.delete()
  file.create()
  file.write(base64, { encoding: 'base64' })
  return file
}

/**
 * @param {object} input
 * @param {string} input.uploadUrl   presigned PUT
 * @param {string} input.uri         data: URL or file:// URI
 * @param {string} input.contentType must match what the URL was signed for, or
 *                                   S3 rejects the request with a signature error
 */
export async function uploadToPresignedUrl({ uploadUrl, uri, contentType }) {
  let temp = null
  let fileUri = uri

  try {
    if (uri.startsWith('data:')) {
      temp = writeTempFromDataUrl(uri, contentType)
      fileUri = temp.uri
    }

    let result
    try {
      result = await uploadAsync(uploadUrl, fileUri, {
        httpMethod: 'PUT',
        uploadType: FileSystemUploadType.BINARY_CONTENT,
        // S3 signs the Content-Type into the signature. Sending a different one
        // here fails with an opaque SignatureDoesNotMatch, so this must be the
        // exact value the presign used.
        headers: { 'Content-Type': contentType },
      })
    } catch (e) {
      // A native exception here is the transfer failing, not a refusal.
      console.warn('[upload] transfer failed:', e?.message ?? e)
      throw new AppError(NETWORK_MESSAGE, { code: ERROR_CODES.NETWORK, cause: e })
    }

    if (result.status < 200 || result.status >= 300) {
      console.warn('[upload] storage refused the file:', result.status, String(result.body || '').slice(0, 200))
      // 403 from a presigned PUT is almost always the link expiring (it lives
      // five minutes) while a large file was still being picked or sent.
      throw new AppError(
        result.status === 403
          ? 'The upload took too long and its link expired. Please try again.'
          : 'Storage did not accept the file. Please try again.',
        { status: result.status },
      )
    }
  } finally {
    if (temp) { try { temp.delete() } catch { /* cache file; the OS will reap it */ } }
  }
}
