/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin: an account's credits.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   GET  /api/admin/billing/ledger?userId=&page=   an account's history, newest first
 *   POST /api/admin/billing/grant  { userId, credits, note }
 *
 * And, for the Credits page, the whole picture:
 *
 *   GET  /api/admin/billing/summary?days=          bought, spent, held, what KIE charged, products sold
 *   GET  /api/admin/billing/activity?kind=&q=      every credit movement of every account
 *   GET  /api/admin/billing/store-events?outcome=  what the store told us, and what became of it
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
import { adminRoute, audit, likeTerm, pageOf, queryText, requiredText } from '../_lib/admin.js'
import { badRequest, notFound, noStore } from '../_lib/http.js'
import { isUuid } from '../_lib/validate.js'
import { addEntry, balanceOf, billingEnforced, historyOf } from '../_lib/billing.js'

/** The kinds of row a ledger holds, in the order the panel offers them. */
const KINDS = ['purchase', 'spend', 'refund', 'grant', 'adjust', 'clawback']

/** What RevenueCat deliveries can come to (api/revenuecat-webhook.js). */
const OUTCOMES = ['credited', 'clawed_back', 'duplicate', 'ignored', 'unmatched', 'sandbox_off', 'test']

/**
 * A store delivery that should have turned into credits and did not: a purchase from nobody we know, a test
 * purchase while those are switched off, a purchase of a product we do not sell, or a paid SUBSCRIPTION event
 * (we sell no subscriptions, so whoever paid for one got nothing). Someone paid, so it is something to look
 * into. (`ignored` is also what an event type that is none of our business gets — an expiry, a billing
 * warning — and those are not problems.) Written for a `billing_events` row aliased `e`.
 */
export const STORE_PROBLEM = `(e.outcome in ('unmatched', 'sandbox_off')
  or (e.outcome = 'ignored' and e.type in ('NON_RENEWING_PURCHASE', 'CANCELLATION', 'INITIAL_PURCHASE', 'RENEWAL')))`

/** Whole UTC calendar days ending today, `$1` of them — the same window the overview's chart uses. */
const SINCE = `(date_trunc('day', now() at time zone 'UTC') - ($1::int - 1) * interval '1 day') at time zone 'UTC'`

const money = value => Math.round((Number(value) || 0) * 1000) / 1000

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

// ── The whole picture, for the Credits page ─────────────────────────────────

/**
 * What the credits business is doing: what people bought and spent over the last `days`, what they hold now,
 * what KIE charged us for the same period, and which store products sold. Counts and sums only.
 */
export const summary = adminRoute(async (req, res) => {
  const days = Math.min(90, Math.max(1, Math.floor(Number(req.query?.days)) || 30))
  const [window, holding, perDay, packs, cost] = await Promise.all([
    one(
      `select coalesce(sum(delta) filter (where kind = 'purchase'), 0) as purchased,
              count(*) filter (where kind = 'purchase')::int as purchases,
              count(distinct user_id) filter (where kind = 'purchase')::int as purchasers,
              coalesce(-sum(delta) filter (where kind = 'spend'), 0) as spent,
              coalesce(sum(delta) filter (where kind = 'refund'), 0) as refunded,
              coalesce(sum(delta) filter (where kind = 'grant'), 0) as granted,
              coalesce(sum(delta) filter (where kind = 'adjust'), 0) as adjusted,
              coalesce(-sum(delta) filter (where kind = 'clawback'), 0) as clawed_back
         from credit_ledger where created_at >= ${SINCE}`,
      [days],
    ),
    one(
      `with b as (select user_id, sum(delta) as balance from credit_ledger group by user_id)
       select coalesce(sum(balance) filter (where balance > 0), 0) as held,
              count(*) filter (where balance > 0)::int as holders,
              coalesce(-sum(balance) filter (where balance < 0), 0) as owed,
              count(*) filter (where balance < 0)::int as owing
         from b`,
    ),
    many(
      `select to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD') as day,
              coalesce(sum(delta) filter (where kind = 'purchase'), 0) as purchased,
              coalesce(-sum(delta) filter (where kind = 'spend'), 0) as spent
         from credit_ledger
        where created_at >= ${SINCE} and kind in ('purchase', 'spend')
        group by 1 order by 1`,
      [days],
    ),
    many(
      `select e.product_id, e.environment, p.label, count(*)::int as purchases, coalesce(sum(e.credits), 0) as credits
         from billing_events e left join credit_packs p on p.product_id = e.product_id
        where e.outcome = 'credited' and e.received_at >= ${SINCE}
        group by 1, 2, 3 order by credits desc, 1`,
      [days],
    ),
    one(`select coalesce(sum(kie_credits), 0) as cost from generation_jobs where completed_at >= ${SINCE}`, [days]),
  ])

  noStore(res)
  res.json({
    days,
    enforced: billingEnforced(),
    window: {
      purchased: money(window.purchased), purchases: window.purchases, purchasers: window.purchasers,
      spent: money(window.spent), refunded: money(window.refunded), granted: money(window.granted),
      adjusted: money(window.adjusted), clawedBack: money(window.clawed_back),
    },
    holding: { held: money(holding.held), holders: holding.holders, owed: money(holding.owed), owing: holding.owing },
    providerCost: money(cost.cost),
    series: perDay.map(r => ({ day: r.day, purchased: money(r.purchased), spent: money(r.spent) })),
    packs: packs.map(r => ({ productId: r.product_id, label: r.label, environment: r.environment, purchases: r.purchases, credits: money(r.credits) })),
  })
}, { tag: '[admin/billing/summary]', message: 'Unable to load the credits summary.' })

