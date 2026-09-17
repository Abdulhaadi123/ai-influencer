/**
 * POST /api/storage/ingest
 *
 * Copy a generated file from KIE into the caller's own S3 space.
 *
 * KIE deletes its result URLs about 24 hours after completion, so a result is
 * not really the user's until the bytes are somewhere we control. Doing the
 * copy server-side rather than on the device means a phone that dies, loses
 * signal, or is killed by the OS mid-download does not lose work that has
 * already been paid for.
 *
 * The copy itself lives in _lib/results.js, shared with the worker. It is
 * idempotent: asking twice for the same result returns the asset already
 * stored (`reused: true`) rather than a second copy, and the queue row that
 * produced the URL is marked collected as part of the same request. That URL
 * is untrusted input — see the SSRF note in results.js.
 *
 * Body: { sourceUrl, kind?, influencerId?, contentType? }
 * → { assetId, reused }
 */

import { requireUser, adminClient, applyCors } from '../_lib/auth.js'
import { sendServerError } from '../_lib/errors.js'
import { storeGeneratedResult, isAllowedResultSource, ResultError } from '../_lib/results.js'

export default async function handler(req, res) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const user = await requireUser(req, res)
  if (!user) return

  const { sourceUrl, influencerId = null } = req.body || {}

  if (!sourceUrl || !isAllowedResultSource(sourceUrl)) {
    return res.status(400).json({ error: 'That source is not allowed.', code: 'BAD_SOURCE' })
  }

  const db = adminClient()

  try {
    if (influencerId) {
      const { data: owned, error: ownError } = await db
        .from('influencers').select('id')
        .eq('id', influencerId).eq('user_id', user.id).maybeSingle()
      // A failed lookup is a server problem, not proof the influencer is someone else's.
      if (ownError) throw ownError
      if (!owned) return res.status(403).json({ error: 'That influencer is not yours.', code: 'FORBIDDEN' })
    }

    const { assetId, reused } = await storeGeneratedResult(db, {
      userId: user.id,
      influencerId,
      sourceUrl,
      enforceQuota: true,
    })

    return res.status(200).json({ assetId, reused })
  } catch (e) {
    if (e instanceof ResultError) {
      return res.status(e.status).json({ error: e.message, code: e.code })
    }
    return sendServerError(res, e, { tag: '[ingest]', message: 'Could not save the generated file. Please try again.' })
  }
}
