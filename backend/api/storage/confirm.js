/**
 * POST /api/storage/confirm
 *
 * Called after a direct-to-S3 upload finishes, to stamp the asset row with the
 * size S3 actually received.
 *
 * The client reports a byte size when it asks for the upload URL, but that is
 * a claim made before the bytes moved. Reading the object's real length here is
 * what makes the storage quota honest — otherwise a client could understate
 * every upload and store without limit.
 *
 * An asset that is never confirmed keeps its provisional size and can be swept
 * later; it is not an error, just an upload that did not finish.
 *
 * Body: { assetId } → { assetId, byteSize }
 */

import { requireUser, adminClient, applyCors } from '../_lib/auth.js'
import { sendServerError } from '../_lib/errors.js'
import { s3, BUCKET, MAX_UPLOAD_BYTES, deleteObject } from '../_lib/s3.js'
import { HeadObjectCommand } from '@aws-sdk/client-s3'

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
      .eq('user_id', user.id)
      .maybeSingle()

    if (error) throw error
    if (!asset) return res.status(404).json({ error: 'No such asset.', code: 'NOT_FOUND' })

    const head = await s3().send(new HeadObjectCommand({ Bucket: BUCKET, Key: asset.s3_key }))
    const byteSize = Number(head.ContentLength || 0)

    // The signed length makes this unreachable through the app's own upload
    // URLs. It stays because the cost of being wrong is unbounded storage.
    if (byteSize > MAX_UPLOAD_BYTES) {
      await deleteObject(asset.s3_key)
      await db.from('assets').delete().eq('id', asset.id).eq('user_id', user.id)
      return res.status(413).json({ error: 'That file is too large.', code: 'TOO_LARGE' })
    }

    const { error: stampError } = await db.from('assets').update({ byte_size: byteSize }).eq('id', asset.id)
    if (stampError) throw stampError

    return res.status(200).json({ assetId: asset.id, byteSize })
  } catch (e) {
    // A missing object means the PUT never landed. The row stays as a record of
    // the attempt rather than being deleted, so a sweep can reconcile it.
    if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
      return res.status(409).json({ error: 'The upload did not complete.', code: 'UPLOAD_INCOMPLETE' })
    }
    return sendServerError(res, e, { tag: '[confirm]', message: 'Could not confirm the upload. Please try again.' })
  }
}
