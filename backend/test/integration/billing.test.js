// Credits: the ledger, the gate in front of KIE, refunds, and the admin's grant.
//
// The gate has two modes. Shadow (the default, BILLING_ENFORCED unset) takes nothing and stops
// nobody; enforced takes the model's price before KIE is asked and gives it back whenever the
// generation does not happen. Tests that need the gate on turn it on for their own duration.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack } from '../helpers/stack.js'

let stack
const realFetch = globalThis.fetch

before(async () => { stack = await startStack({}) })
after(async () => { globalThis.fetch = realFetch; await stack?.stop() })
beforeEach(async () => {
  await stack.reset()
  delete process.env.BILLING_ENFORCED
  globalThis.fetch = realFetch
})

const PRICES = `
  insert into model_prices (model, credits, unit) values
    ('nano-banana-pro', 18, 'per_image'),
    ('kling-3.0/video', 40, 'per_video'),
    ('wan/2-5-image-to-video', 20, 'per_second'),
    ('free-model', 0, 'per_video')`

const enforce = () => { process.env.BILLING_ENFORCED = 'true' }
const createTask = (token, model = 'nano-banana-pro', input = { prompt: 'a friendly person in a park' }) =>
  stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token, body: { model, input } })
const sentToKie = () => stack.kie.requests.filter(r => r.path === '/api/v1/jobs/createTask')
const balance = async user => (await stack.api('GET', '/api/billing/me', { token: user.token })).body.balance
const ledger = userId => stack.sql(`select kind, delta::float8 as delta, kie_task_id, ref, model from credit_ledger where user_id = $1 order by id`, [userId])
const give = (userId, credits) => stack.sql(`insert into credit_ledger (user_id, kind, delta, ref) values ($1, 'grant', $2, $3)`, [userId, credits, `test-grant-${Math.random()}`])
const register = (user, taskId, model = 'nano-banana-pro') => stack.api('POST', '/api/jobs/register', { token: user.token, body: { entries: [{ taskId, kind: 'image', label: 'Image', model }] } })
const sync = (user, taskId) => stack.api('GET', `/api/jobs/sync?taskId=${taskId}`, { token: user.token })

// ── Shadow mode: look, do not touch ──────────────────────────────────────────

test('shadow mode takes nothing and stops nobody, whatever the balance and whether or not a model has a price', async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  assert.equal((await createTask(u.token)).status, 200, 'a priced model with an empty balance goes through')
  assert.equal((await createTask(u.token, 'a-model-nobody-priced')).status, 200, 'an unpriced model goes through')
  assert.equal(sentToKie().length, 2)
  assert.deepEqual(await ledger(u.id), [], 'and nothing was written to the ledger')
  assert.equal(await balance(u), 0)
})

test('only the exact word "true" turns the gate on', async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  for (const value of ['', 'false', '1', 'yes', 'TRUE ']) {
    process.env.BILLING_ENFORCED = value
    assert.equal((await createTask(u.token)).status, 200, JSON.stringify(value))
  }
  process.env.BILLING_ENFORCED = 'TRUE'
  assert.equal((await createTask(u.token)).status, 402, 'case does not matter')
})

// ── Enforced: the price is taken first ───────────────────────────────────────

test('enforced: not enough credits is a 402 that says what is missing, and KIE is never asked', async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 10)
  enforce()
  const res = await createTask(u.token)
  assert.equal(res.status, 402)
  assert.equal(res.body.code, 'INSUFFICIENT_CREDITS')
  assert.equal(res.body.balance, 10)
  assert.equal(res.body.price, 18)
  assert.match(res.body.error, /credit/i)
  assert.equal(sentToKie().length, 0)
  assert.equal((await ledger(u.id)).length, 1, 'only the grant: nothing was taken')
})

test('enforced: with enough credits the price is taken, tied to the task KIE starts, and the balance shows it', async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 50)
  enforce()
  const res = await createTask(u.token)
  assert.equal(res.status, 200)
  const taskId = res.body.data.taskId
  const rows = await ledger(u.id)
  assert.deepEqual(rows.map(r => [r.kind, r.delta]), [['grant', 50], ['spend', -18]])
  assert.equal(rows[1].kie_task_id, taskId)
  assert.equal(rows[1].model, 'nano-banana-pro')
  assert.equal(await balance(u), 32)
})

