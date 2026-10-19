// POST /webhooks/revenuecat — a purchase, or a refund, reported by RevenueCat.
//
// The payloads follow RevenueCat's documented event shape: `{ api_version, event: { id, type,
// app_user_id, product_id, transaction_id, environment, ... } }`. The pack products are the three
// created in its Test Store (migration 005 seeds what each is worth).

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { startStack } from '../helpers/stack.js'

const AUTH = 'rc-webhook-test-auth-value'
let stack
let n = 0

before(async () => { stack = await startStack({ env: { REVENUECAT_WEBHOOK_AUTH: AUTH } }) })
after(async () => { await stack?.stop() })
beforeEach(async () => {
  await stack.reset()
  process.env.REVENUECAT_WEBHOOK_AUTH = AUTH
  delete process.env.REVENUECAT_ACCEPT_SANDBOX
})

/** A delivery as RevenueCat sends it. */
const purchase = (user, over = {}) => ({
  api_version: '1.0',
  event: {
    id: randomUUID(), type: 'NON_RENEWING_PURCHASE', app_user_id: user.id, original_app_user_id: user.id, aliases: [user.id],
    product_id: 'credits_500', transaction_id: `GPA.3300-${++n}`, environment: 'PRODUCTION', event_timestamp_ms: Date.now(), ...over,
  },
})
const deliver = (body, authorization = AUTH) => stack.api('POST', '/webhooks/revenuecat', { body, headers: authorization === null ? {} : { authorization } })
const balance = async user => (await stack.api('GET', '/api/billing/me', { token: user.token })).body.balance
const recorded = () => stack.sql('select id, type, outcome, credits::float8 as credits, user_id, transaction_id, environment from billing_events order by received_at, id')
const ledger = userId => stack.sql(`select kind, delta::float8 as delta, ref, note from credit_ledger where user_id = $1 order by id`, [userId])

// ── Who may call it ──────────────────────────────────────────────────────────

test('without its secret configured the endpoint refuses everything — an open endpoint that adds credits is never allowed', async () => {
  const u = await stack.createUser()
  delete process.env.REVENUECAT_WEBHOOK_AUTH
  const res = await deliver(purchase(u), AUTH)
  assert.equal(res.status, 503)
  assert.equal(await balance(u), 0)
  process.env.REVENUECAT_WEBHOOK_AUTH = '   '
  assert.equal((await deliver(purchase(u), '')).status, 503, 'a blank secret is not a secret')
})

test('a missing or wrong Authorization header is refused and changes nothing', async () => {
  const u = await stack.createUser()
  for (const header of [null, '', 'wrong', `${AUTH}x`, `x${AUTH}`, `Bearer ${AUTH}`, AUTH.toUpperCase()]) {
    assert.equal((await deliver(purchase(u), header)).status, 401, JSON.stringify(header))
  }
  assert.equal(await balance(u), 0)
  assert.deepEqual(await recorded(), [], 'a forged delivery is not even recorded')
})

test('only POST is answered', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await stack.api(method, '/webhooks/revenuecat', { headers: { authorization: AUTH } })
    assert.equal(res.status, 405, method)
  }
})

test('a body that is not a RevenueCat event is a 400', async () => {
  for (const body of [{}, { event: null }, { event: 'x' }, { event: {} }, { event: { id: 5, type: 'TEST' } }, { event: { id: 'a' } }, { event: { id: '', type: 'TEST' } }, [], 'text']) {
    const res = await deliver(body)
    assert.equal(res.status, 400, JSON.stringify(body))
  }
})

// ── A purchase ───────────────────────────────────────────────────────────────

test('a pack that was bought is credited, and the delivery is on record', async () => {
  const u = await stack.createUser()
  const res = await deliver(purchase(u, { product_id: 'credits_1500', transaction_id: 'GPA.1' }))
  assert.equal(res.status, 200)
  assert.equal(res.body.outcome, 'credited')
  assert.equal(await balance(u), 1500)

  const rows = await ledger(u.id)
  assert.deepEqual(rows.map(r => [r.kind, r.delta, r.ref]), [['purchase', 1500, 'purchase:GPA.1']])
  const [event] = await recorded()
  assert.deepEqual([event.type, event.outcome, event.credits, event.user_id, event.transaction_id], ['NON_RENEWING_PURCHASE', 'credited', 1500, u.id, 'GPA.1'])
})

