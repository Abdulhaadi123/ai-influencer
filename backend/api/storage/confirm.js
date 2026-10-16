/**
 * POST /api/storage/confirm  { assetId } → { assetId, byteSize }
 *
 * Called after a direct-to-S3 upload finishes, to stamp the asset row with the
 * size S3 actually holds. The signed length makes a mismatch impossible through
 * the app's own upload URLs; the check stays because the cost of being wrong is
 * unbounded storage.
 *
 * An asset that is never confirmed keeps the size it was signed for. It is not
 * an error, just an upload that did not finish.
 *
 * ── Confirming also seals ────────────────────────────────────────────────────
 *
 * The upload link outlives the upload: it can be used again for half an hour, so the
 * file could be replaced after it had been checked. Here the file is copied, inside S3,
 * to a key no link names, and the asset points at the copy (moderation/seal.js). It
 * happens before the answer, so by the time the app asks for a link to its file the
 * link names the sealed one.
 *
 * If sealing fails the upload is not confirmed: a confirmed upload is always one that
 * cannot change under the checker, and the app simply uploads again.
 */

import { HeadObjectCommand } from '@aws-sdk/client-s3'

import { one, query } from '../_lib/db.js'
import { userRoute, badRequest, notFound, HttpError } from '../_lib/http.js'
import { s3, BUCKET, MAX_UPLOAD_BYTES, deleteObject } from '../_lib/s3.js'
import { isUuid } from '../_lib/validate.js'
import { checkUploadInBackground } from '../_lib/moderation/service.js'
import { sealAsset } from '../_lib/moderation/seal.js'

export default userRoute(async (req, res, user) => {
  const { assetId } = req.body || {}
  if (!isUuid(assetId)) throw badRequest('assetId is required.')

  const asset = await one(
    'select id, s3_key, origin, sealed_at, created_at from assets where id = $1 and user_id = $2',
    [assetId, user.id],
  )
  if (!asset) throw notFound('This file could not be found.')

  let head
  try {
    head = await s3().send(new HeadObjectCommand({ Bucket: BUCKET, Key: asset.s3_key }))
  } catch (e) {
    // A missing object means the PUT never landed.
    if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
      throw new HttpError(409, 'The upload did not complete. Please try again.', 'UPLOAD_INCOMPLETE')
    }
    throw e
  }

  const byteSize = Number(head.ContentLength || 0)
  if (byteSize > MAX_UPLOAD_BYTES) {
    await deleteObject(asset.s3_key)
    await query('delete from assets where id = $1 and user_id = $2', [asset.id, user.id])
    throw new HttpError(413, 'This file is too large.', 'TOO_LARGE')
  }

  // Before the size is recorded and before the answer: see the header.
  await sealAsset(asset)

  await query('update assets set byte_size = $2 where id = $1', [asset.id, byteSize])
  res.json({ assetId: asset.id, byteSize })

  // Checked now, after the answer has gone, so the verdict is waiting when the
  // file is first used and the app is never made to wait for it.
  void checkUploadInBackground(asset.id, user.id)
}, { tag: '[storage/confirm]', message: 'Unable to confirm the upload. Please try again.' })