test('enforced: a model with no price is refused — free by accident is not allowed — but a price of 0 is a free model', async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  enforce()
  const unpriced = await createTask(u.token, 'a-model-nobody-priced')
  assert.equal(unpriced.status, 403)
  assert.equal(unpriced.body.code, 'MODEL_UNAVAILABLE')
  assert.equal(sentToKie().length, 0)

  const free = await createTask(u.token, 'free-model')
  assert.equal(free.status, 200, 'priced at 0, with a balance of 0')
  assert.deepEqual(await ledger(u.id), [], 'and nothing is written for it')
})

test('enforced: a per-second price is multiplied by the duration the request names, and refused when it names none', async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 1000)
  enforce()
  const ok = await createTask(u.token, 'wan/2-5-image-to-video', { prompt: 'hi', duration: '5' })
  assert.equal(ok.status, 200)
  assert.equal((await ledger(u.id)).at(-1).delta, -100)

  const noDuration = await createTask(u.token, 'wan/2-5-image-to-video', { prompt: 'hi' })
  assert.equal(noDuration.status, 403, 'a per-second price cannot be applied without seconds')
  for (const duration of ['abc', '0', '-3', '9999']) {
    assert.equal((await createTask(u.token, 'wan/2-5-image-to-video', { prompt: 'hi', duration })).status, 403, duration)
  }
  assert.equal(await balance(u), 900)
})

test('enforced: one account\'s credits never pay for another\'s generation', async () => {
  const rich = await stack.createUser()
  const poor = await stack.createUser()
  await stack.sql(PRICES)
  await give(rich.id, 500)
  enforce()
  assert.equal((await createTask(poor.token)).status, 402)
  assert.equal(await balance(rich), 500)
})

test('enforced: a request moderation refuses costs nothing', async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 100)
  enforce()
  const res = await createTask(u.token, 'nano-banana-pro', { prompt: 'XXX-EXPLICIT' })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'CONTENT_BLOCKED')
  assert.equal(await balance(u), 100)
})

test('enforced: five requests at once cannot spend the same credits twice', async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 36)   // exactly two images
  enforce()
  const answers = await Promise.all(Array.from({ length: 5 }, () => createTask(u.token)))
  const statuses = answers.map(a => a.status).sort()
  assert.deepEqual(statuses, [200, 200, 402, 402, 402])
  assert.equal(await balance(u), 0, 'never below zero')
  assert.equal(sentToKie().length, 2)
})

// ── Giving back ──────────────────────────────────────────────────────────────

test('KIE refusing the request gives the credits straight back (an HTTP error, or an error inside a 200)', async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 100)
  enforce()

  stack.kie.createStatus = { status: 500, body: { code: 500, msg: 'internal' } }
  assert.equal((await createTask(u.token)).status, 500)
  assert.equal(await balance(u), 100)

  stack.kie.createStatus = { status: 200, body: { code: 500, msg: 'prompt exceeds maximum length of 800 characters' } }
  const inside = await createTask(u.token)
  assert.equal(inside.body.code, 500, 'what KIE said is passed on unchanged')
  assert.equal(await balance(u), 100)

  const kinds = (await ledger(u.id)).map(r => r.kind)
  assert.deepEqual(kinds, ['grant', 'spend', 'refund', 'spend', 'refund'])
})

test('KIE being unreachable gives the credits back too', async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 100)
  enforce()
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    // Only the proxy's own call to KIE fails — not this test's call to the server.
    if (url.startsWith(process.env.KIE_BASE_URL)) throw new Error('connect ECONNREFUSED')
    return realFetch(input, init)
  }
  const res = await createTask(u.token)
  assert.equal(res.status, 502)
  assert.equal(await balance(u), 100)
})

test('a job that fails gives its credits back once, however often the failure is reported', async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 100)
  enforce()
  const taskId = (await createTask(u.token)).body.data.taskId
  await register(u, taskId)
  assert.equal(await balance(u), 82)

  stack.kie.tasks.set(taskId, { taskId, state: 'fail', failMsg: 'Internal Error', failCode: '500', creditsConsumed: 0 })
  await sync(u, taskId)
  await sync(u, taskId)
  await sync(u, taskId)
  assert.equal(await balance(u), 100)
  assert.equal((await ledger(u.id)).filter(r => r.kind === 'refund').length, 1)
})