test('each of the three packs is worth what the table says', async () => {
  const u = await stack.createUser()
  for (const product_id of ['credits_500', 'credits_1500', 'credits_5000']) await deliver(purchase(u, { product_id }))
  assert.equal(await balance(u), 7000)
})

test('the same delivery arriving again (RevenueCat retries) credits once', async () => {
  const u = await stack.createUser()
  const body = purchase(u)
  assert.equal((await deliver(body)).body.outcome, 'credited')
  const again = await deliver(body)
  assert.equal(again.status, 200, 'answered 200 so it stops retrying')
  assert.equal(again.body.outcome, 'duplicate_event')
  assert.equal(await balance(u), 500)
  assert.equal((await recorded()).length, 1)
})

test('the same store purchase reported under a different event id still credits once', async () => {
  const u = await stack.createUser()
  assert.equal((await deliver(purchase(u, { transaction_id: 'GPA.same' }))).body.outcome, 'credited')
  const second = await deliver(purchase(u, { transaction_id: 'GPA.same' }))
  assert.equal(second.body.outcome, 'duplicate')
  assert.equal(await balance(u), 500)
})

test('two purchases of the same pack are two purchases', async () => {
  const u = await stack.createUser()
  await deliver(purchase(u))
  await deliver(purchase(u))
  assert.equal(await balance(u), 1000)
})

test('a purchase with no transaction id is still credited once, keyed on its event id', async () => {
  const u = await stack.createUser()
  const body = purchase(u, { transaction_id: undefined })
  await deliver(body)
  await deliver(body)
  assert.equal(await balance(u), 500)
})

test('the credits go to the account RevenueCat names — and only that one', async () => {
  const buyer = await stack.createUser()
  const other = await stack.createUser()
  await deliver(purchase(buyer))
  assert.equal(await balance(buyer), 500)
  assert.equal(await balance(other), 0)
})

test('a purchase made under an anonymous id is matched through its aliases, when one of them is ours', async () => {
  const u = await stack.createUser()
  const res = await deliver(purchase(u, { app_user_id: '$RCAnonymousID:abc123', original_app_user_id: '$RCAnonymousID:abc123', aliases: ['$RCAnonymousID:abc123', u.id] }))
  assert.equal(res.body.outcome, 'credited')
  assert.equal(await balance(u), 500)
})

test('a purchase nobody here owns is answered 200 and kept for a person to look at', async () => {
  for (const id of ['$RCAnonymousID:zzz', randomUUID(), 'not-an-id', '']) {
    const res = await deliver(purchase({ id }, { aliases: [] }))
    assert.equal(res.status, 200, JSON.stringify(id))
    assert.equal(res.body.outcome, 'unmatched')
  }
  const rows = await recorded()
  assert.equal(rows.length, 4)
  assert.ok(rows.every(r => r.outcome === 'unmatched' && r.user_id === null))
})

test('a product that is not a credit pack (or has been switched off) is recorded and ignored', async () => {
  const u = await stack.createUser()
  assert.equal((await deliver(purchase(u, { product_id: 'consumable' }))).body.outcome, 'ignored')
  assert.equal((await deliver(purchase(u, { product_id: undefined }))).body.outcome, 'ignored')

  await stack.sql(`update credit_packs set enabled = false where product_id = 'credits_500'`)
  assert.equal((await deliver(purchase(u, { product_id: 'credits_500' }))).body.outcome, 'ignored')
  await stack.sql(`update credit_packs set enabled = true where product_id = 'credits_500'`)
  assert.equal(await balance(u), 0)
})

