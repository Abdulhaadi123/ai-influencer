// The classifier client, against a local stand-in for OpenAI's moderation endpoint.

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { classify, splitForRequests, timeoutFor, textItem, imageItem, ModerationUnavailableError, MAX_TEXT_CHARS, MAX_IMAGES_PER_REQUEST } from '../../api/_lib/moderation/openai.js'
import { moderationConfig } from '../../api/_lib/moderation/config.js'
import { evaluate } from '../../api/_lib/moderation/policy.js'

/** A server whose answers are scripted: each request takes the next step. */
async function fakeApi(steps) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', async () => {
      requests.push({ url: req.url, method: req.method, headers: req.headers, body: body ? JSON.parse(body) : null })
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]
      if (step.hang) return   // never answers
      if (step.delayMs) await new Promise(r => setTimeout(r, step.delayMs))
      res.writeHead(step.status ?? 200, { 'content-type': 'application/json' })
      res.end(typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {}))
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  return { requests, baseUrl, close: () => { server.closeAllConnections?.(); return new Promise(r => server.close(r)) } }
}

const cfgFor = (baseUrl, extra = {}) => moderationConfig({ OPENAI_API_KEY: 'sk-test-key', OPENAI_BASE_URL: baseUrl, ...extra })

const reply = (scores, flagged = false) => ({
  results: [{ flagged, categories: {}, category_scores: scores }],
})

test('a text goes out in the documented request shape, with the key in the header only', async () => {
  const api = await fakeApi([{ body: reply({ sexual: 0.01 }) }])
  try {
    const out = await classify([textItem('hello world')], { config: cfgFor(api.baseUrl) })
    assert.equal(out.scores.sexual, 0.01)

    const [req] = api.requests
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/v1/moderations')
    assert.equal(req.headers.authorization, 'Bearer sk-test-key')
    assert.deepEqual(req.body, { model: 'omni-moderation-latest', input: [{ type: 'text', text: 'hello world' }] })
    assert.ok(!JSON.stringify(req.body).includes('sk-test-key'), 'the key is never in the body')
  } finally { await api.close() }
})

