// The last corners a coverage report showed no test reached: the rewriting model
// failing or answering oddly, a stored file that has gone missing, and the small
// guards in suspension, enforcement and the audit writer.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack, jpeg } from '../helpers/stack.js'

let stack
before(async () => { stack = await startStack() })
after(async () => { await stack?.stop() })
beforeEach(async () => {
  await stack.reset()
  delete process.env.MODERATION_FAIL_MODE
})

const assist = (token, body) => stack.api('POST', '/api/prompt-assist', { token, body })

// ── Suggestions: what the model may say back ────────────────────────────────

test('when the rewriting model fails the person is told it is unavailable, and the model\'s own words are not passed on', async () => {
  const u = await stack.createUser()
  stack.openai.chatMode.status = 500
  const res = await assist(u.token, { text: 'a calm lake' })
  assert.equal(res.status, 502)
  assert.equal(res.body.code, 'ASSISTANT_UNAVAILABLE')
  assert.ok(!/scripted chat failure/.test(res.text))
})

test('an empty answer, or one that only repeats the text, is "no suggestion" — not an empty box', async () => {
  const u = await stack.createUser()
  for (const content of ['', '   ', 'A calm lake', '"a CALM lake"']) {
    stack.openai.chatMode.content = content
    const res = await assist(u.token, { text: 'a calm lake' })
    assert.equal(res.status, 200, JSON.stringify(content))
    assert.equal(res.body.suggestion, null, JSON.stringify(content))
  }
})

test('quotes the model wraps around its answer are taken off', async () => {
  const u = await stack.createUser()
  stack.openai.chatMode.content = '"A mirror-still lake at dawn."'
  assert.equal((await assist(u.token, { text: 'a calm lake' })).body.suggestion, 'A mirror-still lake at dawn.')
  stack.openai.chatMode.content = "'''A mirror-still lake at dawn.'''"
  assert.equal((await assist(u.token, { text: 'a calm lake' })).body.suggestion, 'A mirror-still lake at dawn.')
})

test('a scene rewrite that drops a timing is not offered; the same answer for any other kind is', async () => {
  const u = await stack.createUser()
  stack.openai.chatMode.content = 'She waves slowly and then sits down.'      // lost "at 3s"
  const scene = await assist(u.token, { text: 'she waves at 3s then sits', kind: 'scene' })
  assert.equal(scene.status, 200)
  assert.equal(scene.body.suggestion, null)
  const appearance = await assist(u.token, { text: 'she waves at 3s then sits', kind: 'appearance' })
  assert.equal(appearance.body.suggestion, 'She waves slowly and then sits down.')
})

test('the answer is never cached by anything between the server and the app', async () => {
  const u = await stack.createUser()
  const res = await assist(u.token, { text: 'a calm lake' })
  assert.equal(res.headers.get('cache-control'), 'private, no-store')
})

// ── A stored file that has gone missing ─────────────────────────────────────

test('a file the library lists but storage no longer has cannot be used, and says why', async () => {
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK') })
  stack.s3.objects.delete(a.key)
  const res = await stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token: u.token, body: { model: 'kling-3.0/video', input: { prompt: 'fine', image_urls: [a.url] } } })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'MEDIA_UNVERIFIABLE')
  assert.equal(stack.kie.requests.length, 0)
  assert.equal((await stack.one('select moderation_status as s from assets where id = $1', [a.id])).s, 'unchecked', 'and it is not marked clear by default')
  assert.equal((await stack.sql('select 1 from moderation_events where user_id = $1', [u.id])).length, 0, 'a missing file is not an offence')
})

test('with the checker down and the operator choosing to let things through, a missing file is let through too — unchecked', async () => {
  process.env.MODERATION_FAIL_MODE = 'open'
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK') })
  stack.s3.objects.delete(a.key)
  const res = await stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token: u.token, body: { model: 'kling-3.0/video', input: { prompt: 'fine', image_urls: [a.url] } } })
  assert.equal(res.status, 200)
})

// ── Small guards ────────────────────────────────────────────────────────────

test('suspending with no reason still records one', async () => {
  const { suspendUser, unsuspendUser } = await stack.load('api/_lib/suspension.js')
  const u = await stack.createUser()
  assert.equal(await suspendUser(u.id, ''), true)
  assert.equal((await stack.one('select suspended_reason as r from users where id = $1', [u.id])).r, 'Suspended.')
  assert.equal(await suspendUser(u.id, 'again'), false, 'already suspended')
  assert.equal(await suspendUser('00000000-0000-4000-8000-000000000000', 'x'), false, 'no such account')
  assert.equal(await unsuspendUser(u.id), true)
  assert.equal(await unsuspendUser(u.id), false, 'not suspended any more')
})

test('enforcement for an account that does not exist, or is already suspended, does nothing more', async () => {
  const { applyEnforcement } = await stack.load('api/_lib/moderation/events.js')
  const config = { strikeLimit: 5, strikeWindowDays: 30, suspendOnMinors: true }
  assert.deepEqual(await applyEnforcement('00000000-0000-4000-8000-000000000000', { config }), { suspended: false, strikes: 0 })
  const u = await stack.createUser({ status: 'suspended' })
  assert.deepEqual(await applyEnforcement(u.id, { hardRule: true, config }), { suspended: true, strikes: 0 })
})

test('recording a refusal copes with every optional field missing, and cuts what is too long', async () => {
  const { recordEvent } = await stack.load('api/_lib/moderation/events.js')
  const u = await stack.createUser()
  await recordEvent({ userId: u.id, source: 'prompt', action: 'blocked' })
  await recordEvent({ userId: u.id, source: 'prompt', action: 'blocked', excerpt: 'x'.repeat(1000), taskId: 't'.repeat(500), model: 'm'.repeat(500) })
  const rows = await stack.sql('select excerpt, kie_task_id, model, categories from moderation_events where user_id = $1 order by created_at, id', [u.id])
  assert.deepEqual(rows[0], { excerpt: null, kie_task_id: null, model: null, categories: [] })
  assert.equal(rows[1].excerpt.length, 400)
  assert.equal(rows[1].kie_task_id.length, 200)
  assert.equal(rows[1].model.length, 200)
})

test('an audit entry needs no target', async () => {
  const { audit } = await stack.load('api/_lib/admin.js')
  const admin = await stack.createUser({ role: 'admin' })
  await audit({ id: admin.id, email: admin.email }, 'test.nothing')
  const [row] = await stack.sql(`select target_type, target_id, details from admin_audit_log where action = 'test.nothing'`)
  assert.deepEqual(row, { target_type: null, target_id: null, details: {} })
})
