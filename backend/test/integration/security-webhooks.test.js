// Security: the two doors that have no session — KIE's callback and RevenueCat's purchase webhook.
//
// What proves the sender at each, what a sender who proves themselves still cannot do, and that
// nothing a request carries — before or after the proof — turns into a server error or into credits
// the price table did not grant.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { startStack, jpeg } from '../helpers/stack.js'

const KIE_SECRET = 'webhook-security-kie-secret'
const RC_AUTH = 'webhook-security-rc-auth'
const RESULT = 'https://tempfile.aiquickdraw.com/r/out.jpg'

let stack
let signPayload
const realFetch = globalThis.fetch
const outbound = []

before(async () => {
  stack = await startStack({ env: { KIE_WEBHOOK_SECRET: KIE_SECRET, REVENUECAT_WEBHOOK_AUTH: RC_AUTH, PUBLIC_BASE_URL: 'https://api.test.example' } })
  ;({ signPayload } = await stack.load('api/kie-callback.js'))
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input)
    if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return realFetch(input, init)
    outbound.push(url)
    if (url.startsWith('https://tempfile.aiquickdraw.com/')) {
      const body = jpeg('IMG-OK')
      return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) } })
    }
    return new Response('not reachable from a test', { status: 599 })
  }
})
after(async () => { globalThis.fetch = realFetch; await stack?.stop() })

// The webhooks' own rate limit is per caller address and in memory (120 in ten seconds). A sweep of hundreds
// of requests must not be mistaken for one flood, so every request comes from an address of its own.
let ipCounter = 0
const freshIp = () => { ipCounter += 1; return `10.2.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}` }
beforeEach(async () => {
  await stack.reset()
  outbound.length = 0
})

const post = (path, body, headers = {}) => stack.api('POST', path, { body, headers: { 'x-forwarded-for': freshIp(), ...headers } })
const settle = () => new Promise(r => setTimeout(r, 150))

// ═════════════════════════════ KIE's callback ═════════════════════════════════

let n = 0
async function runningJob(user, taskId = `task-hook-${++n}`) {
  await stack.api('POST', '/api/jobs/register', { token: user.token, body: { entries: [{ taskId, kind: 'image', label: 'Image', model: 'nano-banana-pro' }] } })
  return taskId
}
const jobOf = taskId => stack.one('select state, kie_credits, fail_msg, result_url, asset_id from generation_jobs where kie_task_id = $1', [taskId])
const successData = (taskId, extra = {}) => ({ taskId, state: 'success', resultJson: JSON.stringify({ resultUrls: [RESULT] }), completeTime: Date.now(), ...extra })

const kie = (taskId, body, { timestamp = Math.floor(Date.now() / 1000), signature, secret = KIE_SECRET } = {}) =>
  post('/webhooks/kie', body, {
    'x-webhook-timestamp': String(timestamp),
    'x-webhook-signature': signature ?? signPayload(taskId, timestamp, secret),
  })

test('KIE: the proof is a signature over this task and this moment — nothing else will do', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  const now = Math.floor(Date.now() / 1000)
  const body = { code: 200, data: successData(taskId) }
  const refused = []

  const cases = [
    ['no headers', () => post('/webhooks/kie', body)],
    ['only a timestamp', () => post('/webhooks/kie', body, { 'x-webhook-timestamp': String(now) })],
    ['only a signature', () => post('/webhooks/kie', body, { 'x-webhook-signature': signPayload(taskId, now) })],
    ['an empty signature', () => kie(taskId, body, { signature: ' ' })],
    ['a signature of the wrong length', () => kie(taskId, body, { signature: signPayload(taskId, now).slice(0, 20) })],
    ['a longer signature that starts right', () => kie(taskId, body, { signature: `${signPayload(taskId, now)}AAAA` })],
    ['the secret itself', () => kie(taskId, body, { signature: KIE_SECRET })],
    ['another task\'s signature', () => kie(taskId, body, { signature: signPayload('some-other-task', now) })],
    ['another moment\'s signature', () => kie(taskId, body, { signature: signPayload(taskId, now - 1) })],
    ['a signature made with another secret', () => kie(taskId, body, { secret: 'not-the-secret' })],
    ['a signature made over the body instead', () => kie(taskId, body, { signature: signPayload(JSON.stringify(body), now) })],
    ['a stale moment, signed correctly', () => kie(taskId, body, { timestamp: now - 16 * 60 })],
    ['a moment in the future, signed correctly', () => kie(taskId, body, { timestamp: now + 16 * 60 })],
    ['a moment far in the past', () => kie(taskId, body, { timestamp: 0 })],
    ['a moment that is not a number', () => kie(taskId, body, { timestamp: 'yesterday' })],
    ['Infinity', () => kie(taskId, body, { timestamp: 'Infinity' })],
    ['NaN', () => kie(taskId, body, { timestamp: 'NaN' })],
    ['a negative moment', () => kie(taskId, body, { timestamp: -now })],
    ['a signature with a task id taken from another place in the body', () => kie('decoy', { code: 200, taskId: 'decoy', data: { taskId, state: 'success' } })],
  ]
  for (const [what, send] of cases) {
    const res = await send()
    if (res.status !== 401 && res.status !== 400) refused.push(`${what} → ${res.status}`)
  }
  assert.deepEqual(refused, [], 'every one of those is refused')
  await settle()
  assert.equal((await jobOf(taskId)).state, 'waiting', 'and the job was not touched by any of them')

  // The control: the right proof, for this task, now.
  assert.equal((await kie(taskId, body)).status, 200)
  await stack.waitFor(async () => (await jobOf(taskId)).state === 'success', { what: 'the job to settle' })
})

