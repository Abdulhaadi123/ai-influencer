// The admin's view of the credits business: what people bought and spent, what they hold,
// what the store told us and what became of it — and the figures the other lists carry
// (an account's balance, what a job charged, the "unpriced" count with per-mode prices).

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack } from '../helpers/stack.js'

let stack
let admin
before(async () => { stack = await startStack() })
after(async () => { await stack?.stop() })
beforeEach(async () => {
  await stack.reset()
  admin = await stack.createUser({ email: 'boss@test.example', role: 'admin' })
})

const get = (path, who = admin) => stack.api('GET', path, { token: who?.token })
const post = (path, body, who = admin) => stack.api('POST', path, { token: who?.token, body })

let n = 0
const row = (user, kind, delta, extra = {}) => stack.sql(
  `insert into credit_ledger (user_id, kind, delta, ref, kie_task_id, model, note, created_at)
   values ($1, $2, $3, $4, $5, $6, $7, ${extra.at ?? 'now()'})`,
  [user.id, kind, delta, `t-${++n}`, extra.task ?? null, extra.model ?? null, extra.note ?? null],
)
const delivery = (o = {}) => stack.sql(
  `insert into billing_events (id, user_id, type, product_id, environment, transaction_id, outcome, credits, received_at)
   values ($1, $2, $3, $4, $5, $6, $7, $8, ${o.at ?? 'now()'})`,
  [o.id ?? `evt-${++n}`, o.user ?? null, o.type ?? 'NON_RENEWING_PURCHASE', o.product ?? 'credits_500', o.env ?? 'SANDBOX', `txn-${n}`, o.outcome ?? 'credited', o.credits ?? null],
)
const job = (user, o = {}) => stack.one(
  `insert into generation_jobs (user_id, kie_task_id, kind, label, model, state, kie_credits, completed_at)
   values ($1, $2, 'video', 'Video', $3, $4, $5, now()) returning *`,
  [user.id, o.task ?? `task-${++n}`, o.model ?? 'kling-3.0/video', o.state ?? 'success', o.kie ?? null],
)

// ── Access ──────────────────────────────────────────────────────────────────

test('the three credits views are closed to everyone but an administrator', async () => {
  const user = await stack.createUser()
  for (const path of ['/api/admin/billing/summary', '/api/admin/billing/activity', '/api/admin/billing/store-events']) {
    assert.equal((await get(path, null)).status, 401, `${path} with no session`)
    const asUser = await get(path, user)
    assert.equal(asUser.status, 403, `${path} as a user`)
    assert.equal(asUser.body.code, 'NOT_ADMIN')
    assert.equal((await get(path)).status, 200, `${path} as an admin`)
  }
})

// ── Summary ─────────────────────────────────────────────────────────────────

test('summary: bought, spent, refunded, given and taken back are added up separately, and what people hold is the net', async () => {
  const a = await stack.createUser({ email: 'a@test.example' })
  const b = await stack.createUser({ email: 'b@test.example' })
  const c = await stack.createUser({ email: 'c@test.example' })
  await row(a, 'purchase', 500); await row(a, 'spend', -120); await row(a, 'spend', -30); await row(a, 'refund', 30)
  await row(b, 'purchase', 1500); await row(b, 'purchase', 500); await row(b, 'grant', 50); await row(b, 'adjust', -10)
  await row(c, 'purchase', 500); await row(c, 'clawback', -500); await row(c, 'spend', -40)   // c ends below zero

  const s = (await get('/api/admin/billing/summary?days=30')).body
  assert.equal(s.days, 30)
  assert.deepEqual(s.window, { purchased: 3000, purchases: 4, purchasers: 3, spent: 190, refunded: 30, granted: 50, adjusted: -10, clawedBack: 500 })
  assert.deepEqual(s.holding, { held: 380 + 2040, holders: 2, owed: 40, owing: 1 })
  assert.equal(s.enforced, false, 'billing is only watching in tests')
  assert.equal(typeof s.providerCost, 'number')
})

