/**
 * Admin — accounts.
 *
 *   GET  /api/admin/users           search, sort and page through accounts
 *   GET  /api/admin/users/detail    one account: strikes, devices, recent jobs and flags
 *   POST /api/admin/users/suspend      { userId, reason }
 *   POST /api/admin/users/unsuspend    { userId }
 *   POST /api/admin/users/set-role     { userId, role }
 *   POST /api/admin/users/delete       { userId, confirmEmail }
 *
 * What an admin cannot do, on purpose: act on their own account (so no one locks
 * themselves out), or suspend/delete another admin without demoting them first — a
 * separate, deliberate step. Together those keep at least one administrator: the
 * only way to lose an admin is for another admin to demote them, and that admin is
 * then the one left.
 *
 * Each action and its audit entry are one transaction, so neither can exist
 * without the other.
 */

import { one, many, transaction } from '../_lib/db.js'
import { adminRoute, audit, pageOf, likeTerm, queryText, requiredText } from '../_lib/admin.js'
import { badRequest, notFound, forbidden, noStore, HttpError } from '../_lib/http.js'
import { isUuid, normalizeEmail } from '../_lib/validate.js'
import { suspendUser, unsuspendUser } from '../_lib/suspension.js'
import { revokeAllSessions } from '../_lib/sessions.js'
import { deleteUserObjects } from '../_lib/s3.js'
import { countStrikes } from '../_lib/moderation/events.js'
import { moderationConfig } from '../_lib/moderation/config.js'
import { balanceOf, billingEnforced, historyOf } from '../_lib/billing.js'
import { shapeEntry } from './billing.js'

const ROLES = ['user', 'admin']
const STATUSES = ['active', 'suspended']

/** Any fixed number: every role change asks for the same advisory lock, so they run one at a time. */
const ROLE_CHANGE_LOCK = 7_301_001

/**
 * What a list may be sorted by. The value is SQL that goes into the query, so it
 * comes from this table and never from the request — the request only chooses a
 * key.
 */
const SORTS = {
  created: 'u.created_at',
  email: 'lower(u.email)',
  jobs: 'jobs',
  credits: 'kie_credits',
  flags: 'open_events',
  storage: 'storage_bytes',
}

const numberOf = value => Number(value) || 0

const USER_COLUMNS = `
  u.id, u.email, u.display_name, u.role, u.status, u.suspended_at, u.suspended_reason,
  u.email_confirmed_at, u.created_at,
  (select count(*) from generation_jobs j where j.user_id = u.id) as jobs,
  (select coalesce(sum(j.kie_credits), 0) from generation_jobs j where j.user_id = u.id) as kie_credits,
  (select count(*) from moderation_events e where e.user_id = u.id and e.status = 'open') as open_events,
  (select coalesce(sum(a.byte_size), 0) from assets a where a.user_id = u.id) as storage_bytes`

function shape(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    suspendedAt: row.suspended_at,
    suspendedReason: row.suspended_reason,
    emailConfirmed: Boolean(row.email_confirmed_at),
    createdAt: row.created_at,
    jobs: numberOf(row.jobs),
    kieCredits: numberOf(row.kie_credits),
    openEvents: numberOf(row.open_events),
    storageBytes: numberOf(row.storage_bytes),
  }
}

/** The account the request names, or a 400/404. */
async function targetOf(req) {
  const { userId } = req.body || {}
  if (!isUuid(userId)) throw badRequest('userId is required.')
  const user = await one('select id, email, role, status from users where id = $1', [userId])
  if (!user) throw notFound('That account does not exist.')
  return user
}

const refuseSelf = (admin, target, what) => {
  if (admin.id === target.id) throw forbidden(`You cannot ${what} your own account.`, 'SELF_ACTION')
}

const refuseAdmin = (target, what) => {
  if (target.role === 'admin') throw forbidden(`Remove their admin role before you ${what} them.`, 'TARGET_IS_ADMIN')
}

export const list = adminRoute(async (req, res) => {
  const { page, pageSize, limit, offset } = pageOf(req)
  const q = queryText(req.query?.q, 100)
  const status = STATUSES.includes(req.query?.status) ? req.query.status : null
  const sortKey = typeof req.query?.sort === 'string' && Object.hasOwn(SORTS, req.query.sort) ? req.query.sort : 'created'
  const direction = req.query?.dir === 'asc' ? 'asc' : 'desc'

  const filter = `
    ($1::text is null or u.email ilike '%' || $1 || '%' escape '\\' or u.display_name ilike '%' || $1 || '%' escape '\\')
    and ($2::text is null or u.status = $2)`

  const rows = await many(
    `select ${USER_COLUMNS}
       from users u
      where ${filter}
      order by ${SORTS[sortKey]} ${direction}, u.id
      limit $3 offset $4`,
    [q === null ? null : likeTerm(q), status, limit, offset],
  )
  const { total } = await one(`select count(*)::int as total from users u where ${filter}`, [q === null ? null : likeTerm(q), status])

  noStore(res)
  res.json({ users: rows.map(shape), total, page, pageSize, sort: sortKey, dir: direction })
}, { tag: '[admin/users]', message: 'Unable to load accounts.' })