test('KIE: a valid signature is not a licence — the result must come from KIE\'s hosts, and the job belongs to the account that registered it', async () => {
  const mia = await stack.createUser()
  const bob = await stack.createUser()
  const taskId = await runningJob(mia)

  // A signed callback whose result points somewhere else entirely: nothing is fetched from there.
  for (const url of ['https://evil.test/a.jpg', 'http://169.254.169.254/latest/meta-data/', 'https://tempfile.aiquickdraw.com@evil.test/a.jpg', 'file:///etc/passwd']) {
    const t = await runningJob(mia)
    await kie(t, { code: 200, userId: bob.id, user_id: bob.id, data: { taskId: t, state: 'success', userId: bob.id, resultJson: JSON.stringify({ resultUrls: [url] }) } })
  }
  await settle()
  assert.deepEqual(outbound.filter(u => !u.startsWith('https://tempfile.aiquickdraw.com/')), [], 'nothing outside KIE\'s hosts was ever requested')
  assert.equal((await stack.sql('select count(*)::int as n from assets where user_id = $1', [bob.id]))[0].n, 0, 'nothing was filed for Bob, whatever the payload said about him')

  // A callback for a job nobody here registered cannot invent one.
  await kie('task-nobody-has', { code: 200, data: successData('task-nobody-has') })
  await settle()
  assert.equal((await stack.sql(`select count(*)::int as n from generation_jobs where kie_task_id = 'task-nobody-has'`))[0].n, 0)

  // And the job that was Mia's stays Mia's: the result lands in her storage.
  await kie(taskId, { code: 200, data: successData(taskId) })
  await stack.waitFor(async () => (await jobOf(taskId)).asset_id, { what: 'the result to be collected' })
  const owner = await stack.one('select a.user_id from generation_jobs j join assets a on a.id = j.asset_id where j.kie_task_id = $1', [taskId])
  assert.equal(owner.user_id, mia.id)
})

test('KIE: whatever a signed callback contains, the answer is quick and plain and the server keeps working', async () => {
  const u = await stack.createUser()
  const hostile = [
    null, true, 0, -1, 1.5, 1e308, '', 'x', 'x'.repeat(20_000), '\u0001', '\ud800', '"; drop table users; --', '<script>alert(1)</script>',
    [], [null], ['https://tempfile.aiquickdraw.com/r/out.jpg'], [{}], {}, { a: 1 }, { toString: 'x' }, { length: 5 }, JSON.parse('{"__proto__":{"x":1}}'),
    JSON.stringify({ resultUrls: 'not a list' }), JSON.stringify({ resultUrls: [5, null, {}] }), '{"resultUrls":', 'null', '[]',
  ]
  // Each slot puts a hostile value in one place of an otherwise ordinary success callback. (The two last
  // ones replace the whole `data` or the whole body, so there is no task id to find: a 400, signed or not.)
  const slots = [
    (t, d) => ({ code: d, msg: d, data: successData(t) }),
    (t, d) => ({ code: 200, data: { ...successData(t), state: d } }),
    (t, d) => ({ code: 200, data: { ...successData(t), resultJson: d } }),
    (t, d) => ({ code: 200, data: { ...successData(t), info: d } }),
    (t, d) => ({ code: 200, data: { ...successData(t), resultUrls: d } }),
    (t, d) => ({ code: 200, data: { ...successData(t), failMsg: d, failCode: d } }),
    (t, d) => ({ code: 200, data: { ...successData(t), creditsConsumed: d } }),
    (t, d) => ({ code: 200, data: { ...successData(t), completeTime: d } }),
    (_t, d) => ({ code: 200, data: d }),
    (_t, d) => d,
  ]
  const bad = []
  for (const slot of slots) {
    for (const value of hostile) {
      const taskId = await runningJob(u)
      const sent = slot(taskId, value)
      const res = await kie(taskId, sent)
      if (res.status >= 500) bad.push(`${res.status} ${JSON.stringify(sent)?.slice(0, 90)}`)
    }
  }
  assert.deepEqual(bad, [])
  await settle()
  // Still alive, still correct: a normal callback still works afterwards.
  const taskId = await runningJob(u)
  assert.equal((await kie(taskId, { code: 200, data: successData(taskId) })).status, 200)
  await stack.waitFor(async () => (await jobOf(taskId)).state === 'success', { what: 'a normal callback to still work' })
  assert.deepEqual(outbound.filter(url => !url.startsWith('https://tempfile.aiquickdraw.com/')), [])
})

