// What KIE charged for a job (`creditsConsumed`): read from recordInfo and from
// the callback, written when the job settles, and never rewritten after.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack, jpeg } from '../helpers/stack.js'

const SECRET = 'test-webhook-hmac-key'
let stack
const realFetch = globalThis.fetch

before(async () => {
  stack = await startStack({ env: { KIE_WEBHOOK_SECRET: SECRET } })
  // Result downloads (a successful callback collects the file) come from KIE's CDN.
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://tempfile.aiquickdraw.com/')) {
      const body = jpeg('IMG-OK')
      return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) } })
    }
    return realFetch(input, init)
  }
})
after(async () => { globalThis.fetch = realFetch; await stack?.stop() })
beforeEach(() => stack.reset())

const RESULT = 'https://tempfile.aiquickdraw.com/r/out.jpg'
let n = 0

async function runningJob(user, taskId = `task-credits-${++n}`) {
  await stack.api('POST', '/api/jobs/register', { token: user.token, body: { entries: [{ taskId, kind: 'image', label: 'Image', model: 'nano-banana-pro' }] } })
  return taskId
}
const jobOf = taskId => stack.one('select state, kie_credits, fail_msg from generation_jobs where kie_task_id = $1', [taskId])

const successData = (taskId, extra = {}) => ({
  taskId, state: 'success', resultJson: JSON.stringify({ resultUrls: [RESULT] }), completeTime: Date.now(), ...extra,
})

// ── recordInfo → job ─────────────────────────────────────────────────────────

test('a settled job records what KIE charged, from recordInfo', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  stack.kie.tasks.set(taskId, successData(taskId, { creditsConsumed: 27, costTime: 15 }))

  const res = await stack.api('GET', `/api/jobs/sync?taskId=${taskId}`, { token: u.token })
  assert.equal(res.status, 200)

  const row = await jobOf(taskId)
  assert.equal(row.state, 'success')
  assert.equal(Number(row.kie_credits), 27)
})

test('what KIE charged is not sent to the app', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  stack.kie.tasks.set(taskId, successData(taskId, { creditsConsumed: 27 }))
  const res = await stack.api('GET', `/api/jobs/sync?taskId=${taskId}`, { token: u.token })
  assert.ok(!('kie_credits' in res.body.job), 'the studio\'s cost is not the user\'s business')
  assert.ok(!('credits' in res.body.status), 'nor is it in the normalised KIE answer sent with the job')
  assert.equal(res.body.status.state, 'success', 'the rest of that answer is unchanged')

  const list = await stack.api('GET', '/api/jobs', { token: u.token })
  assert.ok(list.body.jobs.every(j => !('kie_credits' in j)))
})

test('a failed job records zero — which is KIE saying "nothing charged", not "unknown"', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  stack.kie.tasks.set(taskId, { taskId, state: 'fail', failMsg: 'content policy', failCode: '400', creditsConsumed: 0 })

  await stack.api('GET', `/api/jobs/sync?taskId=${taskId}`, { token: u.token })
  const row = await jobOf(taskId)
  assert.equal(row.state, 'fail')
  assert.equal(Number(row.kie_credits), 0)
  assert.equal(row.kie_credits === null, false)
})

test('when KIE does not say, the charge stays unknown rather than becoming zero', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  stack.kie.tasks.set(taskId, successData(taskId))   // no creditsConsumed
  await stack.api('GET', `/api/jobs/sync?taskId=${taskId}`, { token: u.token })
  const row = await jobOf(taskId)
  assert.equal(row.state, 'success')
  assert.equal(row.kie_credits, null)
})

test('junk in the field is unknown, not stored', async () => {
  const u = await stack.createUser()
  for (const junk of ['abc', -5, null, {}, [1]]) {
    const taskId = await runningJob(u)
    stack.kie.tasks.set(taskId, successData(taskId, { creditsConsumed: junk }))
    await stack.api('GET', `/api/jobs/sync?taskId=${taskId}`, { token: u.token })
    assert.equal((await jobOf(taskId)).kie_credits, null, JSON.stringify(junk))
  }
})

test('a settled job is final: a later answer never rewrites what was charged', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  stack.kie.tasks.set(taskId, successData(taskId, { creditsConsumed: 27 }))
  await stack.api('GET', `/api/jobs/sync?taskId=${taskId}`, { token: u.token })

  stack.kie.tasks.set(taskId, successData(taskId, { creditsConsumed: 999 }))
  await stack.api('GET', `/api/jobs/sync?taskId=${taskId}`, { token: u.token })
  assert.equal(Number((await jobOf(taskId)).kie_credits), 27)
})

test('a running job has no charge yet', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  stack.kie.tasks.set(taskId, { taskId, state: 'generating', progress: 40, creditsConsumed: 0 })
  await stack.api('GET', `/api/jobs/sync?taskId=${taskId}`, { token: u.token })
  const row = await jobOf(taskId)
  assert.equal(row.state, 'generating')
  assert.equal(row.kie_credits, null, 'a progress report is not a settlement')
})

