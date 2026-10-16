import test from 'node:test'
import assert from 'node:assert/strict'

import { collectInputs, classifyMediaUrl } from '../../api/_lib/moderation/inputs.js'

const USER = '11111111-2222-3333-4444-555555555555'
const KEY = `users/${USER}/2026/10/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg`

// ── What is read ─────────────────────────────────────────────────────────────

test('a Kling-shaped request: the prompt is text, the images are links, options are neither', () => {
  const { text, urls } = collectInputs({
    model: 'kling-3.0/video',
    callBackUrl: 'https://api.example.com/webhooks/kie',
    input: {
      prompt: 'She walks down a street at dusk and smiles.',
      image_urls: ['https://bucket.s3.us-east-2.amazonaws.com/a.jpg', 'https://bucket.s3.us-east-2.amazonaws.com/b.jpg'],
      mode: 'pro', duration: '10', aspect_ratio: '9:16', sound: true,
    },
  })
  assert.equal(text, 'She walks down a street at dusk and smiles.')
  assert.deepEqual(urls.map(u => u.url), ['https://bucket.s3.us-east-2.amazonaws.com/a.jpg', 'https://bucket.s3.us-east-2.amazonaws.com/b.jpg'])
  assert.equal(urls[0].key, 'image_urls')
})

test('the model id and the callback URL are the server\'s business, not content', () => {
  const { text, urls } = collectInputs({ model: 'a long model name with spaces', callBackUrl: 'https://x.test/cb', input: {} })
  assert.equal(text, '')
  assert.deepEqual(urls, [])
})

test('a one-word prompt is still a prompt — a short value in a text-named field is read', () => {
  assert.equal(collectInputs({ input: { prompt: 'nude' } }).text, 'nude')
  assert.equal(collectInputs({ input: { negative_prompt: 'blur' } }).text, 'blur')
  assert.equal(collectInputs({ input: { script: 'hi' } }).text, 'hi')
})

test('short option-like values in other fields are not sent to the classifier', () => {
  const { text } = collectInputs({ input: { resolution: '720p', aspect_ratio: '9:16', generation_type: 'REFERENCE_2_VIDEO', quality: 'high' } })
  assert.equal(text, '')
})

test('prose in a field nobody listed is still read: whitespace or length gives it away', () => {
  assert.equal(collectInputs({ input: { some_new_field: 'two words' } }).text, 'two words')
  const long = 'x'.repeat(30)
  assert.equal(collectInputs({ input: { some_new_field: long } }).text, long)
})

test('nested structures are walked: multi_prompt, elements, arrays of objects', () => {
  const { text, urls } = collectInputs({
    model: 'kling-3.0/video',
    input: {
      multi_prompt: [{ prompt: 'first shot', duration: '3' }, { prompt: 'second shot', duration: '2' }],
      kling_elements: [{ name: 'bottle', description: 'a glass bottle', element_input_urls: ['https://x.kie.ai/e.png'] }],
    },
  })
  assert.equal(text, ['first shot', 'second shot', 'bottle', 'a glass bottle'].join('\n'))
  assert.deepEqual(urls.map(u => u.url), ['https://x.kie.ai/e.png'])
})

test('Veo\'s flat body (no `input` wrapper) is read the same way', () => {
  const { text, urls } = collectInputs({ prompt: 'a calm lake', imageUrls: ['https://a.kie.ai/x.png'], model: 'veo3_fast' })
  assert.equal(text, 'a calm lake')
  assert.equal(urls.length, 1)
})

test('an `input` sent as a JSON string is unwrapped, not skipped', () => {
  const { text, urls } = collectInputs({
    model: 'm',
    input: JSON.stringify({ prompt: 'hidden in a string', image_urls: ['https://evil.example.com/a.png'] }),
  })
  assert.equal(text, 'hidden in a string')
  assert.deepEqual(urls.map(u => u.url), ['https://evil.example.com/a.png'])
})

test('an `input` string that is not JSON is read as text', () => {
  assert.equal(collectInputs({ model: 'm', input: 'just some words here' }).text, 'just some words here')
})

test('duplicates are read once; blanks and non-strings are ignored', () => {
  const { text } = collectInputs({ input: { prompt: 'same words', other: 'same words', blank: '   ', n: 5, flag: false, nothing: null } })
  assert.equal(text, 'same words')
})

test('data: URIs and http(s) links are links, never text', () => {
  const { text, urls } = collectInputs({ input: { image_urls: ['data:image/png;base64,AAAA', 'http://x.test/a.png'] } })
  assert.equal(text, '')
  assert.equal(urls.length, 2)
})

test('hostile shapes cannot hang or blow the stack', () => {
  let deep = { prompt: 'bottom' }
  for (let i = 0; i < 5000; i++) deep = { child: deep }
  assert.doesNotThrow(() => collectInputs({ input: deep }))

  const wide = { input: Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, `value number ${i}`])) }
  const { text } = collectInputs(wide)
  assert.ok(text.split('\n').length <= 2000, 'bounded by the node cap')

  const cyclic = { input: {} }
  cyclic.input.self = cyclic  // JSON bodies cannot be cyclic, but a bug elsewhere must not hang this
  assert.doesNotThrow(() => collectInputs(cyclic))
})