// ═════════════════════════════ RevenueCat ═════════════════════════════════════

const purchase = (user, over = {}) => ({
  api_version: '1.0',
  event: {
    id: randomUUID(), type: 'NON_RENEWING_PURCHASE', app_user_id: user.id, original_app_user_id: user.id, aliases: [user.id],
    product_id: 'credits_500', transaction_id: `GPA.sec-${++n}`, environment: 'PRODUCTION', event_timestamp_ms: Date.now(), ...over,
  },
})
const rc = (body, authorization = RC_AUTH) => post('/webhooks/revenuecat', body, authorization === null ? {} : { authorization })
const balance = async user => (await stack.api('GET', '/api/billing/me', { token: user.token })).body.balance

test('RevenueCat: the proof is the shared secret, compared whole — and a refusal costs the caller nothing but the refusal', async () => {
  const u = await stack.createUser()
  const wrong = []
  for (const header of [null, '', ' ', RC_AUTH.slice(0, -1), `${RC_AUTH}\n`.trim() + 'x', RC_AUTH.toUpperCase(), `Bearer ${RC_AUTH}`, `Basic ${Buffer.from(RC_AUTH).toString('base64')}`, 'x'.repeat(10_000), RC_AUTH + RC_AUTH]) {
    const res = await rc(purchase(u), header)
    if (res.status !== 401) wrong.push(`${JSON.stringify(header)?.slice(0, 40)} → ${res.status}`)
  }
  assert.deepEqual(wrong, [])
  assert.equal(await balance(u), 0)
  assert.equal((await stack.sql('select count(*)::int as n from billing_events'))[0].n, 0, 'a refused delivery leaves no trace')
  assert.equal((await rc(purchase(u))).status, 200, 'the control')
  assert.equal(await balance(u), 500)
})

test('RevenueCat: what a purchase is worth comes from the price table, never from the delivery', async () => {
  const u = await stack.createUser()
  const res = await rc(purchase(u, {
    credits: 1_000_000, amount: 1_000_000, delta: 1_000_000, quantity: 5000, price: 0.01, price_in_purchased_currency: 0.01,
    takehome_percentage: 1, presented_offering_id: 'free', product_credits: 99999, metadata: { credits: 99999 },
  }))
  assert.equal(res.status, 200)
  assert.equal(await balance(u), 500)
  assert.deepEqual(Object.keys(res.body).sort(), ['ok', 'outcome'], 'and the answer says nothing more than that')
})

test('RevenueCat: a delivery with any field of any type is credited correctly or ignored — never a server error, never someone else\'s account', async () => {
  const u = await stack.createUser()
  const other = await stack.createUser()
  const hostile = [
    null, true, 0, -1, 1.5, 1e308, '', ' ', 'x', 'x'.repeat(5000), '\u0001', '\ud800', "'; drop table users; --", '<b>x</b>',
    [], [null], [5], ['credits_500'], [{}], {}, { a: 1 }, { toString: 'x' }, JSON.parse('{"__proto__":{"x":1}}'),
    other.id, `${u.id} `, u.id.toUpperCase(), '00000000-0000-4000-8000-000000000000',
  ]
  const bad = []
  for (const field of ['type', 'app_user_id', 'original_app_user_id', 'aliases', 'product_id', 'transaction_id', 'original_transaction_id', 'environment', 'event_timestamp_ms', 'store', 'id']) {
    for (const value of hostile) {
      const res = await rc(purchase(u, { [field]: value }))
      if (res.status >= 500) bad.push(`${field}=${JSON.stringify(value)?.slice(0, 40)} → ${res.status} ${res.text.slice(0, 80)}`)
    }
  }
  assert.deepEqual(bad, [])
  // Only the people the deliveries named got anything, and only whole packs of 500.
  const ledger = await stack.sql(`select user_id, delta::float8 as delta from credit_ledger where kind = 'purchase'`)
  assert.ok(ledger.every(r => r.delta === 500 && (r.user_id === u.id || r.user_id === other.id)))
  assert.equal((await rc(purchase(u))).status, 200, 'and it still answers')
})

