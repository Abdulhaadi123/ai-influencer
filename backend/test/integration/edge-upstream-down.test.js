// KIE unreachable: the app is told the generator could not be reached — not that its
// own session ended, and not with a stack trace.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { startStack } from '../helpers/stack.js'

const closedPort = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

let stack
before(async () => { stack = await startStack({ env: { KIE_BASE_URL: `http://127.0.0.1:${closedPort}` } }) })
after(async () => { await stack?.stop() })
beforeEach(() => stack.reset())

test('every proxied call answers 502 "could not be reached", for reads and for paid work alike', async () => {
  const u = await stack.createUser()
  for (const [method, path, body] of [['GET', '/api/kie/api/v1/jobs/recordInfo?taskId=t'], ['POST', '/api/kie/api/v1/jobs/createTask', { model: 'kling-3.0/video', input: { prompt: 'a calm lake' } }]]) {
    const res = await stack.api(method, path, { token: u.token, body })
    assert.equal(res.status, 502, path)
    assert.equal(res.body.code, 'ENGINE_UNREACHABLE', path)
    assert.ok(!/ECONNREFUSED|127\.0\.0\.1|stack/i.test(res.text), 'no internals in the answer')
  }
})

test('a refused prompt is still refused (400), without ever trying the generator', async () => {
  const u = await stack.createUser()
  const res = await stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token: u.token, body: { model: 'kling-3.0/video', input: { prompt: 'XXX-EXPLICIT' } } })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'CONTENT_BLOCKED')
})