test('summary: only the window counts for flows; what people hold is everything, ever', async () => {
  const u = await stack.createUser()
  await row(u, 'purchase', 1000, { at: `now() - interval '40 days'` })
  await row(u, 'spend', -100, { at: `now() - interval '2 days'` })

  const s = (await get('/api/admin/billing/summary?days=7')).body
  assert.equal(s.window.purchased, 0, 'the purchase is 40 days old')
  assert.equal(s.window.spent, 100)
  assert.equal(s.holding.held, 900, 'the old purchase is still in the balance')
  assert.equal((await get('/api/admin/billing/summary?days=90')).body.window.purchased, 1000)
  assert.equal((await get('/api/admin/billing/summary?days=abc')).body.days, 30, 'a bad window falls back to 30')
  assert.equal((await get('/api/admin/billing/summary?days=9999')).body.days, 90, 'and is capped at 90')
})

test('summary: a per-day series for purchases and spending, and the products that sold with their environment', async () => {
  const u = await stack.createUser()
  await row(u, 'purchase', 500); await row(u, 'spend', -50)
  await row(u, 'spend', -25, { at: `now() - interval '1 day'` })
  await delivery({ user: u.id, product: 'credits_500', env: 'SANDBOX', outcome: 'credited', credits: 500 })
  await delivery({ user: u.id, product: 'credits_500', env: 'PRODUCTION', outcome: 'credited', credits: 500 })
  await delivery({ user: u.id, product: 'credits_1500', env: 'SANDBOX', outcome: 'duplicate' })   // credited once only

  const s = (await get('/api/admin/billing/summary?days=7')).body
  const today = s.series.at(-1)
  assert.equal(today.purchased, 500)
  assert.equal(today.spent, 50)
  assert.equal(s.series.length, 2, 'only days with movement; the panel fills the gaps')
  assert.deepEqual(s.packs.map(p => [p.productId, p.environment, p.purchases, p.credits]).sort(), [
    ['credits_500', 'PRODUCTION', 1, 500], ['credits_500', 'SANDBOX', 1, 500],
  ])
  assert.equal(s.packs[0].label, '500 credits', 'the pack label comes from the pack table')
})

test('summary: what KIE charged in the same window, next to what people spent', async () => {
  const u = await stack.createUser()
  await job(u, { kie: 18 }); await job(u, { kie: 100 })
  assert.equal((await get('/api/admin/billing/summary')).body.providerCost, 118)
})

// ── Activity (every account's movements) ────────────────────────────────────

test('activity: every account’s credit movements, newest first, with the account and who made an admin entry', async () => {
  const a = await stack.createUser({ email: 'ann@test.example' })
  const b = await stack.createUser({ email: 'bob@test.example' })
  await row(a, 'purchase', 500, { note: '500 credits' })
  await row(b, 'spend', -18, { model: 'nano-banana-pro', task: 'task-x' })
  await post('/api/admin/billing/grant', { userId: b.id, credits: 25, note: 'goodwill' })

  const r = (await get('/api/admin/billing/activity')).body
  assert.equal(r.total, 3)
  assert.deepEqual(r.entries.map(e => [e.email, e.kind, e.delta]), [['bob@test.example', 'grant', 25], ['bob@test.example', 'spend', -18], ['ann@test.example', 'purchase', 500]])
  assert.equal(r.entries[0].by, 'boss@test.example')
  assert.equal(r.entries[0].userId, b.id)
  assert.equal(r.entries[1].model, 'nano-banana-pro')
  assert.equal(typeof r.entries[0].id, 'string', 'a bigint id arrives as text')
})

test('activity: filter by kind, by account email, or by one account; hostile terms are just text', async () => {
  const a = await stack.createUser({ email: 'ann@test.example' })
  const b = await stack.createUser({ email: 'bob@test.example' })
  await row(a, 'purchase', 500); await row(a, 'spend', -10); await row(b, 'spend', -20)

  assert.equal((await get('/api/admin/billing/activity?kind=spend')).body.total, 2)
  assert.equal((await get('/api/admin/billing/activity?kind=nonsense')).body.total, 3, 'an unknown kind is no filter')
  assert.equal((await get('/api/admin/billing/activity?q=bob')).body.total, 1)
  assert.equal((await get(`/api/admin/billing/activity?userId=${a.id}`)).body.total, 2)
  assert.equal((await get(`/api/admin/billing/activity?userId=${a.id}&kind=spend`)).body.total, 1)
  assert.equal((await get('/api/admin/billing/activity?userId=not-a-uuid')).status, 400)
  assert.equal((await get('/api/admin/billing/activity?q=%25')).body.total, 0, '% is a character, not a wildcard')
  assert.equal((await get('/api/admin/billing/activity?q=%00')).status, 200)
})

