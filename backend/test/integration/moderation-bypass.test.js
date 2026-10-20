// Ways round content moderation, and that each is closed.
//
// Every hole here was found by driving the real app, not by reading it, and each test
// asserts the SAFE outcome — a failure is a way an unchecked file gets to the generator:
//
//   1. a file is audio because the CLIENT said so (an `audio/…` path, a `data:audio/…`
//      header, an `audio` content type), and audio is never read;
//   2. a link on KIE's hosts is trusted for its host, whatever it shows;
//   3. an upload is checked, then replaced through its still-valid upload link.
//
// What must keep working is tested alongside: real audio, files from before sealing
// existed, and anything the server wrote itself.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack, jpeg, notAnImage } from '../helpers/stack.js'

let stack
const realFetch = globalThis.fetch

/** What KIE's hosts answer, by URL — installed over fetch for the whole file. */
const cdn = new Map()
const fetched = []      // every URL the server asked a CDN for, in order
const imageResponse = body => new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) } })

before(async () => {
  stack = await startStack()
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (/^https:\/\/([a-z0-9-]+\.)*(aiquickdraw\.com|redpandaai\.co|kie\.ai)\//i.test(url)) {
      fetched.push(url)
      const answer = cdn.get(url)
      if (answer === undefined) return new Response('not found', { status: 404 })
      if (answer instanceof Error) throw answer
      return typeof answer === 'function' ? answer() : answer
    }
    if (url.startsWith('https://evil.example.com/')) { fetched.push(url); return imageResponse(jpeg('IMG-EXPLICIT')) }
    return realFetch(input, init)
  }
})
after(async () => { globalThis.fetch = realFetch; await stack?.stop() })
beforeEach(async () => {
  await stack.reset()
  cdn.clear(); fetched.length = 0
  delete process.env.MODERATION_ENABLED
  delete process.env.MODERATION_FAIL_MODE
})

const b64 = bytes => bytes.toString('base64')
const createTask = (token, input) => stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token, body: { model: 'kling-3.0/video', input } })
const upload = (token, base64Data, uploadPath = 'images/base64') =>
  stack.api('POST', '/api/kie/api/file-base64-upload', { token, body: { base64Data, uploadPath, fileName: 'x' } })
const confirm = (token, assetId) => stack.api('POST', '/api/storage/confirm', { token, body: { assetId } })

const uploadsToKie = () => stack.kie.requests.filter(r => r.path === '/api/file-base64-upload')
const tasksToKie = () => stack.kie.requests.filter(r => r.path === '/api/v1/jobs/createTask')
const classifierCalls = () => stack.openai.requests.length
const events = userId => stack.sql('select source, action, status, asset_id from moderation_events where user_id = $1 order by created_at, id', [userId])
const assetRow = id => stack.one('select s3_key, sealed_at, moderation_status, origin from assets where id = $1', [id])

// Real audio, as each of the three formats the app stores begins.
const mp3 = () => Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0x21]), Buffer.alloc(64, 7)])
const wav = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(64, 7)])
const m4a = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(64, 7)])

// ═════════════════════════════════════════════════════════════════════════════
// 1. A file is not audio because the client says so
// ═════════════════════════════════════════════════════════════════════════════

test('CONTROL: an explicit image uploaded as an image is refused and never leaves the server', async () => {
  const u = await stack.createUser()
  const res = await upload(u.token, `data:image/jpeg;base64,${b64(jpeg('IMG-EXPLICIT'))}`)
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'CONTENT_BLOCKED')
  assert.equal(uploadsToKie().length, 0)
})

test('an explicit image sent with an "audio/…" uploadPath is refused, not forwarded, and counts as a strike', async () => {
  const u = await stack.createUser()
  const res = await upload(u.token, `data:image/jpeg;base64,${b64(jpeg('IMG-EXPLICIT'))}`, 'audio/base64')
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'CONTENT_BLOCKED')
  assert.equal(uploadsToKie().length, 0, 'the label did not skip the check')
  assert.deepEqual((await events(u.id)).map(e => [e.source, e.action]), [['image', 'blocked']])
})

test('an explicit image under a "data:audio/…" header is refused and not forwarded', async () => {
  const u = await stack.createUser()
  const res = await upload(u.token, `data:audio/mpeg;base64,${b64(jpeg('IMG-EXPLICIT'))}`)
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'CONTENT_BLOCKED')
  assert.equal(uploadsToKie().length, 0)
})

