/**
 * ─────────────────────────────────────────────────────────────────────────────
 * How long is the video a request carries — worked out here, from the file.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Some KIE models bill by the length of a clip the user supplies, not by anything the
 * request says: Kling Motion Control ignores a `duration` field entirely and charges for
 * the seconds of the driving video (measured live: a 4 s clip cost exactly 4 × the
 * per-second rate). So the price of such a request cannot come from the request — a
 * client that sends `duration: 1` with a 30 s video would pay for one second.
 *
 * The length is therefore measured on the server, on the bytes that will be sent:
 *
 *   • a link into this app's bucket is looked up (it must be the caller's own file),
 *     downloaded and read by ffprobe — the same hardened call moderation uses;
 *   • a link to KIE's own hosts is fetched (allow-listed, size-capped) and read;
 *   • anything else cannot be measured, so it cannot be priced.
 *
 * Nothing is cached: an upload's link can be written to until it is sealed, so a length
 * remembered from an earlier look could describe a different file by the time it is used.
 */

import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { one } from './db.js'
import { BUCKET, MAX_UPLOAD_BYTES, downloadObjectToFile, ObjectTooLargeError } from './s3.js'
import { fetchAllowedSource } from './results.js'
import { moderationConfig } from './moderation/config.js'
import { collectInputs, classifyMediaUrl } from './moderation/inputs.js'
import { videoSeconds, FramesUnavailableError, UnreadableMediaError } from './moderation/frames.js'
import { sniffMedia } from './moderation/sniff.js'

/** A video that cannot be priced. Carries what the endpoint should answer with. */
export class ClipError extends Error {
  constructor(status, code, message, cause) {
    super(message)
    this.name = 'ClipError'
    this.status = status
    this.code = code
    if (cause) this.cause = cause
  }
}

export const CLIP_MESSAGES = Object.freeze({
  unreadable: 'We could not read the length of your video, so it cannot be used. Please choose a different video.',
  unavailable: 'We could not check your video right now. Please try again in a moment.',
  tooLong: 'This video is too long. Please choose a shorter one.',
  notFound: 'One of the files you selected could not be found.',
})

/** Longer than this is not a clip anybody should be billed for by the second. */
export const MAX_CLIP_SECONDS = 600

/** The request field that holds a video: `video_urls`, `video_url`, `driving_video_url`… */
const VIDEO_FIELD = /video/i

/** Run `fn(file)` with a scratch path that is gone afterwards, whatever happens. */
async function withScratch(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-'))
  try { return await fn(path.join(dir, 'video')) } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

async function sniffFile(file) {
  const handle = await fs.open(file, 'r')
  try {
    const head = Buffer.alloc(32)
    const { bytesRead } = await handle.read(head, 0, 32, 0)
    return sniffMedia(head.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/** A downloaded file's length, once it is known to really be a video. */
async function secondsOfFile(file) {
  const sniffed = await sniffFile(file)
  if (sniffed?.kind !== 'video') throw new ClipError(400, 'CLIP_UNREADABLE', CLIP_MESSAGES.unreadable)
  let seconds
  try {
    seconds = await videoSeconds(file, { contentType: sniffed.contentType, config: moderationConfig() })
  } catch (e) {
    if (e instanceof FramesUnavailableError) throw new ClipError(503, 'CLIP_UNAVAILABLE', CLIP_MESSAGES.unavailable, e)
    if (e instanceof UnreadableMediaError) throw new ClipError(400, 'CLIP_UNREADABLE', CLIP_MESSAGES.unreadable, e)
    throw e
  }
  if (!(seconds > 0)) throw new ClipError(400, 'CLIP_UNREADABLE', CLIP_MESSAGES.unreadable)
  if (seconds > MAX_CLIP_SECONDS) throw new ClipError(400, 'CLIP_TOO_LONG', CLIP_MESSAGES.tooLong)
  return seconds
}

async function ownFileSeconds(user, key) {
  // Scoped to the caller: a link to someone else's file is simply not found.
  const asset = await one('select id from assets where user_id = $1 and s3_key = $2', [user.id, key])
  if (!asset) throw new ClipError(400, 'MEDIA_NOT_FOUND', CLIP_MESSAGES.notFound)

  return withScratch(async file => {
    try {
      await downloadObjectToFile({ key, file, maxBytes: MAX_UPLOAD_BYTES })
    } catch (e) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) throw new ClipError(400, 'MEDIA_NOT_FOUND', CLIP_MESSAGES.notFound, e)
      if (e instanceof ObjectTooLargeError) throw new ClipError(400, 'CLIP_UNREADABLE', CLIP_MESSAGES.unreadable, e)
      throw new ClipError(503, 'CLIP_UNAVAILABLE', CLIP_MESSAGES.unavailable, e)
    }
    return secondsOfFile(file)
  })
}

async function kieLinkSeconds(url) {
  return withScratch(async file => {
    try {
      const res = await fetchAllowedSource(url)
      if (!res.ok || !res.body) {
        await res.body?.cancel?.().catch(() => {})
        // A struggling host may recover; a missing or forbidden file never will.
        const transient = res.status === 429 || res.status >= 500
        throw transient
          ? new ClipError(503, 'CLIP_UNAVAILABLE', CLIP_MESSAGES.unavailable)
          : new ClipError(400, 'CLIP_UNREADABLE', CLIP_MESSAGES.unreadable)
      }
      if (Number(res.headers.get('content-length') || 0) > MAX_UPLOAD_BYTES) {
        await res.body?.cancel?.().catch(() => {})
        throw new ClipError(400, 'CLIP_UNREADABLE', CLIP_MESSAGES.unreadable)
      }
      let total = 0
      const cap = new Transform({
        transform(chunk, _enc, done) {
          total += chunk.length
          done(total > MAX_UPLOAD_BYTES ? new ClipError(400, 'CLIP_UNREADABLE', CLIP_MESSAGES.unreadable) : null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(res.body), cap, createWriteStream(file))
    } catch (e) {
      if (e instanceof ClipError) throw e
      // A redirect off KIE's hosts can never be measured; anything else (timeout, reset) may pass.
      if (e?.name === 'ResultError' && e.permanent) throw new ClipError(400, 'CLIP_UNREADABLE', CLIP_MESSAGES.unreadable, e)
      throw new ClipError(503, 'CLIP_UNAVAILABLE', CLIP_MESSAGES.unavailable, e)
    }
    return secondsOfFile(file)
  })
}

/**
 * The length of the video a createTask body names, in seconds (the longest, if it names
 * several), or null when it names none.
 *
 * @param {{user: {id: string}, payload: object}} args
 * @returns {Promise<number | null>}
 * @throws {ClipError}  a video is named and its length cannot be established
 */
export async function clipSecondsOf({ user, payload }) {
  const videos = collectInputs(payload).urls.filter(u => VIDEO_FIELD.test(u.key))
  if (!videos.length) return null

  const endpoint = process.env.S3_ENDPOINT || ''
  const unique = [...new Set(videos.map(v => v.url))]
  const lengths = await Promise.all(unique.map(url => {
    const where = classifyMediaUrl(url, { bucket: BUCKET, endpoint })
    if (where.kind === 'own') return ownFileSeconds(user, where.key)
    if (where.kind === 'kie') return kieLinkSeconds(url)
    throw new ClipError(400, 'MEDIA_NOT_ALLOWED', CLIP_MESSAGES.unreadable)
  }))
  return Math.max(...lengths)
}
