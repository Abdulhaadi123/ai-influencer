/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Credits — the ledger, the price of a generation, and the gate in front of KIE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The model is KIE's own: prepaid credits, bought in packs, spent per generation by
 * the model's price, taken only for work that succeeds, and never expiring.
 *
 *   • A balance is the SUM of an account's ledger rows (migration 005). Nothing
 *     stores it, so nothing can disagree with it.
 *   • The price of a request comes from `model_prices` (the admin panel edits it):
 *     `credits` per video, per image, or per second — of `input.duration`, or, for a
 *     request that carries a video, of that video as the SERVER measures it
 *     (clipLength.js). A model can also have a row per `mode` (prices.js).
 *   • The price is TAKEN when the request is accepted, before KIE is asked — inside
 *     a transaction that holds a per-account lock, so five requests at once cannot
 *     each see the same balance and all go through. If KIE then refuses (or never
 *     answers), the spend is given back at once; if the job later fails, it is given
 *     back when the failure is recorded (kieStatus.js); and a spend whose request
 *     never got an answer is given back by the worker (sweepUnsettledSpends).
 *     Every give-back is keyed on its spend row, so doing it twice does nothing.
 *
 * ── Shadow mode ──────────────────────────────────────────────────────────────
 *
 * Until BILLING_ENFORCED=true nothing is taken and nobody is stopped. The gate still
 * works out the price and the balance, and says in the log (`[billing] shadow:`) who
 * it WOULD have stopped and which models have no price — so the switch can be
 * thrown knowing what it will do.
 *
 * ── When enforced ────────────────────────────────────────────────────────────
 *
 *   • a model with no price row is refused (an unpriced model must not be free by
 *     accident); a row with `credits = 0` is an explicit, free model;
 *   • not enough credits is HTTP 402 `INSUFFICIENT_CREDITS` with the balance and the price;
 *   • administrators pay like anyone else — grant them credits from the panel (audited).
 */

import { randomUUID } from 'node:crypto'

import { one, many, query, transaction } from './db.js'
import { HttpError } from './http.js'
import { modeOf, priceKeys } from './prices.js'
import { clipSecondsOf, ClipError, MAX_CLIP_SECONDS } from './clipLength.js'

/** Is the gate switched on? Anything but the exact word `true` is off. */
export function billingEnforced(env = process.env) {
  return String(env.BILLING_ENFORCED ?? '').toLowerCase() === 'true'
}

export const INSUFFICIENT_MESSAGE = 'You do not have enough credits for this. Please buy a credit pack to continue.'
export const UNPRICED_MESSAGE = 'This model is not available right now. Please choose a different one.'

/** A refusal the proxy sends as it is written (it carries the numbers the app shows). */
export class BillingRefusal extends HttpError {
  constructor(status, message, code, extra = {}) {
    super(status, message, code)
    this.name = 'BillingRefusal'
    this.body = { error: message, code, ...extra }
  }
}

const round3 = n => Math.round(n * 1000) / 1000
const asNumber = value => Number(value ?? 0)

// ── Balances and the ledger ──────────────────────────────────────────────────

/** What the account has now. `run` lets a caller read it inside its own transaction. */
export async function balanceOf(userId, run = query) {
  const { rows } = await run('select coalesce(sum(delta), 0) as balance from credit_ledger where user_id = $1', [userId])
  return round3(asNumber(rows[0]?.balance))
}

/**
 * Add one row, once. `ref` is the idempotency key: a row with the same ref is not
 * added again, and `inserted` says which happened.
 *
 * @param {{userId: string, kind: string, delta: number, ref?: string|null, taskId?: string|null,
 *          model?: string|null, note?: string|null, createdBy?: string|null}} entry
 * @param {{query: Function}} [client]  a transaction client, to make the row part of one
 * @returns {Promise<{inserted: boolean, id: string|null}>}
 */
export async function addEntry({ userId, kind, delta, ref = null, taskId = null, model = null, note = null, createdBy = null }, client = null) {
  const run = client ? (text, params) => client.query(text, params) : query
  const { rows } = await run(
    `insert into credit_ledger (user_id, kind, delta, ref, kie_task_id, model, note, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (ref) do nothing
     returning id`,
    [userId, kind, round3(delta), ref, taskId, model, note ? String(note).slice(0, 500) : null, createdBy],
  )
  return { inserted: rows.length > 0, id: rows[0]?.id ?? null }
}