test('fractional credits are kept exactly', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  stack.kie.tasks.set(taskId, successData(taskId, { creditsConsumed: 12.375 }))
  await stack.api('GET', `/api/jobs/sync?taskId=${taskId}`, { token: u.token })
  assert.equal(Number((await jobOf(taskId)).kie_credits), 12.375)
})

// ── The callback, through the real endpoint with a real signature ────────────

async function callback(taskId, body, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000), signed = true } = {}) {
  const { signPayload } = await stack.load('api/kie-callback.js')
  return stack.api('POST', '/webhooks/kie', {
    body,
    headers: signed ? { 'x-webhook-timestamp': String(timestamp), 'x-webhook-signature': signPayload(taskId, timestamp, secret) } : {},
  })
}

test('a signed callback records the charge — success shape', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  const res = await callback(taskId, { code: 200, msg: 'success', data: successData(taskId, { creditsConsumed: 60 }) })
  assert.equal(res.status, 200)
  await stack.waitFor(async () => (await jobOf(taskId)).kie_credits !== null, { what: 'the callback to be processed' })
  const row = await jobOf(taskId)
  assert.equal(row.state, 'success')
  assert.equal(Number(row.kie_credits), 60)
})

test('a signed callback records the charge — Veo\'s shape, where the URLs are in data.info', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  await callback(taskId, { code: 200, msg: 'success', data: { taskId, info: { resultUrls: [RESULT] }, creditsConsumed: 35 } })
  await stack.waitFor(async () => (await jobOf(taskId)).kie_credits !== null, { what: 'the callback to be processed' })
  assert.equal(Number((await jobOf(taskId)).kie_credits), 35)
})

test('a failure callback records zero, and the reason', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  await callback(taskId, { code: 501, msg: 'Failed', data: { taskId, state: 'fail', failMsg: 'flagged by the content filter', failCode: '400', creditsConsumed: 0 } })
  await stack.waitFor(async () => (await jobOf(taskId)).state === 'fail', { what: 'the failure to be recorded' })
  const row = await jobOf(taskId)
  assert.equal(Number(row.kie_credits), 0)
  assert.match(row.fail_msg, /content filter/)
})

test('the callback cannot be forged to write a charge: no signature, a wrong secret, or a stale clock are refused', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  const body = { code: 200, data: successData(taskId, { creditsConsumed: 1 }) }

  assert.equal((await callback(taskId, body, { signed: false })).status, 401)
  assert.equal((await callback(taskId, body, { secret: 'not-the-secret' })).status, 401)
  assert.equal((await callback(taskId, body, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status, 401)
  await new Promise(r => setTimeout(r, 150))
  const row = await jobOf(taskId)
  assert.equal(row.state, 'waiting')
  assert.equal(row.kie_credits, null)
})

test('the owner and the charge come from our row, never from the payload', async () => {
  const owner = await stack.createUser()
  const stranger = await stack.createUser()
  const taskId = await runningJob(owner)
  await callback(taskId, { code: 200, userId: stranger.id, data: successData(taskId, { creditsConsumed: 8, userId: stranger.id }) })
  await stack.waitFor(async () => (await jobOf(taskId)).kie_credits !== null, { what: 'the callback to be processed' })
  const row = await stack.one('select user_id from generation_jobs where kie_task_id = $1', [taskId])
  assert.equal(row.user_id, owner.id)
})

test('the same callback delivered twice changes nothing the second time', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  const body = { code: 200, data: successData(taskId, { creditsConsumed: 60 }) }
  await callback(taskId, body)
  await stack.waitFor(async () => (await jobOf(taskId)).kie_credits !== null, { what: 'the first delivery' })
  await callback(taskId, { code: 200, data: successData(taskId, { creditsConsumed: 61 }) })
  await new Promise(r => setTimeout(r, 200))
  assert.equal(Number((await jobOf(taskId)).kie_credits), 60)
})

test('a callback whose job is not recorded yet is left to the worker, not lost or invented', async () => {
  const res = await callback('task-nobody-registered', { code: 200, data: successData('task-nobody-registered', { creditsConsumed: 5 }) })
  assert.equal(res.status, 200)
  await new Promise(r => setTimeout(r, 150))
  assert.equal((await stack.sql('select 1 from generation_jobs')).length, 0)
})

test('the worker settles a job the callback never delivered, with its charge', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  stack.kie.tasks.set(taskId, successData(taskId, { creditsConsumed: 18 }))
  const { cycle } = await stack.load('server/worker.js')
  await cycle()
  await stack.waitFor(async () => (await jobOf(taskId)).kie_credits !== null, { what: 'the worker to settle the job' })
  assert.equal(Number((await jobOf(taskId)).kie_credits), 18)
})

test('createTask asks for a callback now that one is configured, and says where', async () => {
  const u = await stack.createUser()
  await stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token: u.token, body: { model: 'kling-3.0/video', input: { prompt: 'hello there' } } })
  const sent = stack.kie.requests.find(r => r.path === '/api/v1/jobs/createTask')
  assert.equal(sent.body.callBackUrl, 'https://api.test.example/webhooks/kie')
})