test('a job that succeeds keeps its charge', async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 100)
  enforce()
  const taskId = (await createTask(u.token)).body.data.taskId
  await register(u, taskId)
  stack.kie.tasks.set(taskId, { taskId, state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://tempfile.aiquickdraw.com/r/out.jpg'] }), completeTime: Date.now(), creditsConsumed: 18 })
  await sync(u, taskId)
  assert.equal(await balance(u), 82)
})

test('a Veo job, which answers in its own wrapping, is found when it finishes — and keeps its charge', async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 100)
  enforce()
  const taskId = (await createTask(u.token)).body.data.taskId
  await register(u, taskId)
  // The shape KIE really returned for veo3_fast and veo-3-1 on 23 October 2026 (links replaced): no `resultUrls`,
  // the links are inside `data`. Before this was read, such a job finished, was charged, and was never collected.
  const RESULT = 'https://tempfile.aiquickdraw.com/veo/out-1080p.mp4'
  stack.kie.tasks.set(taskId, {
    taskId, state: 'success', completeTime: Date.now(), creditsConsumed: 18,
    resultJson: JSON.stringify({
      code: 200, message: 'success', task_id: taskId, message_type: 'success',
      data: { origin_urls: ['https://tempfile.aiquickdraw.com/veo/out-720p.mp4'], result_urls: [RESULT], resolution: '1080p', aspect_ratio: '9:16', has_audio_list: [true] },
    }),
  })
  const answer = await sync(u, taskId)
  assert.equal(answer.body.status.state, 'success')
  assert.deepEqual(answer.body.status.resultUrls, [RESULT], 'the 1080p link, not the 720p original')
  assert.equal((await stack.one('select result_url from generation_jobs where kie_task_id = $1', [taskId])).result_url, RESULT, 'and it is on the job, so it can be collected')
  assert.equal(await balance(u), 82)
})

test('a refusal by KIE\'s own filter is free for the user, and is on record for an admin', async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 100)
  enforce()
  const taskId = (await createTask(u.token)).body.data.taskId
  await register(u, taskId)
  stack.kie.tasks.set(taskId, { taskId, state: 'fail', failMsg: 'The input or output was flagged as sensitive. Please try again with different inputs.', failCode: '400', creditsConsumed: 0 })
  await sync(u, taskId)
  assert.equal(await balance(u), 100)
  assert.equal((await stack.sql(`select 1 from moderation_events where user_id = $1 and source = 'provider'`, [u.id])).length, 1)
})

test('a spend whose request never got an answer is given back by the sweep — after a grace period, and once', async () => {
  const u = await stack.createUser()
  await give(u.id, 100)
  const { sweepUnsettledSpends } = await stack.load('api/_lib/billing.js')
  await stack.sql(`insert into credit_ledger (user_id, kind, delta, ref, created_at) values ($1, 'spend', -18, 'spend:young', now() - interval '2 minutes'), ($1, 'spend', -18, 'spend:old', now() - interval '30 minutes')`, [u.id])
  assert.equal(await balance(u), 64)

  const first = await sweepUnsettledSpends()
  assert.equal(first.refunded, 18, 'only the old one')
  assert.equal(await balance(u), 82)
  const second = await sweepUnsettledSpends()
  assert.equal(second.refunded, 0, 'and not again')
  assert.equal(await balance(u), 82)
})

test('a spend that was tied to a task is never swept — the task decides whether it comes back', async () => {
  const u = await stack.createUser()
  await give(u.id, 100)
  const { sweepUnsettledSpends } = await stack.load('api/_lib/billing.js')
  await stack.sql(`insert into credit_ledger (user_id, kind, delta, ref, kie_task_id, created_at) values ($1, 'spend', -18, 'spend:tied', 'task-x', now() - interval '3 hours')`, [u.id])
  assert.equal((await sweepUnsettledSpends()).refunded, 0)
  assert.equal(await balance(u), 82)
})