test('both labels together make no difference', async () => {
  const u = await stack.createUser()
  const res = await upload(u.token, `data:audio/wav;base64,${b64(jpeg('IMG-EXPLICIT'))}`, 'audio/base64')
  assert.equal(res.body.code, 'CONTENT_BLOCKED')
  assert.equal(uploadsToKie().length, 0)
})

test('a clean image labelled audio is still checked — and goes through, being clean', async () => {
  const u = await stack.createUser()
  const res = await upload(u.token, `data:audio/mpeg;base64,${b64(jpeg('IMG-OK'))}`, 'audio/base64')
  assert.equal(res.status, 200)
  assert.equal(classifierCalls(), 1, 'it was read, whatever it was called')
  assert.equal(uploadsToKie().length, 1)
})

for (const [name, make] of [['an MP3', mp3], ['a WAV', wav], ['an M4A', m4a]]) {
  test(`${name} is audio by its bytes: forwarded without a classifier call, labelled or not`, async () => {
    const u = await stack.createUser()
    for (const [header, path] of [['audio/mpeg', 'audio/base64'], ['application/octet-stream', 'images/base64'], ['application/octet-stream', 'files/base64']]) {
      const res = await upload(u.token, `data:${header};base64,${b64(make())}`, path)
      assert.equal(res.status, 200, `${header} / ${path}`)
    }
    assert.equal(classifierCalls(), 0)
    assert.equal(uploadsToKie().length, 3)
  })
}

test('bytes that are nothing we recognise are refused even when called audio', async () => {
  const u = await stack.createUser()
  for (const bytes of [notAnImage(), Buffer.from('this is not any kind of media file at all, honest')]) {
    const res = await upload(u.token, `data:audio/mpeg;base64,${b64(bytes)}`, 'audio/base64')
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'MEDIA_UNVERIFIABLE')
  }
  assert.equal(uploadsToKie().length, 0)
})

test('a video called audio is judged as a video: here an unreadable one, so it cannot go through', async () => {
  const u = await stack.createUser()
  const notReallyAVideo = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64, 1)])
  const res = await upload(u.token, `data:audio/mp4;base64,${b64(notReallyAVideo)}`, 'audio/base64')
  assert.ok(res.status >= 400, `answered ${res.status}`)
  assert.equal(uploadsToKie().length, 0)
})

// The same bypass through the stored-file path: the asset's kind is chosen by the uploader
// when it asks for the upload link.

test('a stored file the uploader DECLARED audio is read for what it is: an explicit image is blocked', async () => {
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, kind: 'audio', bytes: jpeg('IMG-EXPLICIT') })
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [a.url] })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'CONTENT_BLOCKED')
  assert.equal(tasksToKie().length, 0)
  assert.equal((await assetRow(a.id)).moderation_status, 'blocked')
})

test('a stored file that really is audio is clear, and nothing was sent to the classifier', async () => {
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, kind: 'audio', bytes: mp3() })
  const res = await createTask(u.token, { prompt: 'hello there', audio_url: a.url })
  assert.equal(res.status, 200)
  assert.equal((await assetRow(a.id)).moderation_status, 'clear')
  assert.equal(stack.openai.requests.filter(r => JSON.stringify(r.body).includes('image_url')).length, 0)
})

test('a stored "audio" file that is nothing recognisable cannot be used', async () => {
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, kind: 'audio', bytes: notAnImage() })
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [a.url] })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'MEDIA_UNVERIFIABLE')
  assert.equal(tasksToKie().length, 0)
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. A link on KIE's hosts is checked when it is used
// ═════════════════════════════════════════════════════════════════════════════

// A different address for every test. The server remembers a link that passed (the file behind a
// KIE address never changes), so reusing one across tests with different content would test the cache.
let linkCounter = 0
const link = n => `https://tempfile.aiquickdraw.com/uploads/probe-${n}.bin`
let KIE_LINK
beforeEach(() => { KIE_LINK = link(`t${++linkCounter}`) })
const serves = (url, bytes, type = 'image/jpeg') => cdn.set(url, () => new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length) } }))

