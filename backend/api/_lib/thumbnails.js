/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Small previews of images and videos, for the app's grids and lists.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The gallery used to draw each square from the full file: a 2K PNG of several megabytes for a
 * square a few hundred pixels wide, and for a video a real player that loaded part of the clip to
 * show one still frame. A preview is a JPEG beside the file — the picture scaled to THUMB_WIDTH
 * pixels wide, or a frame from the start of the clip — tens of kilobytes instead of megabytes.
 *
 * ── When one is made ─────────────────────────────────────────────────────────
 *
 *   • a generated result, as it is stored (results.js), from the bytes already in memory
 *   • an upload, once it is confirmed and sealed (storage/confirm.js), from storage
 *   • anything older or missed, by the worker (server/worker.js, sweepThumbnails)
 *
 * The first two happen after the answer has gone (thumbnailInBackground): nobody waits for a
 * preview, and a file without one is simply drawn from the full file, as before.
 *
 * ── Where it lives ───────────────────────────────────────────────────────────
 *
 * Beside the file, under the same user's prefix (`…/<asset-id>.thumb.jpg`), so deleting an account's
 * prefix takes the previews too. Its key is recorded in `assets.thumb_key`; every place that deletes
 * a file deletes that key with it. A preview is handed out only through the same ownership check as
 * the file (storage/download-url.js), and never for a file moderation blocked. Previews are not
 * counted against the storage quota: they are about one percent of the files they stand for.
 *
 * ── Running ffmpeg on files strangers sent ───────────────────────────────────
 *
 * The same rules as the moderation frames (moderation/frames.js): execFile with an argument array,
 * the input format forced from the declared type rather than guessed, `-protocol_whitelist file`,
 * a timeout on every call, and the temporary directory removed in a finally block.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { one, query } from './db.js'
import { putObject, deleteObject, downloadObjectToFile, ObjectTooLargeError, MAX_UPLOAD_BYTES } from './s3.js'
import { FramesUnavailableError, UnreadableMediaError } from './moderation/frames.js'

const run = promisify(execFile)

/** Wide enough for a gallery square on a large phone (about 500 physical pixels); never wider than the file. */
export const THUMB_WIDTH = 512

/** JPEG quality on ffmpeg's 2–31 scale (lower is better): about 85% — sharp, and tens of kilobytes. */
const JPEG_QUALITY = '4'

const CALL_TIMEOUT_MS = 30_000

/** Where in a clip the poster frame is taken: past a fade-in from black, before most clips have moved on. */
const POSTER_AT_SECONDS = '0.5'

/** The input format for each type a preview can be made from, forced rather than guessed, and its file name. */
const INPUTS = {
  'image/jpeg': { format: 'image2', ext: 'jpg' },
  'image/jpg': { format: 'image2', ext: 'jpg' },
  'image/png': { format: 'image2', ext: 'png' },
  'image/webp': { format: 'image2', ext: 'webp' },
  'video/mp4': { format: 'mov', ext: 'mp4' },
  'video/quicktime': { format: 'mov', ext: 'mov' },
  'video/webm': { format: 'matroska', ext: 'webm' },
}

export const canThumbnail = contentType => Object.hasOwn(INPUTS, contentType ?? '')

/** The preview's key, beside the file's: `users/u/2026/10/<id>.png` → `users/u/2026/10/<id>.thumb.jpg`. */
export function thumbKeyFor(key) {
  return `${String(key).replace(/\.[A-Za-z0-9]+$/, '')}.thumb.jpg`
}

/** Every object a file is made of — what deleting it has to delete. */
export const objectKeysOf = asset => [asset?.s3_key, asset?.thumb_key].filter(Boolean)

const ffmpegPath = () => process.env.FFMPEG_PATH || 'ffmpeg'

async function ffmpeg(args) {
  try {
    return await run(ffmpegPath(), args, { timeout: CALL_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true })
  } catch (e) {
    if (e?.code === 'ENOENT') throw new FramesUnavailableError('ffmpeg is not installed on this server.', e)
    throw new UnreadableMediaError('ffmpeg could not read this file.', e)
  }
}

const isJpeg = b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8

async function readJpeg(file) {
  try {
    if ((await stat(file)).size === 0) return null
    const bytes = await readFile(file)
    return isJpeg(bytes) ? bytes : null
  } catch {
    return null
  }
}

/**
 * A JPEG preview of a file on disk.
 *
 * @param {string} file  a local path the caller wrote; its name is the caller's, never a client's
 * @param {{contentType: string}} opts
 * @returns {Promise<Buffer>}
 * @throws {FramesUnavailableError} ffmpeg is not installed — a deployment problem, worth trying again later
 * @throws {UnreadableMediaError} the file is not an image or video ffmpeg can read — no preview, ever
 */