test('an image is sent as a data URL with its real type', async () => {
  const api = await fakeApi([{ body: reply({}) }])
  try {
    await classify([imageItem(Buffer.from([1, 2, 3]), 'image/png')], { config: cfgFor(api.baseUrl) })
    assert.deepEqual(api.requests[0].body.input, [{ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}` } }])
  } finally { await api.close() }
})

test('several results — whether the API answers per item or once — are merged to the worst', async () => {
  const api = await fakeApi([{ body: { results: [
    { flagged: false, categories: {}, category_scores: { sexual: 0.1, violence: 0.9 } },
    { flagged: true, categories: { sexual: true }, category_scores: { sexual: 0.8 } },
  ] } }])
  try {
    const out = await classify([textItem('one'), textItem('two')], { config: cfgFor(api.baseUrl) })
    assert.equal(api.requests.length, 1, 'text items travel together')
    assert.equal(out.scores.sexual, 0.8)
    assert.equal(out.scores.violence, 0.9)
    assert.equal(out.flagged, true)
    assert.equal(evaluate(out).action, 'review')
  } finally { await api.close() }
})

test('the endpoint takes one image per request, so a video\'s frames go out one each and the worst wins', async () => {
  // Found against the real endpoint: four images in one request is HTTP 400 `too_many_images`.
  const api = await fakeApi([
    { body: reply({ sexual: 0.1 }) },
    { body: reply({ sexual: 0.9 }, true) },
    { body: reply({ violence: 0.4 }) },
  ])
  try {
    const frames = ['a', 'b', 'c'].map(x => imageItem(Buffer.from(x), 'image/jpeg'))
    const out = await classify(frames, { config: cfgFor(api.baseUrl) })
    assert.equal(api.requests.length, 3)
    assert.ok(api.requests.every(r => r.body.input.length === 1 && r.body.input[0].type === 'image_url'))
    assert.deepEqual(api.requests.map(r => r.body.input[0].image_url.url).sort(), frames.map(f => f.image_url.url).sort(), 'every frame was sent, none twice')
    assert.equal(out.scores.sexual, 0.9)
    assert.equal(out.scores.violence, 0.4)
    assert.equal(evaluate(out).action, 'block')
  } finally { await api.close() }
})

test('text rides with the first image only', async () => {
  const api = await fakeApi([{ body: reply({}) }])
  try {
    await classify([textItem('caption'), imageItem(Buffer.from('a'), 'image/png'), imageItem(Buffer.from('b'), 'image/png')], { config: cfgFor(api.baseUrl) })
    const shapes = api.requests.map(r => r.body.input.map(i => i.type)).sort((x, y) => y.length - x.length)
    assert.deepEqual(shapes, [['text', 'image_url'], ['image_url']])
  } finally { await api.close() }
})

test('one frame that cannot be checked makes the whole check unavailable — never "allowed"', async () => {
  const api = await fakeApi([{ body: reply({}) }, { status: 401, body: { error: { message: 'no' } } }])
  try {
    await assert.rejects(
      classify(['a', 'b'].map(x => imageItem(Buffer.from(x), 'image/jpeg')), { config: cfgFor(api.baseUrl) }),
      e => e instanceof ModerationUnavailableError,
    )
  } finally { await api.close() }
})

test('splitForRequests: nothing to split stays one request; images are separated; text stays in the first', () => {
  const t1 = textItem('a'), t2 = textItem('b')
  const i1 = imageItem(Buffer.from('1'), 'image/png'), i2 = imageItem(Buffer.from('2'), 'image/png'), i3 = imageItem(Buffer.from('3'), 'image/png')
  assert.deepEqual(splitForRequests([t1, t2]), [[t1, t2]])
  assert.deepEqual(splitForRequests([t1, i1]), [[t1, i1]])
  assert.deepEqual(splitForRequests([i1]), [[i1]])
  assert.deepEqual(splitForRequests([t1, i1, t2, i2, i3]), [[t1, t2, i1], [i2], [i3]])
  assert.equal(MAX_IMAGES_PER_REQUEST, 1)
})

test('text is cut to a sane length before it is sent', async () => {
  const api = await fakeApi([{ body: reply({}) }])
  try {
    await classify([textItem('x'.repeat(MAX_TEXT_CHARS * 2))], { config: cfgFor(api.baseUrl) })
    assert.equal(api.requests[0].body.input[0].text.length, MAX_TEXT_CHARS)
  } finally { await api.close() }
})

test('a server error is retried once, and the second answer is used', async () => {
  const api = await fakeApi([{ status: 503, body: { error: 'overloaded' } }, { body: reply({ violence: 0.4 }) }])
  try {
    const out = await classify([textItem('hi')], { config: cfgFor(api.baseUrl) })
    assert.equal(out.scores.violence, 0.4)
    assert.equal(api.requests.length, 2)
  } finally { await api.close() }
})

test('429 is retried; two failures in a row give up (no retry storm)', async () => {
  const api = await fakeApi([{ status: 429, body: {} }])
  try {
    await assert.rejects(classify([textItem('hi')], { config: cfgFor(api.baseUrl) }), e => {
      assert.ok(e instanceof ModerationUnavailableError)
      assert.equal(e.retryable, true)
      assert.match(e.message, /HTTP 429/)
      return true
    })
    assert.equal(api.requests.length, 2, 'exactly one retry')
  } finally { await api.close() }
})

test('a rejected key is not retried — retrying cannot fix it', async () => {
  const api = await fakeApi([{ status: 401, body: { error: { message: 'Incorrect API key provided: sk-test-key' } } }])
  try {
    await assert.rejects(classify([textItem('hi')], { config: cfgFor(api.baseUrl) }), e => {
      assert.ok(e instanceof ModerationUnavailableError)
      assert.equal(e.retryable, false)
      return true
    })
    assert.equal(api.requests.length, 1)
  } finally { await api.close() }
})

test('an answer with no results, or that is not JSON, is "unavailable", never "allowed"', async () => {
  for (const body of [{ results: [] }, {}, 'not json at all', { results: 'nope' }]) {
    const api = await fakeApi([{ body }])
    try {
      await assert.rejects(classify([textItem('hi')], { config: cfgFor(api.baseUrl) }), ModerationUnavailableError, JSON.stringify(body))
    } finally { await api.close() }
  }
})

test('a service that never answers times out and is retried once', async () => {
  const api = await fakeApi([{ hang: true }])
  try {
    await assert.rejects(
      classify([textItem('hi')], { config: cfgFor(api.baseUrl, { MODERATION_TIMEOUT_MS: '150' }) }),
      e => e instanceof ModerationUnavailableError && e.retryable === true,
    )
    assert.equal(api.requests.length, 2)
  } finally { await api.close() }
})

test('timeoutFor: the flat limit, plus a few seconds per megabyte, capped', () => {
  const cfg = { timeoutMs: 15_000 }
  assert.equal(timeoutFor(0, cfg), 15_000)
  assert.equal(timeoutFor(2_000, cfg), 15_006, 'text and frames stay at the flat limit, give or take a few milliseconds')
  assert.equal(timeoutFor(2_700_000, cfg), 15_000 + 8_100, 'a 2 MB image (2.7 MB encoded) once timed out at 15 s against the real service')
  assert.equal(timeoutFor(500_000_000, cfg), 15_000 + 30_000, 'a huge file does not hold a request for minutes')
})

test('a large image is given the time it needs; a small request keeps the short limit', async () => {
  // Answers after 400 ms; the flat limit is 150 ms.
  const slow = await fakeApi([{ delayMs: 400, body: reply({ sexual: 0.02 }) }])
  try {
    const config = cfgFor(slow.baseUrl, { MODERATION_TIMEOUT_MS: '150' })
    await assert.rejects(classify([textItem('hi')], { config }), e => e instanceof ModerationUnavailableError && /could not be reached/.test(e.message))

    const big = imageItem(Buffer.alloc(900_000, 7), 'image/png')   // ~1.2 MB once encoded
    const out = await classify([big], { config })
    assert.equal(out.scores.sexual, 0.02)
  } finally { await slow.close() }
})

test('an unreachable service is "unavailable"', async () => {
  await assert.rejects(
    classify([textItem('hi')], { config: cfgFor('http://127.0.0.1:1/v1') }),
    e => e instanceof ModerationUnavailableError && /could not be reached/.test(e.message),
  )
})

test('no key: unavailable, and no request is attempted', async () => {
  const config = moderationConfig({})
  await assert.rejects(classify([textItem('hi')], { config, fetchImpl: () => assert.fail('must not call out') }), /OPENAI_API_KEY is not set/)
})

test('nothing to classify is a clean result without a request', async () => {
  const out = await classify([], { config: moderationConfig({ OPENAI_API_KEY: 'k' }), fetchImpl: () => assert.fail('must not call out') })
  assert.equal(out.flagged, false)
  assert.equal(evaluate(out).action, 'allow')
})
