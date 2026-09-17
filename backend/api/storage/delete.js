/**
 * POST /api/storage/delete
 *
 * Permanently remove one asset: the S3 object and the row.
 *
 * Order matters. The object goes first, then the row. If the object delete
 * fails, the row survives and the asset is still visible and still deletable —
 * the user can try again. Deleting the row first and then failing on S3 would
 * leave a file nobody can see, nobody can remove, and everybody pays for.
 *
 * Body: { assetId } → 204
 */

import { requireUser, adminClient, applyCors } from '../_lib/auth.js'
import { sendServerError } from '../_lib/errors.js'
import { deleteObject } from '../_lib/s3.js'
import { forgetSource } from '../_lib/results.js'

export default async function handler(req, res) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const user = await requireUser(req, res)
  if (!user) return

  const { assetId } = req.body || {}
  if (!assetId) return res.status(400).json({ error: 'assetId is required.' })

  const db = adminClient()

  try {
    const { data: asset, error } = await db
      .from('assets')
      .select('id, s3_key')
      .eq('id', assetId)
      .eq('user_id', user.id)   // ownership check
      .maybeSingle()

    if (error) throw error
    // Already gone is a success from the caller's point of view.
    if (!asset) return res.status(204).end()

    await forgetSource(db, user.id, asset.id)
    await deleteObject(asset.s3_key)
    await db.from('assets').delete().eq('id', asset.id)

    return res.status(204).end()
  } catch (e) {
    return sendServerError(res, e, { tag: '[storage/delete]', message: 'Could not delete the file. Please try again.' })
  }
}