export async function renderThumbnail(file, { contentType }) {
  const input = INPUTS[contentType]
  if (!input) throw new UnreadableMediaError(`No preview can be made from "${contentType}".`)
  const isVideo = String(contentType).startsWith('video/')

  const dir = await mkdtemp(path.join(os.tmpdir(), 'thumb-'))
  try {
    const out = path.join(dir, 'thumb.jpg')
    const render = seek => ffmpeg([
      '-v', 'error', '-nostdin', '-y',
      '-f', input.format, ...(isVideo ? [] : ['-pattern_type', 'none']), '-protocol_whitelist', 'file',
      ...(seek ? ['-ss', seek] : []),
      '-i', file,
      '-frames:v', '1',
      // Never wider than THUMB_WIDTH, never enlarged, the height kept in proportion (and even).
      '-vf', `scale=w='min(${THUMB_WIDTH},iw)':h=-2`,
      '-q:v', JPEG_QUALITY,
      out,
    ])

    if (isVideo) {
      // A clip shorter than the poster moment yields no frame there; its first frame will do.
      await render(POSTER_AT_SECONDS).catch(e => { if (e instanceof FramesUnavailableError) throw e })
      const poster = await readJpeg(out)
      if (poster) return poster
    }
    await render(null)
    const jpeg = await readJpeg(out)
    if (!jpeg) throw new UnreadableMediaError('ffmpeg produced no picture from this file.')
    return jpeg
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** A failure that will not pass by itself: the file cannot have a preview, so it is not tried again. */
function isPermanent(e) {
  return e instanceof UnreadableMediaError
    || e instanceof ObjectTooLargeError
    || e?.name === 'NoSuchKey' || e?.Code === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404
}

/** Record that no preview can be made, so nothing asks again. Only while the file is still this one. */
async function markChecked(asset) {
  await query('update assets set thumb_checked_at = now() where id = $1 and s3_key = $2 and thumb_key is null', [asset.id, asset.s3_key])
}

/**
 * Make and store the preview of one file.
 *
 * @param {{id: string, s3_key: string, kind: string, content_type: string|null}} asset
 * @param {{bytes?: Buffer|null}} [opts]  the file's bytes when they are already in memory (a result
 *        being stored); otherwise they are read from storage
 * @returns {Promise<{status: 'made'|'none'|'gone', key?: string}>}
 *          made — stored and recorded; none — this file cannot have one (recorded, not tried again);
 *          gone — the file was deleted or replaced meanwhile (the preview, if written, is removed)
 * @throws for a failure that may pass (no ffmpeg, storage or database trouble): try again later
 */
export async function makeThumbnail(asset, { bytes = null } = {}) {
  if (!['image', 'video'].includes(asset.kind) || !canThumbnail(asset.content_type)) {
    await markChecked(asset)
    return { status: 'none' }
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'thumb-src-'))
  let jpeg
  try {
    const file = path.join(dir, `source.${INPUTS[asset.content_type].ext}`)
    if (bytes) await writeFile(file, bytes)
    else await downloadObjectToFile({ key: asset.s3_key, file, maxBytes: MAX_UPLOAD_BYTES })
    jpeg = await renderThumbnail(file, { contentType: asset.content_type })
  } catch (e) {
    if (!isPermanent(e)) throw e
    await markChecked(asset)
    return { status: 'none' }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  const key = thumbKeyFor(asset.s3_key)
  await putObject({ key, body: jpeg, contentType: 'image/jpeg' })

  // Recorded only while the row still points at the file it was made from. A file deleted or sealed
  // onto another key in the meantime would otherwise be given a preview of something else, or keep
  // an object no row knows about.
  const recorded = await one(
    'update assets set thumb_key = $2, thumb_checked_at = now() where id = $1 and s3_key = $3 returning id',
    [asset.id, key, asset.s3_key],
  )
  if (!recorded) {
    await deleteObject(key).catch(e => console.warn('[thumbnails] could not remove a preview of a file that is gone:', e?.message ?? e))
    return { status: 'gone' }
  }
  return { status: 'made', key }
}

/** Previews being made right now, so a test (or a shutdown) can wait for them. */
const pending = new Set()

/**
 * makeThumbnail, after the answer has gone. Never throws: a preview is a nicety, and a file without
 * one is drawn from the full file. A failure that may pass is left for the worker's sweep.
 */
export function thumbnailInBackground(asset, opts) {
  const work = makeThumbnail(asset, opts)
    .catch(e => console.warn(`[thumbnails] no preview for ${asset.id} yet (the worker will try again):`, e?.message ?? e))
    .finally(() => pending.delete(work))
  pending.add(work)
  return work
}

/** Resolves once every preview started so far has finished, one way or the other. */
export function thumbnailsSettled() {
  return Promise.allSettled([...pending])
}

/**
 * Files waiting for a preview, newest first — what the worker works through.
 *
 * An upload is taken only once it is final: confirmed and sealed, or older than any upload link
 * (one that was never confirmed has its last bytes by then, or none). A file moderation blocked is
 * never shown, so it needs no preview.
 */
export function listWithoutThumbnail({ limit, olderThanSeconds = 120 }) {
  return query(
    `select id, user_id, s3_key, kind, content_type from assets
      where thumb_key is null and thumb_checked_at is null and kind in ('image', 'video')
        and moderation_status <> 'blocked'
        and created_at < now() - $2::int * interval '1 second'
        and (origin <> 'upload' or sealed_at is not null or created_at < now() - interval '1 hour')
      order by created_at desc
      limit $1`,
    [limit, olderThanSeconds],
  ).then(r => r.rows)
}