test('RevenueCat: a body that is not an event, in any shape, is a 400 — before anything is recorded', async () => {
  const bad = []
  for (const body of [undefined, null, [], '', 'text', 5, true, {}, { event: null }, { event: [] }, { event: 'x' }, { event: { id: 5 } }, { event: { id: ['a'], type: 'TEST' } }, { event: { id: 'a', type: ['TEST'] } }, { event: { id: '', type: 'TEST' } }]) {
    const res = await rc(body)
    if (res.status !== 400) bad.push(`${JSON.stringify(body)} → ${res.status}`)
  }
  assert.deepEqual(bad, [])
  assert.equal((await stack.sql('select count(*)::int as n from billing_events'))[0].n, 0)
})

test('RevenueCat: ten identical deliveries at once credit once; ten different ones credit ten times', async () => {
  const u = await stack.createUser()
  const same = purchase(u)
  const answers = await Promise.all(Array.from({ length: 10 }, () => rc(same)))
  assert.ok(answers.every(a => a.status === 200), answers.map(a => a.status).join())
  assert.equal(await balance(u), 500)
  assert.equal(answers.filter(a => a.body.outcome === 'credited').length, 1)

  const v = await stack.createUser()
  const many = await Promise.all(Array.from({ length: 10 }, () => rc(purchase(v))))
  assert.ok(many.every(a => a.status === 200))
  assert.equal(await balance(v), 5000)
})

test('RevenueCat: a refund takes back what that purchase gave, once, and nobody else\'s', async () => {
  const buyer = await stack.createUser()
  const bystander = await stack.createUser()
  await rc(purchase(bystander, { product_id: 'credits_1500', transaction_id: 'GPA.bystander' }))
  const bought = purchase(buyer, { transaction_id: 'GPA.refund-1' })
  await rc(bought)
  assert.equal(await balance(buyer), 500)

  // A "refund" that names the bystander's transaction under the buyer's account takes nothing from anyone.
  await rc(purchase(buyer, { type: 'CANCELLATION', transaction_id: 'GPA.bystander' }))
  assert.equal(await balance(bystander), 1500)
  assert.equal(await balance(buyer), 500)

  // The real one, delivered three times, takes the 500 back once.
  const refund = purchase(buyer, { type: 'CANCELLATION', transaction_id: 'GPA.refund-1' })
  await rc(refund); await rc(refund); await rc({ event: { ...refund.event, id: randomUUID() } })
  assert.equal(await balance(buyer), 0)
  assert.equal(await balance(bystander), 1500)
})

test('both: only POST is answered, and nothing is revealed by trying the others — the answer is the same with or without the secret', async () => {
  for (const path of ['/webhooks/kie', '/webhooks/revenuecat']) {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const bare = await stack.api(method, path, { headers: { 'x-forwarded-for': freshIp() } })
      const withSecret = await stack.api(method, path, { headers: { 'x-forwarded-for': freshIp(), authorization: RC_AUTH, 'x-webhook-signature': 'x', 'x-webhook-timestamp': '1' } })
      assert.equal(bare.status, 405, `${method} ${path}`)
      assert.deepEqual([withSecret.status, withSecret.body], [bare.status, bare.body])
    }
  }
})

test('both: a flood of forged deliveries is slowed down, and a different caller is unaffected', async () => {
  let limited = 0
  for (let i = 0; i < 140; i++) {
    const res = await stack.api('POST', '/webhooks/revenuecat', { body: {}, headers: { 'x-forwarded-for': '10.99.0.1', authorization: 'forged' } })
    if (res.status === 429) limited++
    else assert.equal(res.status, 401)
  }
  assert.ok(limited > 0, 'the flood hit the limit')
  const u = await stack.createUser()
  const fine = await stack.api('POST', '/webhooks/revenuecat', { body: purchase(u), headers: { 'x-forwarded-for': '10.99.0.2', authorization: RC_AUTH } })
  assert.equal(fine.status, 200, 'RevenueCat itself, from its own address, is not caught up in it')
})
