/**
 * POST /api/influencers/delete  { influencerId } → { deletedAssets }
 *
 * Delete an influencer and everything belonging to it.
 *
 * The database cascades the rows — generations, jobs, settings, creation
 * params, assets. What it cannot cascade is S3, so the objects are collected
 * and removed here first. A plain row delete would leave every image and video
 * that influencer ever produced in the bucket: unreachable, and billed forever.
 */

import { one, many, query } from '../_lib/db.js'
import { userRoute, badRequest, notFound } from '../_lib/http.js'
import { deleteObjects } from '../_lib/s3.js'
import { isUuid } from '../_lib/validate.js'

export default userRoute(async (req, res, user) => {
  const { influencerId } = req.body || {}
  if (!isUuid(influencerId)) throw badRequest('influencerId is required.')

  const owned = await one('select id from influencers where id = $1 and user_id = $2', [influencerId, user.id])
  if (!owned) throw notFound('No such influencer.')

  // Both filters: influencer_id finds the files, user_id keeps the sweep to this caller.
  const assets = await many('select s3_key from assets where influencer_id = $1 and user_id = $2', [influencerId, user.id])
  const keys = assets.map(a => a.s3_key)
  if (keys.length) await deleteObjects(keys)

  // Rows go last. If the sweep above threw, nothing is deleted and the user can
  // retry — rather than losing the records that point at the files.
  await query('delete from influencers where id = $1 and user_id = $2', [influencerId, user.id])

  res.json({ deletedAssets: keys.length })
}, { tag: '[influencers/delete]', message: 'Could not delete the influencer. Nothing was removed — please try again.' })
