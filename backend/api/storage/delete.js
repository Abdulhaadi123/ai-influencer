/**
 * POST /api/storage/delete  { assetId } → 204
 *
 * Permanently remove one file: the S3 object, then the row.
 *
 * Object first. If that fails, the row survives and the file is still visible
 * and still deletable. Row first would leave a file nobody can see or remove.
 */

import { one, query } from '../_lib/db.js'
import { userRoute, badRequest } from '../_lib/http.js'
import { deleteObject } from '../_lib/s3.js'
import { forgetSource } from '../_lib/results.js'
import { isUuid } from '../_lib/validate.js'

export default userRoute(async (req, res, user) => {
  const { assetId } = req.body || {}
  if (!isUuid(assetId)) throw badRequest('assetId is required.')

  const asset = await one('select id, s3_key from assets where id = $1 and user_id = $2', [assetId, user.id])
  // Already gone is a success from the caller's point of view.
  if (!asset) return res.status(204).end()

  // A job still holding the generator's link with no asset looks uncollected,
  // and the worker would store the deleted file again.
  await forgetSource(user.id, asset.id)
  await deleteObject(asset.s3_key)
  await query('delete from assets where id = $1 and user_id = $2', [asset.id, user.id])

  res.status(204).end()
}, { tag: '[storage/delete]', message: 'Could not delete the file. Please try again.' })
