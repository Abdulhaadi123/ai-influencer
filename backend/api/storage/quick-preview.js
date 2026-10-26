/**
 * POST /api/storage/quick-preview  { sourceUrl, taskId? } → { url, kind: 'stored' | 'rendered' }
 *
 * A small picture of an image result the app has just been told is ready, so the screen that asked
 * for it can show it within a second or two.
 *
 * The app shows a finished image from KIE's own link while the server stores it. That link is the
 * full file — a 2K picture of several megabytes (a PNG was nearly 10 MB) — and on a phone connection
 * the preview frame sat empty for ten seconds or more before it appeared. The gallery showed the
 * same pictures at once, from their small previews (api/_lib/thumbnails.js), because those exist only
 * once a file is stored: too late for the screen that started the job.
 *
 * So this answers with the smallest thing that can stand in for the picture straight away:
 *
 *   • stored   — the result is already in this account's storage with its preview (KIE's callback
 *                usually gets there before the phone hears the job has finished): a signed link to
 *                that preview, exactly as /api/storage/download-url would give it;
 *   • rendered — not stored yet: the file is fetched from KIE (a data centre's link, a fraction of a
 *                second) and scaled down here, and the preview comes back in the answer as a data
 *                URL. Nothing is written; storing stays the job of /api/storage/ingest, which the app
 *                calls at the same moment.
 *
 * Only for a result of the caller's own: a file of theirs stored from this link, an image job of
 * theirs whose recorded result it is, or — when the job has not recorded it yet — the image job
 * `taskId` of theirs that KIE confirms it belongs to. Anything else is "not found", so this is not a way to fetch arbitrary files
 * from KIE's hosts through our server. The link is still checked against the same allow-list as
 * every other fetch of a result (results.js, the SSRF rule), on every redirect.
 *
 * Moderation: a stored file that moderation blocked gets nothing, as everywhere. A result not yet
 * stored has not been checked — but the app is already showing this very picture from KIE's link at
 * full size while it is checked (backend/README.md, "What it cannot do"); this is the same picture,
 * smaller and sooner, and no more.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { one } from '../_lib/db.js'
import { userRoute, badRequest, notFound, noStore, HttpError } from '../_lib/http.js'
import { presignGet, DOWNLOAD_TTL_SECONDS, MAX_UPLOAD_BYTES } from '../_lib/s3.js'
import { isAllowedResultSource, fetchAllowedSource } from '../_lib/results.js'
import { renderThumbnail, canThumbnail } from '../_lib/thumbnails.js'
import { fetchKieTaskStatus, applyKieStatus } from '../_lib/kieStatus.js'
import { FramesUnavailableError, UnreadableMediaError } from '../_lib/moderation/frames.js'

/** Someone is looking at an empty frame: a fetch that takes longer than this is no quicker than the file. */
const FETCH_TIMEOUT_MS = 20_000

/** The extensions renderThumbnail's input names use, for the images a result can be. */
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

const MAX_TASK_ID = 200
const taskIdFrom = value => (typeof value === 'string' && value && value.length <= MAX_TASK_ID ? value : null)

/**
 * Whether `sourceUrl` is the result of an image job of this account's.
 *
 * The job's row learns its result link from KIE's callback, the worker or a sync — and the phone can
 * hear "finished" from its own poll a moment before any of them. So when the row does not have the
 * link yet, a `taskId` of the caller's own image job settles it: KIE is asked about that task, the
 * answer is recorded on the job as any sync would record it, and the link must be one of its results.
 */
async function isYourResult(userId, sourceUrl, taskId) {
  const known = await one(
    `select 1 from generation_jobs where user_id = $1 and result_url = $2 and kind = 'image' limit 1`,
    [userId, sourceUrl],
  )
  if (known) return true
  if (!taskId) return false

  const job = await one(
    `select 1 from generation_jobs where user_id = $1 and kie_task_id = $2 and kind = 'image'`,
    [userId, taskId],
  )
  if (!job) return false
  const status = await fetchKieTaskStatus(taskId)
  if (status.state !== 'success' || !status.resultUrls.includes(sourceUrl)) return false
  await applyKieStatus({ userId, taskId, status }).catch(e =>
    console.warn('[storage/quick-preview] could not record the finished task:', e?.message ?? e))
  return true
}

export default userRoute(async (req, res, user) => {
  const sourceUrl = req.body?.sourceUrl
  if (typeof sourceUrl !== 'string' || !isAllowedResultSource(sourceUrl)) {
    throw badRequest('This source is not allowed.', 'BAD_SOURCE')
  }
  noStore(res)

  const stored = await one(
    `select thumb_key, moderation_status from assets where user_id = $1 and source_url = $2 limit 1`,
    [user.id, sourceUrl],
  )
  if (stored?.moderation_status === 'blocked') throw notFound('No preview is available for this result.', 'NO_PREVIEW')
  if (stored?.thumb_key) {
    return res.json({ url: await presignGet({ key: stored.thumb_key, expiresIn: DOWNLOAD_TTL_SECONDS }), kind: 'stored' })
  }

  if (!stored && !(await isYourResult(user.id, sourceUrl, taskIdFrom(req.body?.taskId)))) {
    throw notFound('No result of yours has this address.', 'NOT_FOUND')
  }

  const upstream = await fetchAllowedSource(sourceUrl, fetch, { timeoutMs: FETCH_TIMEOUT_MS })
  if (!upstream.ok) {
    await upstream.body?.cancel?.().catch(() => {})
    throw new HttpError(502, 'The result could not be fetched for a preview.', 'SOURCE_UNAVAILABLE')
  }
  const contentType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  const declared = Number(upstream.headers.get('content-length') || 0)
  if (!IMAGE_EXT[contentType] || !canThumbnail(contentType) || (declared && declared > MAX_UPLOAD_BYTES)) {
    await upstream.body?.cancel?.().catch(() => {})
    throw new HttpError(415, 'No quick preview is made for this kind of file.', 'UNSUPPORTED_TYPE')
  }
  const bytes = Buffer.from(await upstream.arrayBuffer())
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, 'This file is too large.', 'TOO_LARGE')

  const dir = await mkdtemp(path.join(os.tmpdir(), 'quick-preview-'))
  try {
    const file = path.join(dir, `source.${IMAGE_EXT[contentType]}`)
    await writeFile(file, bytes)
    const jpeg = await renderThumbnail(file, { contentType })
    res.json({ url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, kind: 'rendered' })
  } catch (e) {
    if (e instanceof FramesUnavailableError) throw new HttpError(503, 'Previews cannot be made on this server right now.', 'PREVIEW_UNAVAILABLE')
    if (e instanceof UnreadableMediaError) throw new HttpError(422, 'No preview can be made from this file.', 'UNREADABLE')
    throw e
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}, { tag: '[storage/quick-preview]', message: 'Unable to make a preview. Please try again.' })
