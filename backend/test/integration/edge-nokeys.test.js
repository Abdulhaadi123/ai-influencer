// A server started without its keys: the two features that need them say so plainly,
// after checking who is asking, and never reach out to anyone.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack } from '../helpers/stack.js'

let stack
before(async () => { stack = await startStack({ env: { KIE_API_KEY: '', OPENAI_API_KEY: '' } }) })
after(async () => { await stack?.stop() })
beforeEach(() => stack.reset())

test('without a KIE key the proxy says generation is unavailable — to a signed-in person only — and sends nothing', async () => {
  assert.equal((await stack.api('GET', '/api/kie/api/v1/chat/credit', {})).status, 401, 'who is asking comes first')
  const u = await stack.createUser()
  for (const [method, path, body] of [['GET', '/api/kie/api/v1/chat/credit'], ['POST', '/api/kie/api/v1/jobs/createTask', { model: 'm', input: { prompt: 'x' } }], ['GET', '/api/kie/api/v1/jobs/recordInfo?taskId=t']]) {
    const res = await stack.api(method, path, { token: u.token, body })
    assert.equal(res.status, 503, path)
    assert.equal(res.body.code, 'ENGINE_NOT_CONFIGURED', path)
  }
  assert.equal(stack.kie.requests.length, 0)
})

test('without an OpenAI key suggestions are "not available" (501), which the app reads as "hide the feature"', async () => {
  assert.equal((await stack.api('POST', '/api/prompt-assist', { body: { text: 'x' } })).status, 401)
  const u = await stack.createUser()
  const res = await stack.api('POST', '/api/prompt-assist', { token: u.token, body: { text: 'a calm lake' } })
  assert.equal(res.status, 501)
  assert.equal(res.body.code, 'NOT_CONFIGURED')
  assert.equal(stack.openai.chat.length, 0)
})

test('the panel itself still works, and tells the administrator moderation has no key', async () => {
  const admin = await stack.createUser({ role: 'admin' })
  const config = await stack.api('GET', '/api/admin/config', { token: admin.token })
  assert.equal(config.status, 200)
  assert.equal(config.body.moderation.checkerConfigured, false)
  assert.equal(config.body.moderation.enabled, false)
  assert.ok(!/test-openai-key|sk-/.test(config.text), 'and never shows a key')
})
