/**
 * POST /api/storage/upload-url
 *
 * Mint a presigned PUT so the client can send a file straight to S3, and
 * record the asset row that will own it.
 *
 * The row is written BEFORE the bytes move. An upload that dies halfway then
 * leaves a row with no object — recoverable, sweepable, visible. The other
 * order leaves an object no row knows about: invisible, un-deletable through
 * the app, and billed forever.
 *
 * Body: { contentType, byteSize, kind?, influencerId? }
 * → { assetId, uploadUrl, expiresIn }
 *
 * `byteSize` is required and is signed into the upload URL, so S3 accepts
 * exactly that many bytes and no other number. The quota is checked against it.
 */

import { requireUser, adminClient, applyCors } from '../_lib/auth.js'
import { sendServerError } from '../_lib/errors.js'
import {
  newKey, presignPut, kindFor,
  ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES, UPLOAD_TTL_SECONDS,
} from '../_lib/s3.js'
import { wouldExceedQuota, QUOTA_EXCEEDED_RESPONSE } from '../_lib/quota.js'

export default async function handler(req, res) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const user = await requireUser(req, res)
  if (!user) return

  const { contentType, influencerId = null, byteSize } = req.body || {}

  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    return res.status(400).json({
      error: `Unsupported file type${contentType ? ` (${contentType})` : ''}.`,
      code: 'UNSUPPORTED_TYPE',
    })
  }

  if (!Number.isInteger(byteSize) || byteSize <= 0) {
    return res.status(400).json({ error: 'The file size is missing.', code: 'SIZE_REQUIRED' })
  }
  if (byteSize > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: 'That file is too large.', code: 'TOO_LARGE' })
  }

  const db = adminClient()

  try {
    // If the client named an influencer, it must be the caller's. Skipping this
    // would let someone attach their file to a stranger's influencer — the row
    // would still be theirs, but it would surface in someone else's studio.
    if (influencerId) {
      const { data: owned, error } = await db
        .from('influencers')
        .select('id')
        .eq('id', influencerId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (error) throw error
      if (!owned) return res.status(403).json({ error: 'That influencer is not yours.', code: 'FORBIDDEN' })
    }

    if (await wouldExceedQuota(db, user.id, byteSize)) {
      return res.status(507).json(QUOTA_EXCEEDED_RESPONSE)
    }

    const { assetId, key } = newKey({ userId: user.id, contentType })

    const { error: insertError } = await db.from('assets').insert({
      id: assetId,
      user_id: user.id,
      influencer_id: influencerId,
      s3_key: key,
      kind: kindFor(contentType),
      origin: 'upload',
      content_type: contentType,
      byte_size: byteSize,
    })
    if (insertError) throw insertError

    const uploadUrl = await presignPut({ key, contentType, byteSize })

    return res.status(200).json({ assetId, uploadUrl, expiresIn: UPLOAD_TTL_SECONDS })
  } catch (e) {
    return sendServerError(res, e, { tag: '[upload-url]', message: 'Could not prepare the upload. Please try again.' })
  }
}