test('activity pages', async () => {
  const u = await stack.createUser()
  for (let i = 0; i < 7; i++) await row(u, 'grant', 1)
  const r = (await get('/api/admin/billing/activity?pageSize=3&page=3')).body
  assert.equal(r.total, 7)
  assert.equal(r.entries.length, 1)
  assert.equal(r.page, 3)
})

// ── Store deliveries ────────────────────────────────────────────────────────

test('store events: each delivery with its outcome, newest first; the account is named when we knew it', async () => {
  const u = await stack.createUser({ email: 'buyer@test.example' })
  await delivery({ id: 'e1', user: u.id, outcome: 'credited', credits: 500, at: `now() - interval '2 minutes'` })
  await delivery({ id: 'e2', outcome: 'unmatched' })

  const r = (await get('/api/admin/billing/store-events')).body
  assert.equal(r.total, 2)
  assert.deepEqual(r.events.map(e => e.id), ['e2', 'e1'])
  assert.deepEqual([r.events[1].email, r.events[1].credits, r.events[1].environment, r.events[1].problem], ['buyer@test.example', 500, 'SANDBOX', false])
  assert.deepEqual([r.events[0].email, r.events[0].credits, r.events[0].problem], [null, null, true])
})

test('store events: what counts as a problem — someone paid and the credits did not arrive', async () => {
  const u = await stack.createUser()
  await delivery({ id: 'ok', user: u.id, outcome: 'credited', credits: 500 })
  await delivery({ id: 'dup', user: u.id, outcome: 'duplicate' })
  await delivery({ id: 'test', type: 'TEST', outcome: 'test' })
  await delivery({ id: 'noise', type: 'EXPIRATION', outcome: 'ignored' })                                         // an event type that is not ours and moves no money: fine
  await delivery({ id: 'sub-new', user: u.id, type: 'INITIAL_PURCHASE', product: 'basic_monthly', outcome: 'ignored' })   // someone paid for a subscription we do not sell
  await delivery({ id: 'sub-renew', user: u.id, type: 'RENEWAL', product: 'basic_monthly', outcome: 'ignored' })
  await delivery({ id: 'nobody', outcome: 'unmatched' })                                                           // a purchase from nobody we know
  await delivery({ id: 'sbx', user: u.id, outcome: 'sandbox_off' })                                                // a test purchase while those are off
  await delivery({ id: 'unknown-product', user: u.id, product: 'credits_500:base', outcome: 'ignored' })           // a purchase of a product we do not sell
  await delivery({ id: 'refund-unknown', user: u.id, type: 'CANCELLATION', outcome: 'ignored' })

  const r = (await get('/api/admin/billing/store-events?problems=1')).body
  assert.deepEqual(r.events.map(e => e.id).sort(), ['nobody', 'refund-unknown', 'sbx', 'sub-new', 'sub-renew', 'unknown-product'])
  assert.ok(r.events.every(e => e.problem))
  assert.equal((await get('/api/admin/billing/store-events')).body.events.filter(e => e.problem).length, 6)
  assert.equal((await get('/api/admin/billing/store-events?outcome=credited')).body.total, 1)
  assert.equal((await get('/api/admin/billing/store-events?outcome=nonsense')).body.total, 10, 'an unknown outcome is no filter')
  assert.equal(r.events.find(e => e.id === 'unknown-product').productId, 'credits_500:base', 'the product id the store sent is shown as it came')
})

test('the overview counts store problems from the last 30 days, with the same rule', async () => {
  const u = await stack.createUser()
  await delivery({ user: u.id, outcome: 'credited', credits: 500 })
  await delivery({ outcome: 'unmatched' })
  await delivery({ user: u.id, outcome: 'ignored', product: 'credits_500:x' })
  await delivery({ outcome: 'unmatched', at: `now() - interval '45 days'` })   // too old to be today's concern
  assert.equal((await get('/api/admin/stats')).body.billingProblems30d, 2)
})

// ── What the other lists now carry ──────────────────────────────────────────