/**
 * Every change to every balance, newest first: `?kind=` narrows to one kind, `?q=` searches the account's
 * email, `?userId=` narrows to one account. (The per-account history, with its balance, is `ledger`.)
 */
export const activity = adminRoute(async (req, res) => {
  const { page, pageSize, limit, offset } = pageOf(req)
  const kind = KINDS.includes(req.query?.kind) ? req.query.kind : null
  const search = queryText(req.query?.q, 100)
  const q = search === null ? null : likeTerm(search)
  const userId = req.query?.userId || null
  if (userId !== null && !isUuid(userId)) throw badRequest('userId is not valid.')

  const filter = `
    ($1::text is null or l.kind = $1)
    and ($2::text is null or u.email ilike '%' || $2 || '%' escape '\\')
    and ($3::uuid is null or l.user_id = $3::uuid)`
  const args = [kind, q, userId]

  const rows = await many(
    `select l.id, l.user_id, u.email, l.kind, l.delta, l.note, l.model, l.kie_task_id, l.created_at, a.email as created_by_email
       from credit_ledger l
       join users u on u.id = l.user_id
       left join users a on a.id = l.created_by
      where ${filter}
      order by l.id desc
      limit $4 offset $5`,
    [...args, limit, offset],
  )
  const { total } = await one(`select count(*)::int as total from credit_ledger l join users u on u.id = l.user_id where ${filter}`, args)

  noStore(res)
  res.json({ entries: rows.map(r => ({ ...shapeEntry(r), userId: r.user_id, email: r.email })), total, page, pageSize })
}, { tag: '[admin/billing/activity]', message: 'Unable to load the credit activity.' })

/**
 * What the store (through RevenueCat) has told us: one row per delivery, and what we did with it. This is where
 * "I paid and got nothing" is answered. `?outcome=` narrows to one outcome, `?problems=1` to the ones to look into.
 */
export const storeEvents = adminRoute(async (req, res) => {
  const { page, pageSize, limit, offset } = pageOf(req)
  const outcome = OUTCOMES.includes(req.query?.outcome) ? req.query.outcome : null
  const problemsOnly = req.query?.problems === '1'

  const filter = `($1::text is null or e.outcome = $1) and ($2::boolean is not true or ${STORE_PROBLEM})`
  const args = [outcome, problemsOnly]

  const rows = await many(
    `select e.id, e.type, e.product_id, e.environment, e.transaction_id, e.outcome, e.credits, e.received_at, e.user_id, u.email,
            ${STORE_PROBLEM} as problem
       from billing_events e left join users u on u.id = e.user_id
      where ${filter}
      order by e.received_at desc, e.id
      limit $3 offset $4`,
    [...args, limit, offset],
  )
  const { total } = await one(`select count(*)::int as total from billing_events e where ${filter}`, args)

  noStore(res)
  res.json({
    events: rows.map(r => ({
      id: r.id, type: r.type, productId: r.product_id, environment: r.environment, transactionId: r.transaction_id,
      outcome: r.outcome, credits: r.credits === null ? null : money(r.credits), problem: Boolean(r.problem),
      userId: r.user_id, email: r.email, receivedAt: r.received_at,
    })),
    total, page, pageSize,
  })
}, { tag: '[admin/billing/store-events]', message: 'Unable to load the store deliveries.' })
