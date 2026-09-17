/**
 * POST /api/influencers/delete
 *
 * Delete an influencer and everything belonging to it.
 *
 * The database cascades the rows — generations, jobs, settings, creation
 * params, assets. What it cannot cascade is S3, so the objects are collected
 * and removed here first. A plain `delete from influencers` would leave every
 * image and video that influencer ever produced sitting in the bucket:
 * unreachable, unlistable through the app, and billed indefinitely.
 *
 * Body: { influencerId } → { deletedAssets }
 */

import { requireUser, adminClient, applyCors } from '../_lib/auth.js'
import { sendServerError } from '../_lib/errors.js'
import { deleteObjects } from '../_lib/s3.js'

export default async function handler(req, res) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const user = await requireUser(req, res)
  if (!user) return

  const { influencerId } = req.body || {}
  if (!influencerId) return res.status(400).json({ error: 'influencerId is required.' })

  const db = adminClient()

  try {
    const { data: owned, error: ownError } = await db
      .from('influencers')
      .select('id')
      .eq('id', influencerId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (ownError) throw ownError
    if (!owned) return res.status(404).json({ error: 'No such influencer.', code: 'NOT_FOUND' })

    // Both filters together: influencer_id finds the assets, user_id makes the
    // query safe even if an influencer id were somehow reused.
    const { data: assets, error: assetError } = await db
      .from('assets')
      .select('id, s3_key')
      .eq('influencer_id', influencerId)
      .eq('user_id', user.id)

    if (assetError) throw assetError

    const keys = (assets || []).map(a => a.s3_key)
    if (keys.length) await deleteObjects(keys)

    // Rows go last. If the sweep above threw, nothing is deleted and the user
    // can retry — rather than losing the records that point at the files.
    const { error: deleteError } = await db
      .from('influencers')
      .delete()
      .eq('id', influencerId)
      .eq('user_id', user.id)

    if (deleteError) throw deleteError

    return res.status(200).json({ deletedAssets: keys.length })
  } catch (e) {
    return sendServerError(res, e, { tag: '[influencers/delete]', message: 'Could not delete the influencer. Nothing was removed — please try again.' })
  }
}
