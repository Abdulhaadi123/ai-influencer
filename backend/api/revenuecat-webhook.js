/**
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /webhooks/revenuecat — a purchase (or a refund) reported by RevenueCat.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Outside `/api` for the same reason as KIE's callback (api/kie-callback.js): it carries
 * no user session, only a shared secret.
 *
 * ── How it proves the sender ─────────────────────────────────────────────────
 *
 * RevenueCat sends, with every delivery, the `Authorization` header value typed into
 * its dashboard. It must equal REVENUECAT_WEBHOOK_AUTH. With that unset the endpoint
 * refuses everything (503): an endpoint that adds credits must never be open.
 *
 * ── What it does with a delivery ─────────────────────────────────────────────
 *
 *   NON_RENEWING_PURCHASE   a pack was bought (a consumable): the credits go on the
 *                           account, once per store transaction.
 *   CANCELLATION            a purchase was refunded: the same credits come back off.
 *   TEST                    RevenueCat's "send test event": recorded, nothing else.
 *   anything else           recorded and ignored. There are no subscription products, so
 *                           nothing acts on a subscription event — but a paid one
 *                           (INITIAL_PURCHASE, RENEWAL) means someone paid for something we do
 *                           not deliver, so the admin panel lists it under "Needs a look"
 *                           (api/admin/billing.js, STORE_PROBLEM) instead of leaving it unseen.
 *
 * ── The product id ───────────────────────────────────────────────────────────
 *
 * Google Play can report a product as `credits_500` or, for a product with purchase options
 * or a base plan, as `credits_500:<option-id>`. Both are the same pack, so the id is cut at
 * the first colon before it is looked up (the app does the same: core/billing/packs.js).
 * The id exactly as the store sent it is what is recorded, so nothing about it is hidden.
 *
 * Deliveries are at-least-once and unordered, so: the event id is the first thing
 * written (a second delivery of it stops there), and credits are keyed on the STORE
 * transaction id, so the same purchase arriving as two different events still
 * credits once. Everything for one delivery happens in one transaction: if anything
 * fails, nothing is kept and the answer is 500, so RevenueCat retries (5 times over
 * about two and a half hours).
 *
 * Whose purchase it was comes from `app_user_id` — the app signs in to RevenueCat with
 * our own account id, never an anonymous one. A purchase with no account of ours
 * behind it is recorded as `unmatched` for a person to look at, and answered 200:
 * retrying would not make the account appear.
 *
 * ── Not yet done ─────────────────────────────────────────────────────────────
 *
 * RevenueCat recommends confirming a delivery by asking its REST API for the
 * subscriber. That needs the secret API key and a real sandbox purchase to build
 * against, so it comes with the first real test; today the shared secret is the proof.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

import { transaction } from './_lib/db.js'
import { addEntry } from './_lib/billing.js'
import { isUuid } from './_lib/validate.js'
import { createRateLimiter } from '../lib/rateLimit.js'

export const REVENUECAT_PATH = '/webhooks/revenuecat'

/** Deliveries all come from RevenueCat; this only caps a flood of forgeries. */
const byIp = createRateLimiter([{ windowMs: 10_000, max: 120 }])

const secret = () => (process.env.REVENUECAT_WEBHOOK_AUTH || '').trim()

/** Are test purchases (RevenueCat's SANDBOX environment) credited? Off it at launch. */
const acceptSandbox = () => String(process.env.REVENUECAT_ACCEPT_SANDBOX ?? 'true').toLowerCase() !== 'false'

export function revenueCatConfigured() {
  return secret() !== ''
}

/** Constant-time compare of two strings of any length (hashed first, so the length leaks nothing). */
function sameSecret(expected, received) {
  const a = createHash('sha256').update(String(expected)).digest()
  const b = createHash('sha256').update(String(received ?? '').trim()).digest()
  return timingSafeEqual(a, b)
}

const text = (value, max = 200) => (typeof value === 'string' && value ? value.slice(0, max) : null)

/** "credits_500", whether the store reports it as that or as "credits_500:base-plan". */
export const packIdOf = productId => (typeof productId === 'string' ? productId.split(':')[0] : '')

/** The account a purchase belongs to: the first id RevenueCat knows it by that is one of ours. */
async function accountFor(event, client) {
  const candidates = [event.app_user_id, event.original_app_user_id, ...(Array.isArray(event.aliases) ? event.aliases : [])]
    .filter(id => typeof id === 'string' && isUuid(id))
  if (!candidates.length) return null
  const { rows } = await client.query('select id from users where id = any($1::uuid[])', [candidates])
  const known = new Set(rows.map(r => r.id))
  return candidates.find(id => known.has(id)) ?? null
}

