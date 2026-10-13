/**
 * POST /api/reports  { generationId, reason, note? } → { reported: true }
 *
 * "This result is inappropriate." A person flags something the app made for them.
 * Google Play expects an AI app to let people do this and to act on it; the
 * report lands in the admin's moderation queue like anything the checker held.
 *
 * What a report is not: an accusation against the reporter, who is flagging
 * something the generator produced for them. It is never a strike (events.js).
 *
 * Only the reporter's own gallery can be reported — there is no sharing between
 * accounts, so there is nothing of anyone else's to point at, and an id from
 * another account is "not found", the same as a made-up one.
 */

import { one } from '../_lib/db.js'
import { userRoute, badRequest, notFound, enforceLimit } from '../_lib/http.js'
import { isUuid } from '../_lib/validate.js'
import { optionalText } from '../_lib/admin.js'
import { recordEvent } from '../_lib/moderation/events.js'
import { createRateLimiter } from '../../lib/rateLimit.js'

export const REPORT_REASONS = ['sexual', 'violence', 'hateful', 'other']

/** Plenty for a person; stops a script from flooding the queue. */
const reportsByUser = createRateLimiter([{ windowMs: 60 * 60_000, max: 20 }])

export default userRoute(async (req, res, user) => {
  const { generationId, reason } = req.body || {}
  if (!isUuid(generationId)) throw badRequest('generationId is required.')
  if (!REPORT_REASONS.includes(reason)) throw badRequest(`reason must be one of: ${REPORT_REASONS.join(', ')}.`)
  const note = optionalText(req.body?.note, 'The note', 300)

  enforceLimit(reportsByUser, `user:${user.id}`, 'You have sent a lot of reports. Please try again later.')

  const generation = await one(
    'select asset_id from generations where id = $1 and user_id = $2',
    [generationId, user.id],
  )
  if (!generation) throw notFound('That item could not be found.')

  // Reporting the same item twice is one report, not two entries to review.
  const already = await one(
    `select 1 from moderation_events
      where user_id = $1 and asset_id = $2 and source = 'report' and status = 'open'`,
    [user.id, generation.asset_id],
  )
  if (!already) {
    await recordEvent({
      userId: user.id,
      source: 'report',
      action: 'review',
      categories: [reason],
      excerpt: note,
      assetId: generation.asset_id,
    })
  }

  res.status(already ? 200 : 201).json({ reported: true })
}, { tag: '[reports]', message: 'Unable to send your report. Please try again.' })
