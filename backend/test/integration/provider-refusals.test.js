// When KIE's own filter refuses a task, the admin can see it — and nobody is punished for it.
//
// The wording below is what the real service answered for sexual and graphic-violence
// prompts (a model with `nsfw_checker`, and nano-banana-pro, alike): the task fails with
// failCode 400, nothing is charged.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack } from '../helpers/stack.js'

const SECRET = 'test-webhook-hmac-key'
const REFUSED = 'The input or output was flagged as sensitive. Please try again with different inputs.'
let stack

before(async () => { stack = await startStack({ env: { KIE_WEBHOOK_SECRET: SECRET } }) })
after(async () => { await stack?.stop() })
beforeEach(() => stack.reset())

let n = 0
async function runningJob(user, model = 'wan/2-5-image-to-video') {
  const taskId = `task-provider-${++n}`
  await stack.api('POST', '/api/jobs/register', { token: user.token, body: { entries: [{ taskId, kind: 'video', label: 'Video', model }] } })
  return taskId
}
const settle = async (user, taskId) => (await stack.api('GET', `/api/jobs/sync?taskId=${taskId}`, { token: user.token })).body
const refuse = (taskId, failMsg = REFUSED) => stack.kie.tasks.set(taskId, { taskId, state: 'fail', failMsg, failCode: '400', creditsConsumed: 0 })
const providerEvents = userId => stack.sql(`select * from moderation_events where user_id = $1 and source = 'provider' order by created_at`, [userId])

async function callback(taskId, body) {
  const { signPayload } = await stack.load('api/kie-callback.js')
  const ts = Math.floor(Date.now() / 1000)
  return stack.api('POST', '/webhooks/kie', { body, headers: { 'x-webhook-timestamp': String(ts), 'x-webhook-signature': signPayload(taskId, ts, SECRET) } })
}

test('a refusal by the generator becomes a moderation item that says which task and model', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  refuse(taskId)
  const answer = await settle(u, taskId)
  assert.equal(answer.job.state, 'fail', 'the job fails exactly as before')
  assert.equal(answer.job.fail_msg, REFUSED, 'and the owner still reads the generator\'s own words')

  const [e, ...rest] = await providerEvents(u.id)
  assert.equal(rest.length, 0)
  assert.equal(e.action, 'blocked')
  assert.deepEqual(e.categories, ['flagged-by-generator'])
  assert.equal(e.kie_task_id, taskId)
  assert.equal(e.model, 'wan/2-5-image-to-video')
  assert.equal(e.excerpt, REFUSED)
  assert.equal(e.status, 'open')
})

test('it is recorded once, however many ways the same failure arrives', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  refuse(taskId)
  await settle(u, taskId)
  await settle(u, taskId)
  const res = await callback(taskId, { code: 501, msg: 'Playground task failed.', data: { taskId, state: 'fail', failMsg: REFUSED, failCode: '400', creditsConsumed: 0 } })
  assert.equal(res.status, 200)
  await new Promise(r => setTimeout(r, 200))
  assert.equal((await providerEvents(u.id)).length, 1)
})

test('a failure delivered first by the signed callback is recorded too', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u, 'nano-banana-pro')
  await callback(taskId, { code: 501, msg: 'Playground task failed.', data: { taskId, state: 'fail', failMsg: REFUSED, failCode: '400', creditsConsumed: 0 } })
  await stack.waitFor(async () => (await providerEvents(u.id)).length === 1, { what: 'the refusal to be recorded' })
  assert.equal((await providerEvents(u.id))[0].model, 'nano-banana-pro')
})

test('an ordinary failure is not a refusal: no event for an internal error or a timeout', async () => {
  const u = await stack.createUser()
  for (const failMsg of ['Internal Error', 'Timed out — the generator never reported a result.', 'image download failed', null]) {
    const taskId = await runningJob(u)
    refuse(taskId, failMsg)
    assert.equal((await settle(u, taskId)).job.state, 'fail')
  }
  assert.equal((await providerEvents(u.id)).length, 0)
})

test('it is not a strike: many refusals by the generator never suspend anyone', async () => {
  const u = await stack.createUser()
  for (let i = 0; i < 9; i++) {
    const taskId = await runningJob(u)
    refuse(taskId)
    await settle(u, taskId)
  }
  assert.equal((await providerEvents(u.id)).length, 9)
  const { countStrikes } = await stack.load('api/_lib/moderation/events.js')
  assert.equal(await countStrikes(u.id, 30), 0)
  assert.equal((await stack.one('select status from users where id = $1', [u.id])).status, 'active')
})

test('the admin queue lists them with the new source, filters on it, and a decision needs no file', async () => {
  const admin = await stack.createUser({ email: 'boss@test.example', role: 'admin' })
  const u = await stack.createUser({ email: 'mia@test.example' })
  const taskId = await runningJob(u)
  refuse(taskId)
  await settle(u, taskId)

  const list = await stack.api('GET', '/api/admin/moderation?source=provider', { token: admin.token })
  assert.equal(list.status, 200)
  assert.equal(list.body.total, 1)
  const e = list.body.events[0]
  assert.equal(e.source, 'provider')
  assert.equal(e.email, 'mia@test.example')
  assert.equal(e.assetId, null)
  assert.equal(e.taskId, taskId)

  assert.equal((await stack.api('GET', '/api/admin/moderation?source=nonsense', { token: admin.token })).status, 400)

  const decided = await stack.api('POST', '/api/admin/moderation/resolve', { token: admin.token, body: { eventId: e.id, resolution: 'dismiss' } })
  assert.equal(decided.status, 200)
  assert.equal((await stack.one('select status from moderation_events where id = $1', [e.id])).status, 'dismissed')
})

test('writing the note for an admin can never undo or hide the failure itself', async () => {
  const u = await stack.createUser()
  const taskId = await runningJob(u)
  refuse(taskId)
  // The queue cannot take the row (as if the table were unavailable): the job must still settle.
  await stack.sql('alter table moderation_events rename to moderation_events_away')
  try {
    const answer = await settle(u, taskId)
    assert.equal(answer.job.state, 'fail')
    assert.equal(answer.job.fail_msg, REFUSED)
  } finally {
    await stack.sql('alter table moderation_events_away rename to moderation_events')
  }
})
