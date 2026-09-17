/**
 * ─────────────────────────────────────────────────────────────────────────────
 * S3 — the object store behind every image and video.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The bucket is private. Block Public Access is on, there is no bucket policy
 * granting anonymous reads, and no object is served directly. Everything is
 * handed out as a presigned URL that expires in minutes, and only after the
 * caller's ownership has been checked against the `assets` table.
 *
 * ── Why keys are namespaced by user ──────────────────────────────────────────
 *
 *     users/<user-id>/<yyyy>/<mm>/<asset-id>.<ext>
 *
 * The user id in the path is not what enforces isolation — the database does
 * that. It is there so that access can ALSO be reasoned about at the bucket
 * level: an IAM policy can be scoped to a prefix, a lifecycle rule can target
 * one tenant, and an object found in a log is immediately attributable. The
 * asset-id filename means a key is never guessable from anything the user typed
 * and two uploads of the same photo never collide.
 *
 * Keys are generated here and never accepted from a client. A client-supplied
 * key is a path-traversal bug waiting to happen — `../` into another user's
 * prefix — and there is no reason to allow it.
 */

import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'

export const BUCKET = process.env.S3_BUCKET || ''
const REGION = process.env.AWS_REGION || 'us-east-1'

/** How long a download link lives. Long enough to load a page, short enough
 *  that a leaked URL is close to worthless. */
export const DOWNLOAD_TTL_SECONDS = 600

/**
 * How long a link handed to the GENERATOR lives.
 *
 * KIE fetches a task's inputs when the task starts, not when it is queued, and
 * a busy queue holds tasks for a long time — a ten-minute link could be dead
 * by then, failing a job that was already charged for. These links go only to
 * KIE, which is why the longer lifetime is acceptable.
 *
 * When signing with temporary credentials (an instance role rather than an IAM
 * user's keys), S3 also caps a presigned URL at those credentials' remaining
 * lifetime.
 */
export const GENERATION_TTL_SECONDS = 2 * 60 * 60

/** Uploads are a single PUT the client makes immediately. */
export const UPLOAD_TTL_SECONDS = 300

/** Refuse anything larger before signing, rather than discovering it after. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024

let _client = null
export function s3() {
  if (!BUCKET) throw new Error('S3_BUCKET is not set on the server.')
  if (!_client) {
    _client = new S3Client({
      region: REGION,
      // Only for S3-compatible storage other than AWS (MinIO, say) or a local
      // stand-in during tests. Unset, the SDK uses AWS's own endpoint.
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
      // Without this, SDK releases from 3.729 on sign a CRC32 checksum into every
      // presigned PUT — computed over an EMPTY body, because the bytes do not
      // exist when the URL is minted. S3 then rejects every real upload for not
      // matching it. Checksums are still sent where an operation requires one
      // (DeleteObjects), which is exactly what WHEN_REQUIRED means.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the
      // environment, or from the instance role when deployed somewhere that
      // provides one. Never from the request.
      credentials: process.env.AWS_ACCESS_KEY_ID
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
    })
  }
  return _client
}

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
}

/** Only these may be stored. An open content type is an invitation to host
 *  arbitrary files — including HTML, which is an XSS vector on the bucket's
 *  own domain if it is ever served directly. */
export const ALLOWED_CONTENT_TYPES = Object.keys(EXTENSIONS)

export function extensionFor(contentType) {
  return EXTENSIONS[contentType] || 'bin'
}

export function kindFor(contentType) {
  if (contentType?.startsWith('video/')) return 'video'
  if (contentType?.startsWith('audio/')) return 'audio'
  return 'image'
}

/**
 * Build the key for a new object. The asset id is generated here and returned
 * so the database row and the object agree.
 */
export function newKey({ userId, contentType }) {
  const assetId = randomUUID()
  const now = new Date()
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  return {
    assetId,
    key: `users/${userId}/${yyyy}/${mm}/${assetId}.${extensionFor(contentType)}`,
  }
}

/**
 * A PUT for exactly `byteSize` bytes.
 *
 * The length is signed into the URL, so S3 refuses an upload of any other size.
 * Without it the size a client declared when asking for the URL was only a
 * claim: declare one byte, send 5 GB, and the quota counted one byte.
 *
 * No `ServerSideEncryption` here. The presigner cannot move that header into
 * the query string, so it would become a header the app must send with exactly
 * this value — the app sends only Content-Type, and S3 would reject every
 * upload with SignatureDoesNotMatch. S3 encrypts every new object with
 * S3-managed keys (AES256) by default anyway.
 */
export function presignPut({ key, contentType, byteSize }) {
  return getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
      ContentLength: byteSize,
    }),
    { expiresIn: UPLOAD_TTL_SECONDS },
  )
}

export function presignGet({ key, downloadName, expiresIn = DOWNLOAD_TTL_SECONDS }) {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      // Lets the app offer a real filename on download without a second copy.
      ...(downloadName
        ? { ResponseContentDisposition: `attachment; filename="${downloadName.replace(/[^\w.\-]/g, '_')}"` }
        : {}),
    }),
    { expiresIn },
  )
}

export async function putObject({ key, body, contentType }) {
  await s3().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    ServerSideEncryption: 'AES256',
  }))
}

export async function deleteObject(key) {
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
}

/**
 * Bulk delete, used when an influencer or an account is removed. S3 caps a
 * batch at 1000, and reports per-key failures inside a successful response
 * rather than throwing — so they are checked here, or a sweep that deleted
 * nothing would look exactly like one that worked.
 */
export async function deleteObjects(keys) {
  const list = (keys || []).filter(Boolean)
  for (let i = 0; i < list.length; i += 1000) {
    const batch = list.slice(i, i + 1000)
    const result = await s3().send(new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true },
    }))
    if (result?.Errors?.length) {
      const first = result.Errors[0]
      throw new Error(`S3 could not delete ${result.Errors.length} object(s), e.g. ${first.Key}: ${first.Code}`)
    }
  }
}

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Delete every object under one user's prefix — for account deletion.
 *
 * Lists the bucket rather than trusting the assets table, so objects whose row
 * was never written go too. The id is validated and the prefix always ends in a
 * slash: an empty or malformed id must never widen this to `users/`, which is
 * every user's files.
 *
 * @returns {Promise<number>} how many objects were deleted
 */
export async function deleteUserObjects(userId) {
  if (!USER_ID_PATTERN.test(String(userId || ''))) {
    throw new Error('Refusing to sweep storage for a malformed user id.')
  }

  const Prefix = `users/${userId}/`
  let removed = 0
  let ContinuationToken

  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix, ContinuationToken }))
    const keys = (page?.Contents || []).map(o => o.Key).filter(k => k && k.startsWith(Prefix))
    if (keys.length) {
      await deleteObjects(keys)
      removed += keys.length
    }
    ContinuationToken = page?.IsTruncated ? page.NextContinuationToken : undefined
  } while (ContinuationToken)

  return removed
}
