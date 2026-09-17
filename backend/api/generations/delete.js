/**
 * POST /api/generations/delete  { generationId } → 204
 *
 * Remove one gallery entry and the file behind it.
 *
 * Dropping only the row is the common mistake: the clip vanishes from the
 * gallery, the user believes it is gone, and the bytes stay in the bucket
 * forever. "Delete" has to mean deleted — for cost, and because someone asking
 * to remove a generated video of a person is asking about the file.
 */

import { one, transaction } from '../_lib/db.js'
import { userRoute, badRequest } from '../_lib/http.js'
import { deleteObject } from '../_lib/s3.js'
import { forgetSource } from '../_lib/results.js'
import { isUuid } from '../_lib/validate.js'

export default userRoute(async (req, res, user) => {
  const { generationId } = req.body || {}
  if (!isUuid(generationId)) throw badRequest('generationId is required.')

  // The join repeats the owner, so the file deleted is certainly this caller's.
  const row = await one(
    `select g.id, g.asset_id, a.s3_key
       from generations g
       join assets a on a.id = g.asset_id and a.user_id = g.user_id
      where g.id = $1 and g.user_id = $2`,
    [generationId, user.id],
  )
  if (!row) return res.status(204).end()   // already gone

  await deleteObject(row.s3_key)

  await transaction(async client => {
    // Otherwise the job that produced it could be collected again by the worker.
    // Inside the transaction, so the job never appears changed while the asset
    // is still attached to it.
    await forgetSource(user.id, row.asset_id, client)
    await client.query('delete from generations where id = $1 and user_id = $2', [row.id, user.id])
    await client.query('delete from assets where id = $1 and user_id = $2', [row.asset_id, user.id])
  })

  res.status(204).end()
}, { tag: '[generations/delete]', message: 'Unable to delete this item. Please try again.' })
