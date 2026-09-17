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
 */

import { HeadObjectCommand } from '@aws-sdk/client-s3'

import { one, query } from '../_lib/db.js'
import { userRoute, badRequest, notFound, HttpError } from '../_lib/http.js'
import { s3, BUCKET, MAX_UPLOAD_BYTES, deleteObject } from '../_lib/s3.js'
import { isUuid } from '../_lib/validate.js'

export default userRoute(async (req, res, user) => {
  const { assetId } = req.body || {}
  if (!isUuid(assetId)) throw badRequest('assetId is required.')

  const asset = await one('select id, s3_key from assets where id = $1 and user_id = $2', [assetId, user.id])
  if (!asset) throw notFound('No such file.')

  let head
  try {
    head = await s3().send(new HeadObjectCommand({ Bucket: BUCKET, Key: asset.s3_key }))
  } catch (e) {
    // A missing object means the PUT never landed.
    if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
      throw new HttpError(409, 'The upload did not complete.', 'UPLOAD_INCOMPLETE')
    }
    throw e
  }

  const byteSize = Number(head.ContentLength || 0)
  if (byteSize > MAX_UPLOAD_BYTES) {
    await deleteObject(asset.s3_key)
    await query('delete from assets where id = $1 and user_id = $2', [asset.id, user.id])
    throw new HttpError(413, 'That file is too large.', 'TOO_LARGE')
  }

  await query('update assets set byte_size = $2 where id = $1', [asset.id, byteSize])
  res.json({ assetId: asset.id, byteSize })
}, { tag: '[storage/confirm]', message: 'Could not confirm the upload. Please try again.' })
