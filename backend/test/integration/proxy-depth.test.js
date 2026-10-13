// The generation proxy and the suggestion endpoint, pushed past the happy path:
// what is forwarded and what is not, what the app is never shown, which paths exist,
// and how the proxy behaves when its inputs are not what the app would send.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack } from '../helpers/stack.js'

let stack
let kie
before(async () => {
  stack = await startStack({ env: { KIE_WEBHOOK_SECRET: 'proxy-depth-secret' } })
  kie = await stack.load('api/kie.js')
})
after(async () => { await stack?.stop() })
beforeEach(async () => {
  await stack.reset()
  delete process.env.KIE_NSFW_CHECKER
  delete process.env.MODERATION_ENABLED
  process.env.PUBLIC_BASE_URL = 'https://api.test.example'
})

const toKie = path => stack.kie.requests.filter(r => r.path === path)
const CALLBACK = 'https://api.test.example/kie-callback'

// ── bodyToForward: exactly what is sent on ──────────────────────────────────

const req = (method, body) => ({ method, body })
const forwarded = (subPath, body, method = 'POST') => {
  const out = kie.bodyToForward(req(method, body), subPath)
  return out === null ? null : typeof out === 'string' ? JSON.parse(out) : out
}
const CREATE = '/api/v1/jobs/createTask'
const VEO = '/api/v1/veo/generate'

test('a read has no body to forward', () => {
  assert.equal(kie.bodyToForward(req('GET', undefined), '/api/v1/jobs/recordInfo'), null)
  assert.equal(kie.bodyToForward(req('HEAD', { a: 1 }), CREATE), null)
})

