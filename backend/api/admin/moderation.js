/**
 * Admin — the moderation queue.
 *
 *   GET  /api/admin/moderation?status=&source=&action=&page=
 *   GET  /api/admin/moderation/media?eventId=            a short-lived link to the file
 *   POST /api/admin/moderation/resolve  { eventId, resolution, note?, deleteContent?, suspendUser? }
 *
 * Everything the checker refused or held back lands here as an event, newest
 * first. A reviewer decides one of two things:
 *
 *   dismiss   the checker was wrong. The strike is withdrawn (strikes are counted
 *             from non-dismissed events), and a file that was quarantined comes
 *             back to its owner's gallery.
 *   confirm   the checker was right. A file that had been let through for review is
 *             now blocked and hidden from its owner; optionally the file is
 *             deleted for good and/or the account suspended.
 *
 * Looking at someone's file is itself recorded in the audit log.
 */

import { one, many, query, transaction } from '../_lib/db.js'
import { adminRoute, audit, pageOf, optionalText } from '../_lib/admin.js'
import { badRequest, notFound, noStore, HttpError } from '../_lib/http.js'
import { isUuid } from '../_lib/validate.js'
import { presignGet, deleteObject } from '../_lib/s3.js'
import { forgetSource } from '../_lib/results.js'
import { suspendUser } from '../_lib/suspension.js'
import { releaseAsset, quarantineAsset } from '../_lib/moderation/service.js'

const STATUSES = ['open', 'dismissed', 'confirmed']
const SOURCES = ['prompt', 'prompt_assist', 'image', 'video', 'output', 'report', 'provider']
const ACTIONS = ['blocked', 'review']

/** How long the link to a reviewed file lives: long enough to look, short enough not to be shared. */
const MEDIA_LINK_SECONDS = 120

/** The columns of one moderation item, as the list and the single-item read both send them. */
const EVENT_SELECT = `
  select e.id, e.user_id, u.email, u.status as user_status, e.source, e.action, e.categories, e.scores, e.excerpt,
         e.asset_id, a.kind as asset_kind, a.moderation_status as asset_status,
         e.kie_task_id, e.model, e.status, e.review_note, e.reviewed_at, rb.email as reviewed_by, e.created_at
    from moderation_events e
    join users u on u.id = e.user_id
    left join assets a on a.id = e.asset_id
    left join users rb on rb.id = e.reviewed_by`

const shapeEvent = r => ({
  id: r.id,
  userId: r.user_id,
  email: r.email,
  userStatus: r.user_status,
  source: r.source,
  action: r.action,
  categories: r.categories,
  scores: r.scores,
  excerpt: r.excerpt,
  assetId: r.asset_id,
  assetKind: r.asset_kind,
  assetStatus: r.asset_status,
  taskId: r.kie_task_id,
  model: r.model,
  status: r.status,
  reviewNote: r.review_note,
  reviewedAt: r.reviewed_at,
  reviewedBy: r.reviewed_by,
  createdAt: r.created_at,
})

export const list = adminRoute(async (req, res) => {
  const { page, pageSize, limit, offset } = pageOf(req)

  // Open by default — that is the work. `all` is asked for explicitly.
  const requested = req.query?.status ?? 'open'
  if (requested !== 'all' && !STATUSES.includes(requested)) throw badRequest(`status must be one of: all, ${STATUSES.join(', ')}.`)
  const status = requested === 'all' ? null : requested
  const source = req.query?.source || null
  if (source !== null && !SOURCES.includes(source)) throw badRequest(`source must be one of: ${SOURCES.join(', ')}.`)
  const action = req.query?.action || null
  if (action !== null && !ACTIONS.includes(action)) throw badRequest(`action must be one of: ${ACTIONS.join(', ')}.`)

  const userId = req.query?.userId || null
  if (userId !== null && !isUuid(userId)) throw badRequest('userId is not valid.')

  const filter = `($1::text is null or e.status = $1) and ($2::text is null or e.source = $2) and ($3::text is null or e.action = $3)
                  and ($4::uuid is null or e.user_id = $4::uuid)`

  const rows = await many(
    `${EVENT_SELECT}
      where ${filter}
      order by e.created_at desc, e.id
      limit $5 offset $6`,
    [status, source, action, userId, limit, offset],
  )
  const { total } = await one(`select count(*)::int as total from moderation_events e where ${filter}`, [status, source, action, userId])

  // How many sit under each status for the OTHER filters, so the tabs can say how
  // much there is to do without a request each.
  const byStatus = await many(
    `select e.status, count(*)::int as n from moderation_events e
      where ($1::text is null or e.source = $1) and ($2::text is null or e.action = $2) and ($3::uuid is null or e.user_id = $3::uuid)
      group by e.status`,
    [source, action, userId],
  )
  const counts = { open: 0, dismissed: 0, confirmed: 0 }
  for (const row of byStatus) counts[row.status] = row.n

  noStore(res)
  res.json({
    events: rows.map(shapeEvent),
    total, page, pageSize, counts,
  })
}, { tag: '[admin/moderation]', message: 'Unable to load the moderation queue.' })