/** Apply one event inside the caller's transaction. @returns {Promise<{outcome: string, userId?: string, credits?: number}>} */
async function apply(event, client) {
  const type = String(event.type)
  if (type === 'TEST') return { outcome: 'test' }
  if (type !== 'NON_RENEWING_PURCHASE' && type !== 'CANCELLATION') return { outcome: 'ignored' }

  const userId = await accountFor(event, client)
  if (!userId) return { outcome: 'unmatched' }

  const transactionId = text(event.transaction_id) || text(event.original_transaction_id)

  if (type === 'NON_RENEWING_PURCHASE') {
    if (String(event.environment).toUpperCase() === 'SANDBOX' && !acceptSandbox()) return { outcome: 'sandbox_off', userId }

    const { rows } = await client.query('select credits from credit_packs where product_id = $1 and enabled', [packIdOf(text(event.product_id))])
    if (!rows.length) return { outcome: 'ignored', userId }
    const credits = Number(rows[0].credits)

    const sandbox = String(event.environment).toUpperCase() === 'SANDBOX'
    const { inserted } = await addEntry({
      userId, kind: 'purchase', delta: credits,
      ref: `purchase:${transactionId || `event-${event.id}`}`,
      model: null, note: `${event.product_id}${sandbox ? ' (test purchase)' : ''}`,
    }, client)
    return inserted ? { outcome: 'credited', userId, credits } : { outcome: 'duplicate', userId }
  }

  // CANCELLATION: only a purchase we credited can be taken back.
  if (!transactionId) return { outcome: 'ignored', userId }
  const { rows } = await client.query(`select delta from credit_ledger where ref = $1 and user_id = $2 and kind = 'purchase'`, [`purchase:${transactionId}`, userId])
  if (!rows.length) return { outcome: 'ignored', userId }
  const credits = Number(rows[0].delta)
  const { inserted } = await addEntry({
    userId, kind: 'clawback', delta: -credits, ref: `clawback:${transactionId}`, note: `Refunded purchase ${transactionId}`,
  }, client)
  return inserted ? { outcome: 'clawed_back', userId, credits } : { outcome: 'duplicate', userId }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' })

  const limit = byIp(`ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`)
  if (!limit.ok) return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' })

  if (!revenueCatConfigured()) {
    console.error('[revenuecat] REVENUECAT_WEBHOOK_AUTH is not set — refusing deliveries')
    return res.status(503).json({ error: 'Not configured', code: 'WEBHOOK_NOT_CONFIGURED' })
  }
  if (!sameSecret(secret(), req.headers?.authorization)) {
    return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' })
  }

  const event = req.body?.event
  if (!event || typeof event !== 'object' || typeof event.id !== 'string' || !event.id || typeof event.type !== 'string') {
    return res.status(400).json({ error: 'Not a RevenueCat event', code: 'BAD_EVENT' })
  }

  try {
    const result = await transaction(async client => {
      // The event id first: a second delivery of the same event stops right here.
      const { rows } = await client.query(
        `insert into billing_events (id, type, product_id, environment, transaction_id, outcome)
         values ($1, $2, $3, $4, $5, 'processing')
         on conflict (id) do nothing
         returning id`,
        [event.id.slice(0, 200), event.type.slice(0, 80), text(event.product_id), text(event.environment, 20), text(event.transaction_id)],
      )
      if (!rows.length) return { outcome: 'duplicate_event' }

      const done = await apply(event, client)
      await client.query(
        `update billing_events set outcome = $2, user_id = $3, credits = $4, details = $5::jsonb where id = $1`,
        [event.id.slice(0, 200), done.outcome, done.userId ?? null, done.credits ?? null, JSON.stringify({ app_user_id: text(event.app_user_id) })],
      )
      return done
    })
    if (result.outcome === 'unmatched') console.warn(`[revenuecat] purchase with no account of ours (event ${event.id}, app_user_id ${text(event.app_user_id)})`)
    return res.status(200).json({ ok: true, outcome: result.outcome })
  } catch (e) {
    console.error('[revenuecat] could not process event', event.id, e?.message ?? e)
    return res.status(500).json({ error: 'Could not process this event', code: 'PROCESSING_FAILED' })
  }
}