test('test purchases are credited by default, and not once sandbox purchases are switched off', async () => {
  const u = await stack.createUser()
  const sandbox = await deliver(purchase(u, { environment: 'SANDBOX' }))
  assert.equal(sandbox.body.outcome, 'credited')
  assert.match((await ledger(u.id))[0].note, /test purchase/)

  process.env.REVENUECAT_ACCEPT_SANDBOX = 'false'
  assert.equal((await deliver(purchase(u, { environment: 'SANDBOX' }))).body.outcome, 'sandbox_off')
  assert.equal((await deliver(purchase(u, { environment: 'PRODUCTION' }))).body.outcome, 'credited', 'real purchases are unaffected')
  assert.equal(await balance(u), 1000)
})

// ── A refund ─────────────────────────────────────────────────────────────────

test('a refunded purchase takes its credits back, once', async () => {
  const u = await stack.createUser()
  await deliver(purchase(u, { product_id: 'credits_1500', transaction_id: 'GPA.refund' }))
  const cancel = () => deliver(purchase(u, { type: 'CANCELLATION', transaction_id: 'GPA.refund', product_id: 'credits_1500', cancel_reason: 'CUSTOMER_SUPPORT' }))
  assert.equal((await cancel()).body.outcome, 'clawed_back')
  assert.equal(await balance(u), 0)
  assert.equal((await cancel()).body.outcome, 'duplicate')
  assert.equal(await balance(u), 0)
  assert.deepEqual((await ledger(u.id)).map(r => [r.kind, r.delta]), [['purchase', 1500], ['clawback', -1500]])
})

test('a refund after the credits were spent leaves a negative balance, which blocks spending until it is made good', async () => {
  const u = await stack.createUser()
  await deliver(purchase(u, { transaction_id: 'GPA.spent' }))
  await stack.sql(`insert into credit_ledger (user_id, kind, delta, ref) values ($1, 'spend', -400, 'spend:x')`, [u.id])
  await deliver(purchase(u, { type: 'CANCELLATION', transaction_id: 'GPA.spent' }))
  assert.equal(await balance(u), -400)
})

test('a refund of something we never credited is recorded and ignored', async () => {
  const u = await stack.createUser()
  assert.equal((await deliver(purchase(u, { type: 'CANCELLATION', transaction_id: 'GPA.never' }))).body.outcome, 'ignored')
  assert.equal((await deliver(purchase(u, { type: 'CANCELLATION', transaction_id: undefined }))).body.outcome, 'ignored')
  assert.equal(await balance(u), 0)
})

test('a refund cannot be used on someone else\'s purchase', async () => {
  const buyer = await stack.createUser()
  const other = await stack.createUser()
  await deliver(purchase(buyer, { transaction_id: 'GPA.mine' }))
  const res = await deliver(purchase(other, { type: 'CANCELLATION', transaction_id: 'GPA.mine' }))
  assert.equal(res.body.outcome, 'ignored')
  assert.equal(await balance(buyer), 500)
})

// ── Everything else ──────────────────────────────────────────────────────────

test('RevenueCat\'s test event is recorded and does nothing', async () => {
  const u = await stack.createUser()
  const res = await deliver(purchase(u, { type: 'TEST' }))
  assert.equal(res.body.outcome, 'test')
  assert.equal(await balance(u), 0)
})

test('events for things we do not sell are recorded and ignored — nothing is credited by accident', async () => {
  const u = await stack.createUser()
  for (const type of ['INITIAL_PURCHASE', 'RENEWAL', 'EXPIRATION', 'BILLING_ISSUE', 'PRODUCT_CHANGE', 'UNCANCELLATION', 'TRANSFER', 'SUBSCRIPTION_PAUSED', 'SOMETHING_NEW']) {
    const res = await deliver(purchase(u, { type }))
    assert.equal(res.status, 200, type)
    assert.equal(res.body.outcome, 'ignored', type)
  }
  assert.equal(await balance(u), 0)
})

test('if anything fails, nothing of the delivery is kept — so RevenueCat\'s retry can succeed', async () => {
  const u = await stack.createUser()
  const body = purchase(u)
  await stack.sql('alter table credit_ledger rename to credit_ledger_away')
  let failed
  try { failed = await deliver(body) } finally { await stack.sql('alter table credit_ledger_away rename to credit_ledger') }
  assert.equal(failed.status, 500, 'a non-200 makes RevenueCat retry')
  assert.deepEqual(await recorded(), [], 'the event id was rolled back with the rest')

  const retry = await deliver(body)
  assert.equal(retry.body.outcome, 'credited')
  assert.equal(await balance(u), 500)
})