test('createTask carries the server\'s callback address and nothing else new', () => {
  const sent = forwarded(CREATE, { model: 'kling-3.0/video', input: { prompt: 'p', mode: 'pro' } })
  assert.deepEqual(sent, { model: 'kling-3.0/video', input: { prompt: 'p', mode: 'pro' }, callBackUrl: sent.callBackUrl })
  assert.match(sent.callBackUrl, /^https:\/\/api\.test\.example\//)
})

test('a callback address from the client is never forwarded — replaced where the server has one, removed where it does not', () => {
  const hostile = { model: 'm', input: { prompt: 'p' }, callBackUrl: 'https://evil.example/steal' }
  const withServer = forwarded(CREATE, hostile)
  assert.notEqual(withServer.callBackUrl, 'https://evil.example/steal')
  assert.match(withServer.callBackUrl, /api\.test\.example/)

  assert.equal('callBackUrl' in forwarded(VEO, hostile), false, 'Veo asks for none, and is given none')

  process.env.PUBLIC_BASE_URL = ''
  assert.equal('callBackUrl' in forwarded(CREATE, hostile), false, 'with callbacks off there is simply none')
  assert.equal('callBackUrl' in forwarded(VEO, hostile), false)
  assert.deepEqual(forwarded(CREATE, hostile), { model: 'm', input: { prompt: 'p' } })
})

test('the client\'s other fields survive untouched, in their original order', () => {
  process.env.PUBLIC_BASE_URL = ''
  const body = { z: 1, model: 'm', a: { nested: [1, { deep: true }] }, input: { prompt: 'p', n: 0, flag: false, nothing: null } }
  assert.equal(kie.bodyToForward(req('POST', body), CREATE), JSON.stringify(body))
})

test('KIE\'s own filter is forced on for the models that have one, whatever the client said', () => {
  const sent = forwarded(CREATE, { model: 'wan/2-6-text-to-video', input: { prompt: 'p', nsfw_checker: false } })
  assert.equal(sent.input.nsfw_checker, true)
  assert.equal(sent.input.prompt, 'p')
  assert.equal(forwarded(CREATE, { model: 'kling-3.0/video', input: { prompt: 'p', nsfw_checker: false } }).input.nsfw_checker, false, 'a model without the flag is left as the client sent it')
  assert.equal('nsfw_checker' in forwarded(CREATE, { model: 'kling-3.0/video', input: { prompt: 'p' } }).input, false)
  process.env.KIE_NSFW_CHECKER = 'false'
  assert.equal('nsfw_checker' in forwarded(CREATE, { model: 'wan/2-6-text-to-video', input: { prompt: 'p' } }).input, false, 'and only an explicit false turns it off')
})

test('a filter flag is never invented where the shape is wrong', () => {
  for (const input of [undefined, null, 'text', 5, ['a'], true]) {
    const sent = forwarded(CREATE, { model: 'wan/2-6-text-to-video', input })
    assert.deepEqual(sent.input, input === undefined ? undefined : input, JSON.stringify(input))
  }
})

test('a body that is not an object (an array) is forwarded as it came, with no callback or filter added', () => {
  const body = [{ model: 'm', input: { prompt: 'p' } }]
  assert.deepEqual(forwarded(CREATE, body), body)
})

test('paths that start no work are forwarded as they are', () => {
  const body = { taskId: 'abc', callBackUrl: 'https://anything.example' }
  assert.deepEqual(forwarded('/api/v1/jobs/recordInfo', body), body)
  assert.deepEqual(forwarded('/api/file-base64-upload', { base64Data: 'x' }), { base64Data: 'x' })
})

test('a body that is a string is parsed when it is JSON, and passed on untouched when it is not', () => {
  assert.deepEqual(forwarded(CREATE, JSON.stringify({ model: 'm', input: {} })).input, {})
  assert.equal(kie.bodyToForward(req('POST', 'not json {'), CREATE), 'not json {')
})

// ── What KIE says about cost never reaches the app ──────────────────────────

test('withoutStudioCost removes only data.creditsConsumed', () => {
  const answer = { code: 200, msg: 'ok', data: { taskId: 't', state: 'success', creditsConsumed: 27.5, costTime: 9, resultJson: '{}' } }
  assert.deepEqual(JSON.parse(kie.withoutStudioCost(JSON.stringify(answer))), { code: 200, msg: 'ok', data: { taskId: 't', state: 'success', costTime: 9, resultJson: '{}' } })
  for (const same of [
    JSON.stringify({ code: 422, msg: 'not found' }), JSON.stringify({ code: 200, data: null }), JSON.stringify({ code: 200, data: 'text' }),
    JSON.stringify({ code: 200, data: [1] }), JSON.stringify([1, 2]), '"string"', '5', 'null', 'not json', '', '<html>502</html>',
  ]) {
    assert.equal(kie.withoutStudioCost(same), same, same)
  }
  assert.equal(JSON.parse(kie.withoutStudioCost(JSON.stringify({ data: { creditsConsumed: 0 } }))).data.creditsConsumed, undefined, 'zero is removed too')
})

test('through the proxy, a job\'s status arrives without what it cost — for both kinds of job', async () => {
  const u = await stack.createUser()
  const data = { taskId: 't1', state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://tempfile.aiquickdraw.com/a.jpg'] }), failMsg: '', completeTime: 123, creditsConsumed: 27.5 }
  stack.kie.tasks.set('t1', data)
  for (const path of ['/api/v1/jobs/recordInfo', '/api/v1/veo/record-info']) {
    const res = await stack.api('GET', `/api/kie${path}?taskId=t1`, { token: u.token })
    assert.equal(res.status, 200, path)
    assert.equal(res.body.code, 200)
    assert.equal('creditsConsumed' in res.body.data, false, `${path} leaked the studio's cost`)
    assert.ok(!/27\.5/.test(res.text), 'and the number is nowhere in the answer')
    const { creditsConsumed, ...rest } = data
    void creditsConsumed
    assert.deepEqual(res.body.data, rest, 'everything else is exactly what KIE said')
    assert.equal(res.headers.get('cache-control'), 'private, no-store')
  }
})

test('an unknown task and a failed job pass through as KIE answered', async () => {
  const u = await stack.createUser()
  const missing = await stack.api('GET', '/api/kie/api/v1/jobs/recordInfo?taskId=nope', { token: u.token })
  assert.equal(missing.status, 200)
  assert.deepEqual(missing.body, { code: 422, msg: 'not found' })
  stack.kie.tasks.set('f1', { taskId: 'f1', state: 'fail', failMsg: 'content policy', creditsConsumed: 0 })
  const failed = (await stack.api('GET', '/api/kie/api/v1/jobs/recordInfo?taskId=f1', { token: u.token })).body.data
  assert.equal(failed.state, 'fail')
  assert.equal(failed.failMsg, 'content policy')
  assert.equal('creditsConsumed' in failed, false)
})

test('the account\'s credit balance is hidden from the app', async () => {
  const u = await stack.createUser()
  const res = await stack.api('GET', '/api/kie/api/v1/chat/credit', { token: u.token })
  assert.equal(res.status, 200)
  assert.equal(res.body.data, null)
  assert.ok(!/12345/.test(res.text))
})

// ── Which paths exist ────────────────────────────────────────────────────────

test('only the six paths the app uses are reachable, and every other spelling is refused before KIE is called', async () => {
  const u = await stack.createUser()
  const refused = [
    '/api/v1/jobs/createTask/', '/api/v1/jobs/createtask', '/api/v1/jobs/CREATETASK', '/api/v1/jobs', '/api/v1/jobs/recordInfo/x',
    '/api/v1/chat/credits', '/api/v1/account', '/api/v1/jobs/%2e%2e/createTask', '/api/v1/jobs/..%2fcreateTask', '/api/v1/jobs/createTask%00',
    '/api/v1/jobs/createTask%20', '/v1/jobs/createTask', '/api/file-stream-upload', '/api/file-url-upload', '/api/v1/jobs/delete',
    '/api/v1/veo/extend', '/api/v1/veo/record-info/x', '/', '//', '/api',
  ]
  for (const path of refused) {
    const res = await stack.api('GET', `/api/kie${path}`, { token: u.token })
    assert.ok([400, 404].includes(res.status), `${path} answered ${res.status}`)
    assert.ok(res.body?.code === 'BAD_PATH' || res.status === 404, path)
  }
  assert.equal(stack.kie.requests.length, 0, 'not one of them reached KIE')

  for (const path of ['/api/v1/jobs/recordInfo', '/api/v1/veo/record-info', '/api/v1/chat/credit']) {
    assert.equal((await stack.api('GET', `/api/kie${path}?taskId=x`, { token: u.token })).status, 200, path)
  }
})

test('a client cannot choose the path by sending its own __kiepath', async () => {
  const u = await stack.createUser()
  const smuggled = await stack.api('GET', '/api/kie/api/v1/chat/credit?__kiepath=%2Fapi%2Fv1%2Fadmin%2Fanything', { token: u.token })
  assert.equal(smuggled.status, 200)
  assert.deepEqual(stack.kie.requests.map(r => r.path), ['/api/v1/chat/credit'], 'the path in the URL won')
  stack.kie.requests.length = 0
  const direct = await stack.api('GET', '/api/kie?__kiepath=%2Fapi%2Fv1%2Fchat%2Fcredit', { token: u.token })
  assert.equal(direct.status, 400, 'with no path in the URL there is nothing allowed to ask for')
  assert.equal(stack.kie.requests.length, 0)
})

test('the server\'s key is the only credential KIE sees, whatever the client sends', async () => {
  const u = await stack.createUser()
  await stack.api('GET', '/api/kie/api/v1/chat/credit', { token: u.token, headers: { 'x-api-key': 'client-key', cookie: 'a=b' } })
  assert.equal(stack.kie.requests[0].authorization, 'Bearer test-kie-key')
})

test('a request without a session is refused, and so is one from a suspended account', async () => {
  assert.equal((await stack.api('GET', '/api/kie/api/v1/chat/credit', {})).status, 401)
  const suspended = await stack.createUser({ status: 'suspended' })
  const res = await stack.api('GET', '/api/kie/api/v1/chat/credit', { token: suspended.token })
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'ACCOUNT_SUSPENDED')
  assert.equal(stack.kie.requests.length, 0)
})

// ── Bodies that are not what the app sends ──────────────────────────────────

test('a body that is not valid JSON is a clean 400, and KIE is not called', async () => {
  const u = await stack.createUser()
  const res = await fetch(`${stack.base}/api/kie/api/v1/jobs/createTask`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${u.token}` }, body: '{"model": "m", "input": {',
  })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'BAD_JSON')
  assert.equal(stack.kie.requests.length, 0)
})

test('a prompt sent in a body the server does not read is not forwarded either — it cannot be a way round the check', async () => {
  const u = await stack.createUser()
  for (const [type, body] of [['text/plain', '{"model":"kling-3.0/video","input":{"prompt":"XXX-EXPLICIT"}}'], ['application/x-www-form-urlencoded', 'input=XXX-EXPLICIT']]) {
    await fetch(`${stack.base}/api/kie/api/v1/jobs/createTask`, { method: 'POST', headers: { 'content-type': type, authorization: `Bearer ${u.token}` }, body })
  }
  for (const r of toKie(CREATE)) assert.ok(!JSON.stringify(r.body).includes('EXPLICIT'), 'the unread text never reached KIE')
})

test('a JSON array as the body is checked like any other: its text is read', async () => {
  const u = await stack.createUser()
  const bad = await stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token: u.token, body: [{ input: { prompt: 'XXX-EXPLICIT' } }] })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'CONTENT_BLOCKED')
  assert.equal(toKie(CREATE).length, 0)
})

test('a client-supplied callback address does not reach KIE through the real route either', async () => {
  const u = await stack.createUser()
  await stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token: u.token, body: { model: 'kling-3.0/video', input: { prompt: 'a calm lake' }, callBackUrl: 'https://evil.example/x' } })
  await stack.api('POST', '/api/kie/api/v1/veo/generate', { token: u.token, body: { model: 'veo3_fast', prompt: 'a calm lake', callBackUrl: 'https://evil.example/y' } })
  for (const r of stack.kie.requests.filter(x => x.method === 'POST')) {
    assert.ok(!JSON.stringify(r.body).includes('evil.example'), `${r.path} carried the client's address`)
  }
  assert.equal(toKie(CREATE)[0].body.callBackUrl, CALLBACK.replace('/kie-callback', toKie(CREATE)[0].body.callBackUrl.slice('https://api.test.example'.length)))
})

test('a very large body is refused with a clear status rather than read in full', async () => {
  const u = await stack.createUser()
  const res = await fetch(`${stack.base}/api/kie/api/v1/jobs/createTask`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${u.token}` },
    body: JSON.stringify({ model: 'm', input: { prompt: 'x'.repeat(11 * 1024 * 1024) } }),
  })
  assert.equal(res.status, 413)
  assert.equal(stack.kie.requests.length, 0)
})

test('when KIE refuses the server\'s own key, the app is told generation is unavailable — not that its session ended', async () => {
  const u = await stack.createUser()
  stack.kie.createStatus = { status: 401, body: { code: 401, msg: 'bad key' } }
  const res = await stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token: u.token, body: { model: 'kling-3.0/video', input: { prompt: 'a calm lake' } } })
  assert.equal(res.status, 502)
  assert.equal(res.body.code, 'ENGINE_KEY_REJECTED')
  assert.ok(!/bad key/.test(res.text))
})

test('a failure from KIE is passed on with its own status, so the app can tell a bad request from an outage', async () => {
  const u = await stack.createUser()
  stack.kie.createStatus = { status: 422, body: { code: 422, msg: 'prompt too long' } }
  const res = await stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token: u.token, body: { model: 'kling-3.0/video', input: { prompt: 'a calm lake' } } })
  assert.equal(res.status, 422)
  assert.equal(res.body.msg, 'prompt too long')
})

// ── Suggestions ──────────────────────────────────────────────────────────────

const assist = (token, body) => stack.api('POST', '/api/prompt-assist', { token, body })

test('suggestions: only text is accepted — numbers, lists and objects are "text required", not stringified', async () => {
  const u = await stack.createUser()
  for (const text of [undefined, null, '', '   ', '\n\t', 123, true, [], ['a'], { a: 1 }]) {
    const res = await assist(u.token, { text })
    assert.equal(res.status, 400, JSON.stringify(text))
    assert.equal(res.body.code, 'TEXT_REQUIRED')
  }
  assert.equal(stack.openai.chat.length, 0, 'nothing was sent to the model')
  assert.equal((await assist(u.token, undefined)).status, 400)
})

test('suggestions: the length limit is exact, counted after trimming', async () => {
  const u = await stack.createUser()
  assert.equal((await assist(u.token, { text: 'a'.repeat(2000) })).status, 200)
  const long = await assist(u.token, { text: 'a'.repeat(2001) })
  assert.equal(long.status, 413)
  assert.equal(long.body.code, 'TOO_LONG')
  assert.equal((await assist(u.token, { text: `   ${'a'.repeat(2000)}   ` })).status, 200, 'padding does not count')
})

test('suggestions: a kind that is not one of ours is treated as the default, never used as a lookup key', async () => {
  const u = await stack.createUser()
  for (const kind of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nope', '', null, 5, ['scene'], { a: 1 }]) {
    stack.openai.chat.length = 0
    const res = await assist(u.token, { text: 'a calm lake', kind })
    assert.equal(res.status, 200, JSON.stringify(kind))
    assert.match(stack.openai.chat[0].messages[0].content, /rewrite short descriptions of a person/, `${JSON.stringify(kind)} got the default instructions`)
  }
  stack.openai.chat.length = 0
  await assist(u.token, { text: 'a calm lake', kind: 'script' })
  assert.match(stack.openai.chat[0].messages[0].content, /says to camera/)
  stack.openai.chat.length = 0
  await assist(u.token, { text: 'a calm lake', kind: 'scene' })
  assert.match(stack.openai.chat[0].messages[0].content, /TIMING PHRASE/)
})

test('suggestions: GET and other methods are refused', async () => {
  const u = await stack.createUser()
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const res = await stack.api(method, '/api/prompt-assist', { token: u.token })
    assert.ok([404, 405].includes(res.status), `${method} answered ${res.status}`)
  }
})

test('suggestions: the text sent to the model is exactly what the person wrote, trimmed — nothing more', async () => {
  const u = await stack.createUser()
  await assist(u.token, { text: '  a calm lake at dawn  ', kind: 'scene' })
  const sent = stack.openai.chat[0]
  assert.equal(sent.messages.at(-1).content, 'a calm lake at dawn')
  assert.equal(sent.max_tokens, 220)
  assert.equal(sent.messages.length, 2)
})

test('suggestions: a scene rewrite that keeps its timings is offered; one that loses or changes them is not', async () => {
  const u = await stack.createUser()
  const original = 'she waves at 3s then sits at 10 seconds'
  // The stand-in answers "improved: <input>", which keeps the timings.
  const kept = await assist(u.token, { text: original, kind: 'scene' })
  assert.equal(kept.body.suggestion, `improved: ${original}`)

  const { keepsTimings } = await stack.load('api/prompt-assist.js')
  assert.equal(keepsTimings('waves at 3s', 'waves at 3 seconds'), true, 'same beat, different spelling')
  assert.equal(keepsTimings('waves at 3s', 'waves three seconds in'), false)
  assert.equal(keepsTimings('waves at 3s', 'waves at 4s'), false)
  assert.equal(keepsTimings('waves at 3s and at 5s', 'waves at 3s'), false, 'every beat must survive')
  assert.equal(keepsTimings('waves at 3s', 'waves at 3s and at 9s'), true, 'an extra one is fine')
  assert.equal(keepsTimings('no timing here', 'anything'), true)
  assert.equal(keepsTimings('AT 3S', 'at 3 sec'), true, 'case does not matter')
  assert.equal(keepsTimings('at 03s', 'at 3s'), true, 'leading zeros are the same second')
  assert.equal(keepsTimings('', ''), true)
})

test('suggestions: the other kinds are not held to the timing rule', async () => {
  const u = await stack.createUser()
  const res = await assist(u.token, { text: 'say it at 3s', kind: 'script' })
  assert.equal(res.status, 200)
  assert.ok(res.body.suggestion)
})

test('suggestions: when the model fails, or answers nothing, the person is told there is no suggestion rather than shown an error page', async () => {
  const u = await stack.createUser()
  stack.openai.mode.status = 500
  const down = await assist(u.token, { text: 'a calm lake' })
  assert.ok([502, 503].includes(down.status), String(down.status))
  assert.ok(!/scripted failure/.test(down.text), 'the upstream message is not passed on')
})

test('suggestions: refused text is refused for a suspended account too', async () => {
  const s = await stack.createUser({ status: 'suspended' })
  const res = await assist(s.token, { text: 'a calm lake' })
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'ACCOUNT_SUSPENDED')
  assert.equal(stack.openai.chat.length, 0)
})
