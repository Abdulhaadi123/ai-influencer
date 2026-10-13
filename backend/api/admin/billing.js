/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin: an account's credits.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   GET  /api/admin/billing/ledger?userId=&page=   an account's history, newest first
 *   POST /api/admin/billing/grant  { userId, credits, note }
 *
 * `grant` is how credits get on an account without a purchase — a reviewer's test
 * account, a support gesture, a correction. A positive amount is recorded as a
 * `grant`, a negative one as an `adjust`; both carry who did it and why, and both
 * land in the audit log in the same transaction, so a balance never moves without a
 * record of the person who moved it.
 *
 * A balance may be taken below zero: that is what a refunded purchase does too, and
 * it simply blocks spending until credits are added.
 */

import { randomUUID } from 'node:crypto'

import { one, many, transaction } from '../_lib/db.js'
import { adminRoute, audit, pageOf, requiredText } from '../_lib/admin.js'
import { badRequest, notFound, noStore } from '../_lib/http.js'
import { isUuid } from '../_lib/validate.js'
import { addEntry, balanceOf, historyOf } from '../_lib/billing.js'

/** One grant or correction is at most this many credits, either way — a typo guard. */
export const MAX_GRANT = 1_000_000

/** A ledger row as the panel reads it. (`id` is a bigint, which the database driver sends as text.) */
export const shapeEntry = r => ({
  id: String(r.id),
  kind: r.kind,
  delta: Number(r.delta),
  note: r.note,
  model: r.model,
  taskId: r.kie_task_id,
  by: r.created_by_email ?? null,
  createdAt: r.created_at,
})

export const ledger = adminRoute(async (req, res) => {
  const userId = req.query?.userId
  if (!isUuid(userId)) throw badRequest('userId is required.')
  if (!(await one('select 1 from users where id = $1', [userId]))) throw notFound('That account does not exist.')

  const { page, pageSize, limit, offset } = pageOf(req, { defaultSize: 25 })
  const [rows, total, balance] = await Promise.all([
    historyOf(userId, { limit, offset }),
    one('select count(*)::int as n from credit_ledger where user_id = $1', [userId]),
    balanceOf(userId),
  ])
  noStore(res)
  res.json({ entries: rows.map(shapeEntry), total: total.n, page, pageSize, balance })
}, { tag: '[admin/billing/ledger]', message: 'Unable to load the credit history.' })

export const grant = adminRoute(async (req, res, admin) => {
  const { userId } = req.body || {}
  if (!isUuid(userId)) throw badRequest('userId is required.')

  const raw = req.body?.credits
  const credits = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof credits !== 'number' || !Number.isFinite(credits) || credits === 0 || Math.abs(credits) > MAX_GRANT) {
    throw badRequest(`credits must be a number other than 0, no larger than ${MAX_GRANT.toLocaleString('en-US')} either way.`)
  }
  const amount = Math.round(credits * 1000) / 1000
  if (amount === 0) throw badRequest('credits must be at least 0.001.')
  const note = requiredText(req.body?.note, 'The note', 300)

  const balance = await transaction(async client => {
    const { rows } = await client.query('select email from users where id = $1', [userId])
    if (!rows.length) throw notFound('That account does not exist.')

    const kind = amount > 0 ? 'grant' : 'adjust'
    await addEntry({ userId, kind, delta: amount, ref: `admin:${randomUUID()}`, note, createdBy: admin.id }, client)
    await audit(admin, 'billing.grant', { targetType: 'user', targetId: userId, details: { credits: amount, kind, note, email: rows[0].email } }, client)
    return balanceOf(userId, (text, params) => client.query(text, params))
  })

  noStore(res)
  res.json({ ok: true, balance })
}, { tag: '[admin/billing/grant]', message: 'Unable to change the credits.' })
