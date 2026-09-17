/**
 * POST /api/storage/upload-url  { contentType, byteSize, influencerId? }
 * → { assetId, uploadUrl, expiresIn }
 *
 * Mint a presigned PUT so the app can send a file straight to S3, and record
 * the asset row that will own it.
 *
 * `byteSize` is required and is signed into the URL, so S3 accepts exactly that
 * many bytes and no other number — the quota is checked against a size that
 * cannot be understated.
 *
 * The row is written BEFORE the bytes move. An upload that dies halfway leaves a
 * row with no object — visible and deletable. The other order would leave an
 * object no row knows about: invisible, undeletable, and billed forever.
 */

import { one, query } from '../_lib/db.js'
import { userRoute, badRequest, forbidden, noStore, HttpError } from '../_lib/http.js'
import {
  newKey, presignPut, kindFor, ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES, UPLOAD_TTL_SECONDS,
} from '../_lib/s3.js'
import { wouldExceedQuota, QUOTA_EXCEEDED_RESPONSE } from '../_lib/quota.js'
import { isUuid } from '../_lib/validate.js'

export default userRoute(async (req, res, user) => {
  const { contentType, influencerId = null, byteSize } = req.body || {}

  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    const shown = typeof contentType === 'string' ? ` (${contentType.slice(0, 60)})` : ''
    throw badRequest(`Unsupported file type${shown}.`, 'UNSUPPORTED_TYPE')
  }
  if (!Number.isInteger(byteSize) || byteSize <= 0) throw badRequest('The file size is missing.', 'SIZE_REQUIRED')
  if (byteSize > MAX_UPLOAD_BYTES) throw new HttpError(413, 'That file is too large.', 'TOO_LARGE')
  if (influencerId !== null && !isUuid(influencerId)) throw badRequest('influencerId is not valid.')

  // Attaching a file to a stranger's influencer would surface it in their studio.
  if (influencerId && !(await one('select 1 from influencers where id = $1 and user_id = $2', [influencerId, user.id]))) {
    throw forbidden('That influencer is not yours.')
  }

  if (await wouldExceedQuota(user.id, byteSize)) {
    throw new HttpError(507, QUOTA_EXCEEDED_RESPONSE.error, QUOTA_EXCEEDED_RESPONSE.code)
  }

  const { assetId, key } = newKey({ userId: user.id, contentType })
  await query(
    `insert into assets (id, user_id, influencer_id, s3_key, kind, origin, content_type, byte_size)
     values ($1, $2, $3, $4, $5, 'upload', $6, $7)`,
    [assetId, user.id, influencerId, key, kindFor(contentType), contentType, byteSize],
  )

  const uploadUrl = await presignPut({ key, contentType, byteSize })
  noStore(res)
  res.json({ assetId, uploadUrl, expiresIn: UPLOAD_TTL_SECONDS })
}, { tag: '[storage/upload-url]', message: 'Could not prepare the upload. Please try again.' })