/** One account's history, newest first. */
export function historyOf(userId, { limit = 20, offset = 0 } = {}) {
  return many(
    `select l.id, l.kind, l.delta, l.note, l.model, l.kie_task_id, l.created_at, a.email as created_by_email
       from credit_ledger l
       left join users a on a.id = l.created_by
      where l.user_id = $1
      order by l.id desc
      limit $2 offset $3`,
    [userId, limit, offset],
  )
}

/** Serialises everything that spends or reads-then-spends for one account. */
async function lockAccount(client, userId) {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1::text, 5))', [userId])
}

// ── What a request costs ─────────────────────────────────────────────────────

/** Seconds a request asks for (`input.duration`, a number or a numeric string), or null. */
function secondsOf(payload) {
  const raw = payload?.input?.duration ?? payload?.duration
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_CLIP_SECONDS ? n : null
}

/**
 * The seconds a measured clip is billed as: whole seconds, rounded up — KIE bills a
 * clip by the second. A container's reported length often carries a few milliseconds
 * over the true one (4.0003 s for a 4 s clip), which must not cost a whole extra second,
 * so up to 50 ms over is not counted.
 */
export const billedSeconds = clip => Math.max(1, Math.ceil(clip - 0.05))

/**
 * The price of a createTask / veo body, from the price list.
 *
 * A per-second price is applied to the longer of the duration the request names and the
 * length of the video it carries (`measureClip`): a model such as Kling Motion Control
 * bills the video, ignores any `duration`, and a client must not be able to pay for one
 * second by writing one.
 *
 * @param {object} payload
 * @param {{measureClip?: () => Promise<number|null>}} [opts]  how to measure the request's video, if it has one
 * @returns {Promise<{amount: number, unit: string, model: string, seconds?: number, rate?: number} | null>}
 *          null when the model has no price row, or a per-second price cannot be
 *          applied because the request names no usable duration and carries no video
 * @throws {ClipError}  the request carries a video whose length cannot be established
 */
export async function priceOf(payload, { measureClip } = {}) {
  const model = payload?.model
  const keys = priceKeys(model, modeOf(payload))
  if (!keys.length) return null

  const rows = await many('select model, credits, unit from model_prices where model = any($1::text[])', [keys])
  const row = keys.map(k => rows.find(r => r.model === k)).find(Boolean)   // the mode's own row beats the model's
  if (!row) return null

  const credits = asNumber(row.credits)
  if (row.unit === 'per_second') {
    const named = secondsOf(payload)
    const clip = measureClip ? await measureClip() : null
    const seconds = Math.max(named ?? 0, clip === null ? 0 : billedSeconds(clip)) || null
    if (seconds === null) return null
    return { amount: round3(credits * seconds), unit: row.unit, model, seconds, rate: credits }
  }
  return { amount: round3(credits), unit: row.unit, model }
}

// ── The gate ─────────────────────────────────────────────────────────────────

/**
 * Called before a paid request goes to KIE.
 *
 * @param {{user: {id: string, email?: string}, payload: object}} args
 * @returns {Promise<{id: string, amount: number} | null>}  the spend that was taken, to be
 *          attached to the task or given back; null when nothing was taken
 * @throws {BillingRefusal}  only when billing is enforced
 */
export async function reserve({ user, payload }) {
  let price = null
  try {
    price = await priceOf(payload, { measureClip: () => clipSecondsOf({ user, payload }) })
  } catch (e) {
    if (!(e instanceof ClipError)) throw e
    // A video whose length is not known cannot be priced. Enforced: the person is told why.
    // Shadow: nothing is stopped, but the log says it would have been.
    if (billingEnforced()) throw new BillingRefusal(e.status, e.message, e.code)
    console.warn(`[billing] shadow: the video of a ${JSON.stringify(payload?.model)} request could not be measured (${e.code}) — it would be refused`)
    return null
  }

  if (!billingEnforced()) {
    await reportShadow(user, payload, price)
    return null
  }
  if (!price) throw new BillingRefusal(403, UNPRICED_MESSAGE, 'MODEL_UNAVAILABLE')
  if (price.amount === 0) return null

  return transaction(async client => {
    await lockAccount(client, user.id)
    const balance = await balanceOf(user.id, (text, params) => client.query(text, params))
    if (balance < price.amount) {
      throw new BillingRefusal(402, INSUFFICIENT_MESSAGE, 'INSUFFICIENT_CREDITS', { balance, price: price.amount })
    }
    const { id } = await addEntry({
      userId: user.id, kind: 'spend', delta: -price.amount, ref: `spend:${randomUUID()}`, model: price.model, note: spendNote(price),
    }, client)
    return { id, amount: price.amount }
  })
}

