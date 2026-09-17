/**
 * POST /api/storage/ingest  { sourceUrl, influencerId? } → { assetId, reused }
 *
 * Copy a generated file from KIE into the caller's own S3 space.
 *
 * KIE deletes its result URLs about 24 hours after completion, so a result is
 * not really the user's until the bytes are somewhere we control. Copying on the
 * server means a phone that dies or loses signal mid-download does not lose work
 * already paid for.
 *
 * The copy lives in _lib/results.js, shared with the worker. It is idempotent —
 * asking twice returns the stored copy (`reused: true`) — and it marks the queue
 * row collected. The URL is untrusted input; see the SSRF note there.
 */

import { one } from '../_lib/db.js'
import { userRoute, badRequest, forbidden, HttpError } from '../_lib/http.js'
import { storeGeneratedResult, isAllowedResultSource, ResultError } from '../_lib/results.js'
import { isUuid } from '../_lib/validate.js'

export default userRoute(async (req, res, user) => {
  const { sourceUrl, influencerId = null } = req.body || {}

  if (typeof sourceUrl !== 'string' || !isAllowedResultSource(sourceUrl)) {
    throw badRequest('That source is not allowed.', 'BAD_SOURCE')
  }
  if (influencerId !== null && !isUuid(influencerId)) throw badRequest('influencerId is not valid.')
  if (influencerId && !(await one('select 1 from influencers where id = $1 and user_id = $2', [influencerId, user.id]))) {
    throw forbidden('That influencer is not yours.')
  }

  try {
    const { assetId, reused } = await storeGeneratedResult({
      userId: user.id,
      influencerId,
      sourceUrl,
      enforceQuota: true,
    })
    res.json({ assetId, reused })
  } catch (e) {
    if (e instanceof ResultError) throw new HttpError(e.status, e.message, e.code)
    throw e
  }
}, { tag: '[storage/ingest]', message: 'Could not save the generated file. Please try again.' })