test('the ledger refuses rows that make no sense: a spend that adds, a refund that subtracts, a zero', async () => {
  const u = await stack.createUser()
  for (const [kind, delta] of [['spend', 5], ['refund', -5], ['grant', -5], ['purchase', 0], ['clawback', 5], ['adjust', 0]]) {
    await assert.rejects(
      stack.sql(`insert into credit_ledger (user_id, kind, delta) values ($1, $2, $3)`, [u.id, kind, delta]),
      `${kind} ${delta}`,
    )
  }
  await assert.rejects(stack.sql(`insert into credit_ledger (user_id, kind, delta) values ($1, 'bonus', 5)`, [u.id]), 'unknown kind')
  // The database stand-in drops its connection after a run of rejected statements; let the pool notice here, not in the next test's setup.
  await stack.sql('select 1').catch(() => {})
  await stack.sql('select 1').catch(() => {})
})

test('the same ref is only ever written once', async () => {
  const u = await stack.createUser()
  const { addEntry } = await stack.load('api/_lib/billing.js')
  const a = await addEntry({ userId: u.id, kind: 'grant', delta: 5, ref: 'same' })
  const b = await addEntry({ userId: u.id, kind: 'grant', delta: 5, ref: 'same' })
  assert.deepEqual([a.inserted, b.inserted], [true, false])
  assert.equal(await balance(u), 5)
})

// ── What the app reads ───────────────────────────────────────────────────────

test('GET /api/billing/me needs a session and tells only the caller\'s balance, with the price list and the packs', async () => {
  const u = await stack.createUser()
  const other = await stack.createUser()
  await stack.sql(PRICES)
  await stack.sql(`update model_prices set enabled = false where model = 'kling-3.0/video'`)
  await give(u.id, 123.5)
  await give(other.id, 9)

  assert.equal((await stack.api('GET', '/api/billing/me')).status, 401)
  const res = await stack.api('GET', '/api/billing/me', { token: u.token })
  assert.equal(res.status, 200)
  assert.equal(res.body.balance, 123.5)
  assert.equal(res.body.enforced, false)
  assert.deepEqual(res.body.prices.map(p => p.model).sort(), ['free-model', 'nano-banana-pro', 'wan/2-5-image-to-video'], 'a disabled model is not offered')
  assert.deepEqual(res.body.packs.map(p => [p.productId, p.credits]), [['credits_500', 500], ['credits_1500', 1500], ['credits_5000', 5000], ['credits_10000', 10000], ['credits_20000', 20000]])
  assert.equal(res.headers.get('cache-control'), 'private, no-store')

  enforce()
  assert.equal((await stack.api('GET', '/api/billing/me', { token: u.token })).body.enforced, true)
})

// ── The admin's hand on a balance ────────────────────────────────────────────

const grantAs = (admin, body) => stack.api('POST', '/api/admin/billing/grant', { token: admin.token, body })

test('an admin can grant credits: recorded with who and why, audited, and the new balance comes back', async () => {
  const admin = await stack.createUser({ email: 'boss@test.example', role: 'admin' })
  const u = await stack.createUser()
  const res = await grantAs(admin, { userId: u.id, credits: 250, note: 'Play review test account' })
  assert.equal(res.status, 200)
  assert.equal(res.body.balance, 250)

  const row = (await stack.sql(`select kind, delta::float8 as delta, note, created_by from credit_ledger where user_id = $1`, [u.id]))[0]
  assert.deepEqual([row.kind, row.delta, row.note, row.created_by], ['grant', 250, 'Play review test account', admin.id])
  const logged = await stack.sql(`select action, target_id, details from admin_audit_log`)
  assert.equal(logged.length, 1)
  assert.equal(logged[0].action, 'billing.grant')
  assert.equal(logged[0].target_id, u.id)
  assert.equal(logged[0].details.credits, 250)
})

test('a negative amount is an adjustment, and may take a balance below zero (a refunded purchase does too)', async () => {
  const admin = await stack.createUser({ role: 'admin' })
  const u = await stack.createUser()
  await grantAs(admin, { userId: u.id, credits: 100, note: 'start' })
  const res = await grantAs(admin, { userId: u.id, credits: -150, note: 'Chargeback' })
  assert.equal(res.body.balance, -50)
  assert.equal((await ledger(u.id)).at(-1).kind, 'adjust')

  await stack.sql(PRICES)
  enforce()
  assert.equal((await createTask(u.token)).status, 402, 'a negative balance blocks spending until it is positive again')
})