test('an explicit image behind a KIE link is refused, never sent to the generator, and counts as a strike', async () => {
  const u = await stack.createUser()
  serves(KIE_LINK, jpeg('IMG-EXPLICIT'))
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [KIE_LINK] })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'CONTENT_BLOCKED')
  assert.equal(tasksToKie().length, 0)
  assert.deepEqual((await events(u.id)).map(e => [e.source, e.action]), [['image', 'blocked']])
})

test('a clean image behind a KIE link is allowed — after being read', async () => {
  const u = await stack.createUser()
  serves(KIE_LINK, jpeg('IMG-OK'))
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [KIE_LINK] })
  assert.equal(res.status, 200)
  assert.deepEqual(fetched, [KIE_LINK], 'it was fetched')
  assert.equal(classifierCalls(), 2, 'the prompt, and the image')
  assert.equal(tasksToKie().length, 1)
})

test('audio behind a KIE link is allowed without a classifier call', async () => {
  const u = await stack.createUser()
  serves(KIE_LINK, mp3(), 'audio/mpeg')
  const res = await createTask(u.token, { prompt: 'hello there', audio_url: KIE_LINK })
  assert.equal(res.status, 200)
  assert.equal(classifierCalls(), 1, 'only the prompt')
})

test('HTML behind a KIE link cannot be checked, so cannot be used', async () => {
  const u = await stack.createUser()
  serves(KIE_LINK, notAnImage(), 'text/html')
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [KIE_LINK] })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'MEDIA_UNVERIFIABLE')
  assert.equal(tasksToKie().length, 0)
  assert.deepEqual(await events(u.id), [], 'a file we could not read is not an offence')
})

test('a KIE link that is gone cannot be used', async () => {
  const u = await stack.createUser()
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [KIE_LINK] })   // the stand-in answers 404
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'MEDIA_UNVERIFIABLE')
  assert.equal(tasksToKie().length, 0)
})

test('a KIE host that cannot be reached: refused when closed, allowed when open', async () => {
  const u = await stack.createUser()
  cdn.set(KIE_LINK, new Error('connect ETIMEDOUT'))

  const closed = await createTask(u.token, { prompt: 'hello there', image_urls: [KIE_LINK] })
  assert.equal(closed.status, 503)
  assert.equal(closed.body.code, 'MODERATION_UNAVAILABLE')
  assert.equal(tasksToKie().length, 0)

  process.env.MODERATION_FAIL_MODE = 'open'
  const open = await createTask(u.token, { prompt: 'hello there', image_urls: [KIE_LINK] })
  assert.equal(open.status, 200, 'fail-open is a choice the operator made, and is honoured')
})

test('a KIE host answering 5xx is "try again", not "this file is bad"', async () => {
  const u = await stack.createUser()
  cdn.set(KIE_LINK, () => new Response('boom', { status: 503 }))
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [KIE_LINK] })
  assert.equal(res.status, 503)
  assert.equal(res.body.code, 'MODERATION_UNAVAILABLE')
})

test('a redirect off KIE\'s hosts is not followed, and the file is refused', async () => {
  const u = await stack.createUser()
  cdn.set(KIE_LINK, () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x.jpg' } }))
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [KIE_LINK] })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'MEDIA_UNVERIFIABLE')
  assert.ok(!fetched.some(url => url.startsWith('https://evil.example.com')), 'the other host was never asked')
  assert.equal(tasksToKie().length, 0)
})

test('a file larger than anything allowed is refused without being read', async () => {
  const u = await stack.createUser()
  cdn.set(KIE_LINK, () => new Response('x', { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(300 * 1024 * 1024) } }))
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [KIE_LINK] })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'MEDIA_UNVERIFIABLE')
})

test('one request cannot name an unbounded number of KIE links', async () => {
  const u = await stack.createUser()
  const urls = Array.from({ length: 9 }, (_, i) => link(i))
  for (const url of urls) serves(url, jpeg('IMG-OK'))
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: urls })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'TOO_MANY_FILES')
  assert.equal(fetched.length, 0, 'nothing was downloaded to find out')
})