/** One item by id — what a shared link to #/moderation/<id> needs, wherever it sits in the queue. */
export const item = adminRoute(async (req, res) => {
  const eventId = req.query?.eventId
  if (!isUuid(eventId)) throw badRequest('eventId is required.')
  const row = await one(`${EVENT_SELECT} where e.id = $1`, [eventId])
  if (!row) throw notFound('That moderation item does not exist.')
  noStore(res)
  res.json({ event: shapeEvent(row) })
}, { tag: '[admin/moderation/item]', message: 'Unable to load this item.' })

export const media = adminRoute(async (req, res, admin) => {
  const eventId = req.query?.eventId
  if (!isUuid(eventId)) throw badRequest('eventId is required.')

  const row = await one(
    `select a.id, a.s3_key, a.kind, e.user_id
       from moderation_events e join assets a on a.id = e.asset_id
      where e.id = $1`,
    [eventId],
  )
  if (!row) throw notFound('This event has no file to show.')

  const url = await presignGet({ key: row.s3_key, expiresIn: MEDIA_LINK_SECONDS })
  await audit(admin, 'moderation.view-media', { targetType: 'asset', targetId: row.id, details: { eventId, ownerId: row.user_id } })

  noStore(res)
  res.json({ url, kind: row.kind, expiresIn: MEDIA_LINK_SECONDS })
}, { tag: '[admin/moderation/media]', message: 'Unable to open this file.' })

/** Delete a file for good: the object first, so a failure leaves a row that can be retried. */
async function destroyAsset(assetId) {
  const asset = await one('select id, user_id, s3_key from assets where id = $1', [assetId])
  if (!asset) return false
  await deleteObject(asset.s3_key)
  await transaction(async client => {
    await forgetSource(asset.user_id, asset.id, client)
    await client.query('delete from assets where id = $1', [asset.id])
  })
  return true
}

/**
 * Put a decided item back to open. Tried twice: this runs because something just
 * failed, and that something may well be the database connection.
 */
async function handBack(eventId, decided) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await query(
        `update moderation_events set status = 'open', reviewed_by = null, reviewed_at = null, review_note = null where id = $1 and status = $2`,
        [eventId, decided],
      )
      return
    } catch (e) {
      if (attempt === 2) console.error('[admin/moderation/resolve] could not hand the item back:', e.message)
    }
  }
}

export const resolve = adminRoute(async (req, res, admin) => {
  const { eventId, resolution } = req.body || {}
  if (!isUuid(eventId)) throw badRequest('eventId is required.')
  if (resolution !== 'dismiss' && resolution !== 'confirm') throw badRequest('resolution must be "dismiss" or "confirm".')
  const note = optionalText(req.body?.note, 'The note', 500)
  const deleteContent = req.body?.deleteContent === true
  const suspend = req.body?.suspendUser === true
  if (resolution === 'dismiss' && (deleteContent || suspend)) {
    throw badRequest('Deleting content or suspending the account only goes with "confirm".')
  }

  // The status change is the claim: only the first reviewer's write lands, so two
  // admins on the same event cannot both act on it.
  const decided = resolution === 'dismiss' ? 'dismissed' : 'confirmed'
  const event = await one(
    `update moderation_events
        set status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4
      where id = $1 and status = 'open'
      returning id, user_id, asset_id, source`,
    [eventId, decided, admin.id, note],
  )
  if (!event) throw new HttpError(409, 'This event was already reviewed, or does not exist.', 'ALREADY_REVIEWED')

  const outcome = { restored: false, blocked: false, deleted: false, suspended: false }

  // What a decision does reaches into storage and other tables, so it cannot be one
  // transaction. Instead every step can be done again harmlessly, and if any fails
  // the item is handed back as open: a decision that could not be carried out must not
  // look made, and the admin can simply press the button again.
  try {
    if (event.asset_id) {
      if (resolution === 'dismiss') {
        outcome.restored = await releaseAsset(event.asset_id)
      } else {
        // Confirming a file that was let through for review: it is not clean after
        // all, so it is blocked and hidden from its owner.
        const asset = await one('select id, user_id, moderation_status from assets where id = $1', [event.asset_id])
        if (asset) {
          if (asset.moderation_status !== 'blocked') {
            await query(`update assets set moderation_status = 'blocked', moderated_at = now() where id = $1`, [asset.id])
            outcome.blocked = true
          }
          // Every time, not only when it was just blocked: if an earlier attempt blocked
          // the file and then failed, this finishes taking it down. Repeating it is harmless.
          await quarantineAsset(asset.id, asset.user_id)
        }
        if (deleteContent) outcome.deleted = await destroyAsset(event.asset_id)
      }
    }

    if (suspend) {
      const owner = await one('select role from users where id = $1', [event.user_id])
      // Never an admin: see api/admin/users.js.
      if (owner && owner.role !== 'admin') {
        outcome.suspended = await suspendUser(event.user_id, `By ${admin.email}: confirmed moderation event.`)
      }
    }

    await audit(admin, `moderation.${resolution}`, { targetType: 'moderation_event', targetId: event.id, details: { ...outcome, note } })
  } catch (e) {
    await handBack(event.id, decided)
    throw e
  }
  res.json({ ok: true, ...outcome })
}, { tag: '[admin/moderation/resolve]', message: 'Unable to save this decision.' })