test('nothing to read is empty, not an error', () => {
  for (const payload of [null, undefined, {}, [], 'string', 7]) {
    const out = collectInputs(payload)
    assert.equal(typeof out.text, 'string')
    assert.ok(Array.isArray(out.urls))
  }
})

// ── Where a link points ──────────────────────────────────────────────────────

const where = { bucket: 'my-bucket', endpoint: '' }

test('virtual-hosted S3 links into our bucket are our files', () => {
  assert.deepEqual(
    classifyMediaUrl(`https://my-bucket.s3.us-east-2.amazonaws.com/${KEY}?X-Amz-Signature=abc`, where),
    { kind: 'own', key: KEY },
  )
  assert.deepEqual(classifyMediaUrl(`https://my-bucket.s3.amazonaws.com/${KEY}`, where), { kind: 'own', key: KEY })
})

test('path-style S3 links into our bucket are our files', () => {
  assert.deepEqual(classifyMediaUrl(`https://s3.us-east-2.amazonaws.com/my-bucket/${KEY}`, where), { kind: 'own', key: KEY })
})

test('a custom S3 endpoint is recognised by its host, path-style', () => {
  const custom = { bucket: 'my-bucket', endpoint: 'http://127.0.0.1:9000' }
  assert.deepEqual(classifyMediaUrl(`http://127.0.0.1:9000/my-bucket/${KEY}`, custom), { kind: 'own', key: KEY })
  assert.equal(classifyMediaUrl(`http://127.0.0.1:9001/my-bucket/${KEY}`, custom).kind, 'other')
})

test('someone else\'s bucket, or a path outside users/, is not ours', () => {
  assert.equal(classifyMediaUrl(`https://other-bucket.s3.us-east-2.amazonaws.com/${KEY}`, where).kind, 'other')
  assert.equal(classifyMediaUrl('https://my-bucket.s3.us-east-2.amazonaws.com/backups/dump.sql', where).kind, 'other')
  assert.equal(classifyMediaUrl('https://my-bucket.s3.us-east-2.amazonaws.com/users/not-a-uuid/x.jpg', where).kind, 'other')
})

test('a look-alike host is not ours', () => {
  assert.equal(classifyMediaUrl(`https://my-bucket.s3.us-east-2.amazonaws.com.evil.test/${KEY}`, where).kind, 'other')
  assert.equal(classifyMediaUrl(`https://evil.test/my-bucket/${KEY}`, where).kind, 'other')
  assert.equal(classifyMediaUrl(`http://my-bucket.s3.us-east-2.amazonaws.com/${KEY}`, where).kind, 'other', 'plain http is never AWS')
})

test('KIE\'s own hosts are KIE files; look-alikes are not', () => {
  assert.equal(classifyMediaUrl('https://tempfile.aiquickdraw.com/r/abc.mp4', where).kind, 'kie')
  assert.equal(classifyMediaUrl('https://kieai.redpandaai.co/files/a.png', where).kind, 'kie')
  assert.equal(classifyMediaUrl('https://aiquickdraw.com.evil.test/a.png', where).kind, 'other')
  assert.equal(classifyMediaUrl('http://tempfile.aiquickdraw.com/a.png', where).kind, 'other', 'KIE links are https')
})

test('anything else — other hosts, data URIs, junk — cannot be checked', () => {
  for (const url of ['https://images.example.com/a.jpg', 'data:image/png;base64,AAAA', 'ftp://x/y', 'not a url', '', 'javascript:alert(1)', 'file:///etc/passwd']) {
    assert.equal(classifyMediaUrl(url, where).kind, 'other', url)
  }
})

test('a control character anywhere in a link makes it uncheckable — it never reaches a request', () => {
  for (const url of [
    'https://tempfile.aiquickdraw.com/a\u0000.png',
    'https://tempfile.aiquickdraw.com/a.png\n',
    'https://tempfile.aiquickdraw.com/a\r\nHost: evil.test',
    'https://tempfile.aiquickdraw.com/a\u007f.png',
    `https://my-bucket.s3.us-east-2.amazonaws.com/${KEY}\u0001`,
  ]) assert.equal(classifyMediaUrl(url, where).kind, 'other', JSON.stringify(url))
})

test('a link that is not a string is not a link', () => {
  for (const v of [null, undefined, 5, {}, [], ['https://tempfile.aiquickdraw.com/a.png']]) {
    assert.equal(classifyMediaUrl(v, where).kind, 'other')
  }
})

test('with no bucket configured nothing is "ours"', () => {
  assert.equal(classifyMediaUrl(`https://my-bucket.s3.us-east-2.amazonaws.com/${KEY}`, { bucket: '' }).kind, 'other')
})

test('a malformed percent-escape does not throw', () => {
  assert.doesNotThrow(() => classifyMediaUrl('https://my-bucket.s3.us-east-2.amazonaws.com/users/%E0%A4%A/x.jpg', where))
})