test('a link passed once is not fetched again for the same file', async () => {
  const u = await stack.createUser()
  serves(KIE_LINK, jpeg('IMG-OK'))
  await createTask(u.token, { prompt: 'hello there', image_urls: [KIE_LINK] })
  await createTask(u.token, { prompt: 'hello there', image_urls: [KIE_LINK] })
  assert.deepEqual(fetched, [KIE_LINK], 'fetched once')
  assert.equal(tasksToKie().length, 2, 'and both requests went ahead')
})

test('a link with a control character in it is refused before anything is fetched', async () => {
  const u = await stack.createUser()
  for (const ch of ['\u0001', '\n', '\u007f', '\r\nHost: evil.test']) {
    const res = await createTask(u.token, { prompt: 'hello there', image_urls: [`https://tempfile.aiquickdraw.com/a${ch}.png`] })
    assert.equal(res.status, 400, JSON.stringify(ch))
    assert.equal(res.body.code, 'MEDIA_NOT_ALLOWED', JSON.stringify(ch))
  }
  // A NUL does not even get as far as the link check: the request is refused at the door (api/_lib/nul.js).
  const nul = await createTask(u.token, { prompt: 'hello there', image_urls: ['https://tempfile.aiquickdraw.com/a\u0000.png'] })
  assert.equal(nul.status, 400)
  assert.equal(nul.body.code, 'BAD_CHARACTER')
  assert.equal(fetched.length, 0)
})

test('THE CHAIN: a file that got onto KIE unchecked is stopped when it is used', async () => {
  // Moderation was off when it was uploaded, so the upload endpoint forwarded it unread…
  const u = await stack.createUser()
  process.env.MODERATION_ENABLED = 'false'
  const up = await upload(u.token, `data:image/jpeg;base64,${b64(jpeg('IMG-EXPLICIT'))}`, 'audio/base64')
  assert.equal(up.status, 200)
  const where = up.body.data.downloadUrl
  assert.match(where, /aiquickdraw/)

  // …and later, with moderation back on, using the link is not enough to get it to the generator.
  delete process.env.MODERATION_ENABLED
  serves(where, jpeg('IMG-EXPLICIT'))
  const res = await createTask(u.token, { prompt: 'a woman walking', image_urls: [where] })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'CONTENT_BLOCKED')
  assert.equal(tasksToKie().length, 0)
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. An upload cannot be replaced after it was checked
// ═════════════════════════════════════════════════════════════════════════════

const urlFor = (a, key) => a.url.replace(a.key, key)

test('confirming an upload seals it: the file moves to a key no link names, and the original is gone', async () => {
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK'), sealed: false })
  const original = Buffer.from(stack.s3.objects.get(a.key).body)

  const res = await confirm(u.token, a.id)
  assert.equal(res.status, 200)

  const row = await assetRow(a.id)
  assert.notEqual(row.s3_key, a.key, 'the asset points somewhere else now')
  assert.match(row.s3_key, /-sealed\.jpg$/)
  assert.ok(row.sealed_at)
  assert.ok(!stack.s3.objects.has(a.key), 'the key the link named is gone')
  assert.deepEqual(stack.s3.objects.get(row.s3_key).body, original, 'same bytes')
  assert.equal(stack.s3.objects.get(row.s3_key).contentType, 'image/jpeg')
})

test('THE SWAP: replacing the file through the old link after confirming changes nothing that is checked or sent', async () => {
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK'), sealed: false })
  await confirm(u.token, a.id)
  const sealedKey = (await assetRow(a.id)).s3_key
  await stack.waitFor(async () => (await assetRow(a.id)).moderation_status === 'clear', { what: 'the background check' })

  // The client uses its upload link again.
  stack.s3.objects.set(a.key, { body: jpeg('IMG-EXPLICIT'), contentType: 'image/jpeg' })

  assert.ok(!stack.s3.objects.get(sealedKey).body.includes('IMG-EXPLICIT'), 'the sealed file is untouched')

  // The link the app holds now names the sealed key, so what the generator fetches is what was checked.
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [urlFor(a, sealedKey)] })
  assert.equal(res.status, 200)
  assert.equal(tasksToKie()[0].body.input.image_urls[0], urlFor(a, sealedKey))

  // And the old address no longer names this asset at all.
  const stale = await createTask(u.token, { prompt: 'hello there', image_urls: [a.url] })
  assert.equal(stale.status, 400)
  assert.equal(stale.body.code, 'MEDIA_NOT_FOUND')
  assert.equal(tasksToKie().length, 1)
})