/** Everything a moderator wants to see before deciding something about one person. */
export const detail = adminRoute(async (req, res) => {
  const userId = req.query?.userId
  if (!isUuid(userId)) throw badRequest('userId is required.')

  const row = await one(`select ${USER_COLUMNS} from users u where u.id = $1`, [userId])
  if (!row) throw notFound('That account does not exist.')

  const cfg = moderationConfig()
  const [strikes, recentJobs, recentEvents, assets, devices, influencers, balance, recentCredits] = await Promise.all([
    countStrikes(userId, cfg.strikeWindowDays),
    many(
      `select id, kie_task_id, kind, model, state, fail_msg, kie_credits, created_at
         from generation_jobs where user_id = $1 order by created_at desc, id limit 8`,
      [userId],
    ),
    many(
      `select id, source, action, categories, status, excerpt, created_at
         from moderation_events where user_id = $1 order by created_at desc, id limit 8`,
      [userId],
    ),
    many(
      `select moderation_status as status, count(*)::int as n, coalesce(sum(byte_size), 0) as bytes
         from assets where user_id = $1 group by 1`,
      [userId],
    ),
    one(
      `select count(*)::int as active, max(last_used_at) as last_used_at
         from sessions where user_id = $1 and refresh_expires_at > now()`,
      [userId],
    ),
    one('select count(*)::int as n from influencers where user_id = $1', [userId]),
    balanceOf(userId),
    historyOf(userId, { limit: 8 }),
  ])

  const byStatus = { unchecked: 0, clear: 0, blocked: 0 }
  for (const a of assets) byStatus[a.status] = a.n

  noStore(res)
  res.json({
    user: shape(row),
    strikes: { count: strikes, limit: cfg.strikeLimit, windowDays: cfg.strikeWindowDays },
    devices: { active: devices.active, lastUsedAt: devices.last_used_at },
    influencers: influencers.n,
    credits: { balance, enforced: billingEnforced(), recent: recentCredits.map(shapeEntry) },
    assets: { byStatus, total: assets.reduce((n, a) => n + a.n, 0) },
    recentJobs: recentJobs.map(j => ({
      id: j.id, taskId: j.kie_task_id, kind: j.kind, model: j.model, state: j.state,
      failMessage: j.fail_msg, kieCredits: j.kie_credits === null ? null : Number(j.kie_credits), createdAt: j.created_at,
    })),
    recentEvents: recentEvents.map(e => ({
      id: e.id, source: e.source, action: e.action, categories: e.categories, status: e.status,
      excerpt: e.excerpt, createdAt: e.created_at,
    })),
  })
}, { tag: '[admin/users/detail]', message: 'Unable to load this account.' })

export const suspend = adminRoute(async (req, res, admin) => {
  const reason = requiredText(req.body?.reason, 'A reason', 300)
  const target = await targetOf(req)
  refuseSelf(admin, target, 'suspend')
  refuseAdmin(target, 'suspend')

  const changed = await transaction(async client => {
    const did = await suspendUser(target.id, `By ${admin.email}: ${reason}`, { client })
    await audit(admin, 'user.suspend', { targetType: 'user', targetId: target.id, details: { email: target.email, reason, changed: did } }, client)
    return did
  })
  res.json({ ok: true, changed })
}, { tag: '[admin/users/suspend]', message: 'Unable to suspend this account.' })

export const unsuspend = adminRoute(async (req, res, admin) => {
  const target = await targetOf(req)
  const changed = await transaction(async client => {
    const did = await unsuspendUser(target.id, { client })
    await audit(admin, 'user.unsuspend', { targetType: 'user', targetId: target.id, details: { email: target.email, changed: did } }, client)
    return did
  })
  res.json({ ok: true, changed })
}, { tag: '[admin/users/unsuspend]', message: 'Unable to restore this account.' })

export const setRole = adminRoute(async (req, res, admin) => {
  const role = req.body?.role
  if (!ROLES.includes(role)) throw badRequest(`role must be one of: ${ROLES.join(', ')}.`)
  const target = await targetOf(req)
  refuseSelf(admin, target, 'change the role of')

  const changed = await transaction(async client => {
    // Role changes take turns, and whoever makes one must still be an administrator when
    // their turn comes. Without this, two admins demoting each other at the same moment
    // would both succeed and leave nobody able to open this panel.
    await client.query('select pg_advisory_xact_lock($1)', [ROLE_CHANGE_LOCK])
    const { rowCount: stillAdmin } = await client.query(`select 1 from users where id = $1 and role = 'admin' and status = 'active'`, [admin.id])
    if (!stillAdmin) throw forbidden('This area is for administrators.', 'NOT_ADMIN')

    const { rowCount } = await client.query('update users set role = $2 where id = $1 and role <> $2', [target.id, role])
    await audit(admin, 'user.set-role', { targetType: 'user', targetId: target.id, details: { email: target.email, from: target.role, to: role } }, client)
    return rowCount > 0
  })
  res.json({ ok: true, changed })
}, { tag: '[admin/users/set-role]', message: 'Unable to change this role.' })

/**
 * Delete an account and everything in it — the same erasure the user gets from
 * "delete my account" (api/account/delete.js): files first, then the rows.
 * The admin must type the account's email, so a mis-click on a list cannot do it.
 */
export const remove = adminRoute(async (req, res, admin) => {
  const target = await targetOf(req)
  refuseSelf(admin, target, 'delete')
  refuseAdmin(target, 'delete')
  if (normalizeEmail(req.body?.confirmEmail) !== normalizeEmail(target.email)) {
    throw new HttpError(400, 'Type the account\'s email address exactly to confirm.', 'CONFIRMATION_MISMATCH')
  }

  const deletedObjects = await deleteUserObjects(target.id)
  await revokeAllSessions(target.id)
  await transaction(async client => {
    await client.query('delete from users where id = $1', [target.id])
    await audit(admin, 'user.delete', { targetType: 'user', targetId: target.id, details: { email: target.email, deletedObjects } }, client)
  })
  res.json({ ok: true, deletedObjects })
}, { tag: '[admin/users/delete]', message: 'Unable to delete this account.' })
