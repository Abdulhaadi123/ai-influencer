/**
 * POST /api/generations/delete
 *
 * Remove one gallery entry and the file behind it.
 *
 * The generation row and its asset are deleted together. Dropping only the row
 * is the common mistake: the clip vanishes from the gallery, the user believes
 * it is gone, and the bytes stay in the bucket forever. "Delete" has to mean
 * deleted, both for cost and because a user asking to remove a generated video
 * of a person is making a request about the file, not about a list.
 *
 * Body: { generationId } → 204
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

  const { generationId } = req.body || {}
  if (!generationId) return res.status(400).json({ error: 'generationId is required.' })

  const db = adminClient()

  try {
    const { data: row, error } = await db
      .from('generations')
      .select('id, asset_id, assets!inner(id, s3_key, user_id)')
      .eq('id', generationId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (error) throw error
    if (!row) return res.status(204).end()   // already gone

    const asset = row.assets

    // Otherwise the job that produced it could be collected again by the worker.
    if (row.asset_id) await forgetSource(db, user.id, row.asset_id)

    // Guard against a mismatched join before touching the object.
    if (asset?.s3_key && asset.user_id === user.id) {
      await deleteObject(asset.s3_key)
    }

    await db.from('generations').delete().eq('id', row.id).eq('user_id', user.id)
    if (row.asset_id) {
      await db.from('assets').delete().eq('id', row.asset_id).eq('user_id', user.id)
    }

    return res.status(204).end()
  } catch (e) {
    return sendServerError(res, e, { tag: '[generations/delete]', message: 'Could not delete that item. Please try again.' })
  }
}