test('deliveries arriving at the same moment credit once', async () => {
  const u = await stack.createUser()
  const body = purchase(u, { transaction_id: 'GPA.race' })
  const answers = await Promise.all(Array.from({ length: 6 }, () => deliver(body)))
  assert.ok(answers.every(a => a.status === 200))
  assert.equal(answers.filter(a => a.body.outcome === 'credited').length, 1)
  assert.equal(await balance(u), 500)
})

// ── The product id as Google Play reports it ────────────────────────────────

test('a product reported with a purchase option (credits_500:base-plan) is the same pack, credited once, and recorded as the store sent it', async () => {
  const u = await stack.createUser()
  const res = await deliver(purchase(u, { product_id: 'credits_500:base-plan', transaction_id: 'GPA.suffix-1' }))
  assert.equal(res.body.outcome, 'credited')
  assert.equal(await balance(u), 500)
  const [event] = await recorded()
  assert.equal(event.outcome, 'credited')
  const [row] = await ledger(u.id)
  assert.match(row.note, /credits_500:base-plan/, 'the id exactly as it came is what the history says')

  // The same store transaction reported again, this time without the suffix, still credits once.
  assert.equal((await deliver(purchase(u, { product_id: 'credits_500', transaction_id: 'GPA.suffix-1' }))).body.outcome, 'duplicate')
  assert.equal(await balance(u), 500)
})

test('only the part before the first colon names the pack — a look-alike is not one', async () => {
  const u = await stack.createUser()
  assert.equal((await deliver(purchase(u, { product_id: 'credits_5000:x:y', transaction_id: 'GPA.s-2' }))).body.outcome, 'credited')
  assert.equal(await balance(u), 5000, 'credits_5000, not credits_500')
  for (const [i, product_id] of ['credits_500x', 'credits_50', ':credits_500', 'consumable:credits_500', 'CREDITS_500'].entries()) {
    assert.equal((await deliver(purchase(u, { product_id, transaction_id: `GPA.s-bad-${i}` }))).body.outcome, 'ignored', product_id)
  }
  assert.equal(await balance(u), 5000)
})

test('a suffixed product that has been switched off is still ignored', async () => {
  const u = await stack.createUser()
  await stack.sql(`update credit_packs set enabled = false where product_id = 'credits_1500'`)
  assert.equal((await deliver(purchase(u, { product_id: 'credits_1500:base-plan' }))).body.outcome, 'ignored')
  assert.equal(await balance(u), 0)
  await stack.sql(`update credit_packs set enabled = true where product_id = 'credits_1500'`)
})

test('a refund of a purchase that arrived with a suffix takes the same credits back', async () => {
  const u = await stack.createUser()
  await deliver(purchase(u, { product_id: 'credits_1500:base-plan', transaction_id: 'GPA.s-3' }))
  const res = await deliver(purchase(u, { type: 'CANCELLATION', product_id: 'credits_1500:base-plan', transaction_id: 'GPA.s-3' }))
  assert.equal(res.body.outcome, 'clawed_back')
  assert.equal(await balance(u), 0)
})

test('a subscription event is recorded and credits nothing — there are no subscriptions here', async () => {
  const u = await stack.createUser()
  for (const type of ['INITIAL_PURCHASE', 'RENEWAL', 'EXPIRATION', 'BILLING_ISSUE', 'UNCANCELLATION']) {
    const res = await deliver(purchase(u, { type, product_id: 'basic_monthly:p1m', transaction_id: `GPA.sub-${type}` }))
    assert.equal(res.status, 200, type)
    assert.equal(res.body.outcome, 'ignored', type)
  }
  assert.equal(await balance(u), 0)
  assert.equal((await recorded()).length, 5, 'each is on record, so the panel can show it')
})
