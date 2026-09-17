/**
 * POST /api/storage/download-url  { assetIds: string[], downloadName?, purpose?: 'display' | 'generation' }
 * → { urls: { [assetId]: { url, expiresIn } } }
 *
 * Mint short-lived presigned GET URLs for files the caller owns. This is the
 * authorisation gate for every image and video in the app: the query below only
 * returns the caller's own rows, so asking for someone else's file id returns
 * nothing — the id is simply absent from `urls`, and a gallery renders a
 * placeholder instead of failing.
 *
 * Batched — at most 100 ids — so a gallery resolves thirty tiles in one request.
 *
 * `purpose: 'generation'` signs for the longer lifetime a link needs to survive
 * the generator's queue (see GENERATION_TTL_SECONDS). The ownership check is the
 * same either way.
 */

import { many } from '../_lib/db.js'
import { userRoute, badRequest, noStore } from '../_lib/http.js'
import { presignGet, DOWNLOAD_TTL_SECONDS, GENERATION_TTL_SECONDS } from '../_lib/s3.js'
import { isUuid, text } from '../_lib/validate.js'

const MAX_IDS = 100

export default userRoute(async (req, res, user) => {
  const { assetIds, purpose = 'display' } = req.body || {}
  const downloadName = text(req.body?.downloadName, 120)
  const ttl = purpose === 'generation' ? GENERATION_TTL_SECONDS : DOWNLOAD_TTL_SECONDS

  if (!Array.isArray(assetIds) || assetIds.length === 0) throw badRequest('assetIds must be a non-empty list.')
  if (assetIds.length > MAX_IDS) throw badRequest(`Ask for at most ${MAX_IDS} files at a time.`)

  const ids = [...new Set(assetIds.filter(isUuid))]
  const rows = ids.length
    ? await many('select id, s3_key from assets where user_id = $1 and id = any($2::uuid[])', [user.id, ids])
    : []

  const urls = {}
  await Promise.all(rows.map(async row => {
    urls[row.id] = { url: await presignGet({ key: row.s3_key, downloadName, expiresIn: ttl }), expiresIn: ttl }
  }))

  // A shared cache holding these would hand one user's signed URLs to the next.
  noStore(res)
  res.json({ urls })
}, { tag: '[storage/download-url]', message: 'Could not prepare the download. Please try again.' })