/** What the ledger says about a spend: for a per-second price, the sum behind it. */
const spendNote = price =>
  price.unit === 'per_second' && price.seconds ? `Generation started (${price.seconds} s × ${price.rate})` : 'Generation started'

/** What the gate would have done, written for whoever is deciding whether to switch it on. */
async function reportShadow(user, payload, price) {
  try {
    if (!price) {
      console.warn(`[billing] shadow: no usable price for model ${JSON.stringify(payload?.model)} — it would be refused`)
      return
    }
    const balance = await balanceOf(user.id)
    if (balance < price.amount) {
      console.warn(`[billing] shadow: account ${user.id} has ${balance} credits, ${price.model} costs ${price.amount} — it would be refused`)
    }
  } catch (e) {
    console.warn('[billing] shadow report failed:', e?.message ?? e)
  }
}

/** KIE accepted the request: remember which task the spend was for. */
export async function attachTask(spendId, taskId) {
  if (!spendId || !taskId) return
  await query('update credit_ledger set kie_task_id = $2 where id = $1 and kie_task_id is null', [spendId, String(taskId).slice(0, 200)])
}

/** Give one spend back — once, however many times this is asked. */
export async function giveBack(spendId, note) {
  const spend = await one(`select id, user_id, delta, model, kie_task_id from credit_ledger where id = $1 and kind = 'spend'`, [spendId])
  if (!spend) return { refunded: 0 }
  const amount = -asNumber(spend.delta)
  const { inserted } = await addEntry({
    userId: spend.user_id, kind: 'refund', delta: amount, ref: `refund:${spend.id}`, taskId: spend.kie_task_id, model: spend.model, note,
  })
  return { refunded: inserted ? amount : 0 }
}

/**
 * The task failed: whatever was taken for it goes back. Never throws — it runs while a
 * failure is being recorded, and a billing hiccup must not undo or hide that.
 */
export async function refundTask(userId, taskId, note = 'Generation failed') {
  try {
    if (!userId || !taskId) return { refunded: 0 }
    const spends = await many(`select id from credit_ledger where user_id = $1 and kie_task_id = $2 and kind = 'spend'`, [userId, taskId])
    let refunded = 0
    for (const s of spends) refunded += (await giveBack(s.id, note)).refunded
    return { refunded }
  } catch (e) {
    console.error('[billing] could not refund a failed task:', e?.message ?? e)
    return { refunded: 0 }
  }
}

/**
 * Spends whose request got no answer from KIE (the connection dropped, the server
 * restarted) are given back after a grace period. The task, if KIE did start one, is
 * unknown to us and cannot be collected anyway — the same limit the queue always had.
 */
export async function sweepUnsettledSpends({ olderThanMinutes = 10, limit = 50 } = {}) {
  const stale = await many(
    `select id from credit_ledger
      where kind = 'spend' and kie_task_id is null and created_at < now() - $1::int * interval '1 minute'
      order by created_at
      limit $2`,
    [olderThanMinutes, limit],
  )
  let refunded = 0
  for (const s of stale) refunded += (await giveBack(s.id, 'The request never reached the generator')).refunded
  return { checked: stale.length, refunded }
}

// ── What the app is told ─────────────────────────────────────────────────────

/** The price list and credit packs a signed-in app shows. */
export async function catalog() {
  const [prices, packs] = await Promise.all([
    many(`select model, label, unit, credits from model_prices where enabled order by model`),
    many(`select product_id, credits, label from credit_packs where enabled order by credits`),
  ])
  return {
    prices: prices.map(p => ({ model: p.model, label: p.label, unit: p.unit, credits: asNumber(p.credits) })),
    packs: packs.map(p => ({ productId: p.product_id, credits: asNumber(p.credits), label: p.label })),
  }
}