test('grants are checked: an administrator, a real account, a sensible number and a reason', async () => {
  const admin = await stack.createUser({ role: 'admin' })
  const u = await stack.createUser()
  const stranger = await stack.createUser()

  assert.equal((await grantAs(stranger, { userId: u.id, credits: 5, note: 'x' })).status, 403, 'not an admin')
  assert.equal((await stack.api('POST', '/api/admin/billing/grant', { body: { userId: u.id, credits: 5, note: 'x' } })).status, 401)
  assert.equal((await grantAs(admin, { userId: 'nope', credits: 5, note: 'x' })).status, 400)
  assert.equal((await grantAs(admin, { userId: '00000000-0000-4000-8000-000000000000', credits: 5, note: 'x' })).status, 404)
  for (const credits of [0, '0', 'abc', null, undefined, NaN, Infinity, 1_000_001, -1_000_001, 0.0001, {}, [5], true]) {
    assert.equal((await grantAs(admin, { userId: u.id, credits, note: 'x' })).status, 400, JSON.stringify(credits))
  }
  for (const note of ['', '   ', undefined, null, 5, 'x'.repeat(301)]) {
    assert.equal((await grantAs(admin, { userId: u.id, credits: 5, note })).status, 400, JSON.stringify(note))
  }
  assert.equal(await balance(u), 0, 'none of that moved a balance')
  assert.deepEqual(await stack.sql('select 1 from admin_audit_log'), [], 'or left a record')
})

test('credits given as numeric text are accepted, and fractions are kept to three places', async () => {
  const admin = await stack.createUser({ role: 'admin' })
  const u = await stack.createUser()
  assert.equal((await grantAs(admin, { userId: u.id, credits: '12.3456', note: 'x' })).body.balance, 12.346)
})

test('the ledger endpoint lists an account\'s history newest first, with the admin\'s email, and pages', async () => {
  const admin = await stack.createUser({ email: 'boss@test.example', role: 'admin' })
  const u = await stack.createUser()
  for (let i = 1; i <= 5; i++) await grantAs(admin, { userId: u.id, credits: i, note: `grant ${i}` })

  const res = await stack.api('GET', `/api/admin/billing/ledger?userId=${u.id}&pageSize=2`, { token: admin.token })
  assert.equal(res.status, 200)
  assert.equal(res.body.total, 5)
  assert.equal(res.body.balance, 15)
  assert.deepEqual(res.body.entries.map(e => e.note), ['grant 5', 'grant 4'])
  assert.equal(res.body.entries[0].by, 'boss@test.example')
  assert.equal(typeof res.body.entries[0].id, 'string')
  const page3 = await stack.api('GET', `/api/admin/billing/ledger?userId=${u.id}&pageSize=2&page=3`, { token: admin.token })
  assert.deepEqual(page3.body.entries.map(e => e.note), ['grant 1'])

  assert.equal((await stack.api('GET', `/api/admin/billing/ledger?userId=${u.id}`, { token: u.token })).status, 403)
  assert.equal((await stack.api('GET', '/api/admin/billing/ledger?userId=bad', { token: admin.token })).status, 400)
})

test('the account\'s detail carries its credits for the panel', async () => {
  const admin = await stack.createUser({ role: 'admin' })
  const u = await stack.createUser()
  await grantAs(admin, { userId: u.id, credits: 40, note: 'hello' })
  const res = await stack.api('GET', `/api/admin/users/detail?userId=${u.id}`, { token: admin.token })
  assert.equal(res.body.credits.balance, 40)
  assert.equal(res.body.credits.enforced, false)
  assert.equal(res.body.credits.recent.length, 1)
  assert.equal(res.body.credits.recent[0].note, 'hello')
})

test('deleting an account takes its ledger with it, and nobody else\'s', async () => {
  const a = await stack.createUser()
  const b = await stack.createUser()
  await give(a.id, 5)
  await give(b.id, 7)
  await stack.sql('delete from users where id = $1', [a.id])
  assert.equal((await stack.sql('select count(*)::int as n from credit_ledger'))[0].n, 1)
  assert.equal(await balance(b), 7)
})