test('the accounts list carries each account’s balance, and sorts by it', async () => {
  const rich = await stack.createUser({ email: 'rich@test.example' })
  const poor = await stack.createUser({ email: 'poor@test.example' })
  const none = await stack.createUser({ email: 'none@test.example' })
  await row(rich, 'purchase', 1500); await row(rich, 'spend', -500)
  await row(poor, 'purchase', 500); await row(poor, 'spend', -520)

  const byEmail = Object.fromEntries((await get('/api/admin/users?pageSize=100')).body.users.map(u => [u.email, u.balance]))
  assert.deepEqual([byEmail['rich@test.example'], byEmail['poor@test.example'], byEmail['none@test.example']], [1000, -20, 0])

  const asc = (await get('/api/admin/users?sort=balance&dir=asc')).body.users.map(u => u.email)
  assert.equal(asc[0], 'poor@test.example', 'the one who owes comes first, ascending')
  assert.deepEqual(asc.slice(1, 3).sort(), ['boss@test.example', 'none@test.example'], 'then the two with nothing (their order is a tie)')
  assert.equal(asc.at(-1), 'rich@test.example')
  assert.equal((await get('/api/admin/users?sort=balance')).body.users[0].email, 'rich@test.example', 'descending is the default')
  assert.equal((await get(`/api/admin/users/detail?userId=${rich.id}`)).body.user.balance, 1000)
})

test('a job carries what the person was charged for it, net of any refund — and null when nothing was charged', async () => {
  const u = await stack.createUser()
  await job(u, { task: 'paid', kie: 18 });        await row(u, 'spend', -18, { task: 'paid' })
  await job(u, { task: 'refunded', state: 'fail', kie: 0 }); await row(u, 'spend', -100, { task: 'refunded' }); await row(u, 'refund', 100, { task: 'refunded' })
  await job(u, { task: 'free', kie: 18 })                                                                           // billing was only watching

  const byTask = Object.fromEntries((await get('/api/admin/jobs')).body.jobs.map(j => [j.taskId, j.charged]))
  assert.deepEqual(byTask, { paid: 18, refunded: 0, free: null })
})

test('a charge never leaks from one account’s task id to another’s', async () => {
  const a = await stack.createUser()
  const b = await stack.createUser()
  await job(b, { task: 'shared-id' })
  await row(a, 'spend', -77, { task: 'shared-id' })
  assert.equal((await get('/api/admin/jobs')).body.jobs[0].charged, null)
})

test('"in use without a price" understands a price kept per mode', async () => {
  const u = await stack.createUser()
  await job(u, { model: 'kling-3.0/motion-control' })
  await job(u, { model: 'veo-3-1' })
  assert.equal((await get('/api/admin/stats')).body.unpricedModels, 2)

  // Priced for its modes only: that prices the model, exactly as the Prices page says.
  await post('/api/admin/prices/upsert', { model: 'kling-3.0/motion-control:720p', unit: 'per_second', credits: 20, enabled: true })
  assert.equal((await get('/api/admin/stats')).body.unpricedModels, 1)
  const prices = (await get('/api/admin/prices')).body
  assert.deepEqual(prices.unpriced.map(m => m.model), ['veo-3-1'], 'the Prices page and the overview agree')

  // A model that merely STARTS the same way is not priced by another model's row.
  await job(u, { model: 'kling-3.0' })
  await post('/api/admin/prices/upsert', { model: 'kling-3.0/video', unit: 'per_video', credits: 5, enabled: true })
  assert.equal((await get('/api/admin/stats')).body.unpricedModels, 2, 'veo-3-1 and kling-3.0 (kling-3.0/video is a different model)')
  assert.deepEqual((await get('/api/admin/prices')).body.unpriced.map(m => m.model).sort(), ['kling-3.0', 'veo-3-1'])
})

test('an unpriced model says what kind of thing it made last, so the price form can start on the right unit', async () => {
  const u = await stack.createUser()
  await stack.sql(`insert into generation_jobs (user_id, kie_task_id, kind, label, model, state, created_at)
                   values ($1, 'k1', 'image', 'Image', 'img-model', 'success', now() - interval '2 hours'),
                          ($1, 'k2', 'video', 'Video', 'vid-model', 'success', now() - interval '2 hours'),
                          ($1, 'k3', 'video', 'Video', 'img-model', 'success', now() - interval '3 hours'),
                          ($1, 'k4', 'image', 'Image', 'img-model', 'success', now() - interval '1 hour')`, [u.id])
  const unpriced = Object.fromEntries((await get('/api/admin/prices')).body.unpriced.map(m => [m.model, m.kind]))
  assert.deepEqual(unpriced, { 'img-model': 'image', 'vid-model': 'video' }, 'the newest job decides')
})
