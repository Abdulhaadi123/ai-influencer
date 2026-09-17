/**
 * POST /api/storage/download-url
 *
 * Mint short-lived presigned GET URLs for assets the caller owns.
 *
 * This is the authorisation gate for every image and video in the app. The
 * ownership check is the `.eq('user_id', user.id)` below — asking for someone
 * else's asset id returns nothing rather than a URL, and the response simply
 * omits it. No error is raised for a missing id: a gallery should render a
 * placeholder for a deleted item, not fail wholesale.
 *
 * Batched on purpose. A gallery resolves thirty tiles in one request instead of
 * thirty, which matters both for latency and because presigning is not free.
 *
 * `purpose: 'generation'` asks for the longer lifetime a link needs to survive
 * the generator's queue (see GENERATION_TTL_SECONDS). The ownership check is
 * identical either way.
 *
 * Body: { assetIds: string[], downloadName?, purpose?: 'display' | 'generation' }
 * → { urls: { [assetId]: { url, expiresIn } } }
 */

import { requireUser, adminClient, applyCors } from '../_lib/auth.js'
import { sendServerError } from '../_lib/errors.js'
import { presignGet, DOWNLOAD_TTL_SECONDS, GENERATION_TTL_SECONDS } from '../_lib/s3.js'

/** Caps the work one request can ask for. */
const MAX_IDS = 100

export default async function handler(req, res) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const user = await requireUser(req, res)
  if (!user) return

  const { assetIds, downloadName = null, purpose = 'display' } = req.body || {}
  const ttl = purpose === 'generation' ? GENERATION_TTL_SECONDS : DOWNLOAD_TTL_SECONDS

  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    return res.status(400).json({ error: 'assetIds must be a non-empty array.' })
  }
  if (assetIds.length > MAX_IDS) {
    return res.status(400).json({ error: `Ask for at most ${MAX_IDS} assets at a time.` })
  }

  try {
    const { data: rows, error } = await adminClient()
      .from('assets')
      .select('id, s3_key')
      // The whole security of this endpoint is this one line.
      .eq('user_id', user.id)
      .in('id', assetIds.map(String))

    if (error) throw error

    const urls = {}
    await Promise.all((rows || []).map(async row => {
      urls[row.id] = {
        url: await presignGet({ key: row.s3_key, downloadName, expiresIn: ttl }),
        expiresIn: ttl,
      }
    }))

    // Cache-Control matters here: a shared or CDN cache holding these would
    // hand one user's signed URLs to the next.
    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json({ urls })
  } catch (e) {
    return sendServerError(res, e, { tag: '[download-url]', message: 'Could not prepare the download. Please try again.' })
  }
}