test('what is checked is what the file was when it was sealed — even if it was swapped BEFORE confirming', async () => {
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK'), sealed: false })
  stack.s3.objects.set(a.key, { body: jpeg('IMG-EXPLICIT'), contentType: 'image/jpeg' })   // swapped, then confirmed
  await confirm(u.token, a.id)
  await stack.waitFor(async () => (await assetRow(a.id)).moderation_status === 'blocked', { what: 'the block' })
})

test('confirming twice is harmless and seals once', async () => {
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK'), sealed: false })
  assert.equal((await confirm(u.token, a.id)).status, 200)
  const first = await assetRow(a.id)
  assert.equal((await confirm(u.token, a.id)).status, 200)
  const second = await assetRow(a.id)
  assert.equal(second.s3_key, first.s3_key)
  assert.equal(String(second.sealed_at), String(first.sealed_at))
})

test('if the copy fails the upload is not confirmed, and nothing changes', async () => {
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK'), sealed: false })
  stack.s3.behaviour.failCopy = true
  const res = await confirm(u.token, a.id)
  assert.ok(res.status >= 500, `answered ${res.status}`)
  const row = await assetRow(a.id)
  assert.equal(row.s3_key, a.key)
  assert.equal(row.sealed_at, null)
  assert.ok(stack.s3.objects.has(a.key), 'the original is still there')

  stack.s3.behaviour.failCopy = false
  assert.equal((await confirm(u.token, a.id)).status, 200, 'and a retry works')
})

test('two things sealing the same upload at once seal it once', async () => {
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK'), sealed: false })
  const { sealAsset } = await stack.load('api/_lib/moderation/seal.js')
  const asset = await stack.one('select id, origin, s3_key, sealed_at, created_at from assets where id = $1', [a.id])
  const [x, y] = await Promise.all([sealAsset(asset), sealAsset(asset)])
  assert.equal(x.s3_key, y.s3_key)
  const keys = [...stack.s3.objects.keys()].filter(k => k.includes(a.id))
  assert.deepEqual(keys, [x.s3_key], 'one object remains: the sealed one')
})

test('an upload nobody confirmed cannot be used on the address it still has: it is sealed, and the request must be repeated', async () => {
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK'), sealed: false })

  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [a.url] })
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'MEDIA_NOT_READY')
  assert.equal(tasksToKie().length, 0, 'nothing reached the generator')

  const sealedKey = (await assetRow(a.id)).s3_key
  assert.match(sealedKey, /-sealed\.jpg$/)
  assert.ok(!stack.s3.objects.has(a.key))

  const again = await createTask(u.token, { prompt: 'hello there', image_urls: [urlFor(a, sealedKey)] })
  assert.equal(again.status, 200, 'the sealed address is fine')
})

test('an upload from before sealing existed is used as it always was, and not rewritten', async () => {
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK'), sealed: false, ageMinutes: 180 })
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [a.url] })
  assert.equal(res.status, 200)
  const row = await assetRow(a.id)
  assert.equal(row.s3_key, a.key, 'its link expired hours ago; there is nothing to seal against')
  assert.equal(row.sealed_at, null)
  assert.equal(row.moderation_status, 'clear', 'and it was still checked')
})

test('a result the server stored itself needs no sealing and is never refused for it', async () => {
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK'), origin: 'generated', sealed: false })
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [a.url] })
  assert.equal(res.status, 200)
  assert.equal((await assetRow(a.id)).s3_key, a.key)
})

test('sealing keeps an upload usable from every other place that reads its key', async () => {
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK'), sealed: false })
  await confirm(u.token, a.id)

  const dl = await stack.api('POST', '/api/storage/download-url', { token: u.token, body: { assetIds: [a.id] } })
  assert.equal(dl.status, 200)
  const sealedKey = (await assetRow(a.id)).s3_key
  assert.ok(dl.body.urls[a.id].url.includes(sealedKey), 'a fresh link names the sealed file')

  const del = await stack.api('POST', '/api/storage/delete', { token: u.token, body: { assetId: a.id } })
  assert.equal(del.status, 204)
  assert.ok(!stack.s3.objects.has(sealedKey), 'deleting removes the sealed file, not a ghost of the old key')
})
