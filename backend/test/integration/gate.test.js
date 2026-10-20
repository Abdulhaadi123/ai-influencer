// The generation proxy's gate, end to end: a real HTTP request goes through the
// real app, real Postgres and the real S3 client, and the stand-ins say what came out.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { startStack, jpeg, notAnImage } from '../helpers/stack.js'

let stack
before(async () => { stack = await startStack() })
after(async () => { await stack?.stop() })
beforeEach(async () => { await stack.reset(); delete process.env.MODERATION_FAIL_MODE; delete process.env.MODERATION_ENABLED; delete process.env.KIE_NSFW_CHECKER })

const createTask = (token, input, model = 'kling-3.0/video') =>
  stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token, body: { model, input } })

const sentToKie = () => stack.kie.requests.filter(r => r.path === '/api/v1/jobs/createTask')
const moderationCalls = () => stack.openai.requests.length
const events = userId => stack.sql('select source, action, categories, excerpt, status, asset_id from moderation_events where user_id = $1 order by created_at', [userId])

// ── Text ─────────────────────────────────────────────────────────────────────

test('a clean prompt is checked, then sent to KIE with the server\'s key', async () => {
  const u = await stack.createUser()
  const res = await createTask(u.token, { prompt: 'She walks down a street at dusk and smiles.', mode: 'pro' })

  assert.equal(res.status, 200)
  assert.equal(res.body.data.taskId, 'task-1')
  assert.equal(moderationCalls(), 1)
  assert.equal(stack.openai.requests[0].authorization, 'Bearer test-openai-key')
  assert.equal(sentToKie().length, 1)
  assert.equal(sentToKie()[0].authorization, 'Bearer test-kie-key')
  assert.deepEqual(sentToKie()[0].body.input, { prompt: 'She walks down a street at dusk and smiles.', mode: 'pro' }, 'forwarded unchanged (Kling has no filter flag)')
  assert.deepEqual(await events(u.id), [])
})

test('a refused prompt never reaches KIE, costs nothing, and is recorded for review', async () => {
  const u = await stack.createUser()
  const res = await createTask(u.token, { prompt: 'XXX-EXPLICIT scene' })

  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'CONTENT_BLOCKED')
  assert.equal(sentToKie().length, 0, 'KIE was never called')
  assert.ok(!/sexual|score|threshold|0\.\d/i.test(res.body.error), 'the message does not say which rule fired')

  const [e] = await events(u.id)
  assert.equal(e.source, 'prompt')
  assert.equal(e.action, 'blocked')
  assert.deepEqual(e.categories, ['sexual'])
  assert.equal(e.status, 'open')
  assert.match(e.excerpt, /XXX-EXPLICIT/)
})

test('a borderline prompt goes through, and is put in front of a person', async () => {
  const u = await stack.createUser()
  const res = await createTask(u.token, { prompt: 'XXX-BORDER beach photoshoot' })

  assert.equal(res.status, 200)
  assert.equal(sentToKie().length, 1)
  const [e] = await events(u.id)
  assert.equal(e.action, 'review')
  assert.deepEqual(e.categories, ['sexual'])
})

test('text in a field the server has never heard of is still checked', async () => {
  const u = await stack.createUser()
  const res = await createTask(u.token, { prompt: 'fine', brand_new_field: 'XXX-EXPLICIT words here' }, 'some/future-model')
  assert.equal(res.status, 400)
  assert.equal(sentToKie().length, 0)
})

test('Veo\'s own endpoint is gated like createTask', async () => {
  const u = await stack.createUser()
  const bad = await stack.api('POST', '/api/kie/api/v1/veo/generate', { token: u.token, body: { prompt: 'XXX-EXPLICIT', model: 'veo3_fast' } })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'CONTENT_BLOCKED')
  assert.equal(stack.kie.requests.filter(r => r.path === '/api/v1/veo/generate').length, 0)

  const ok = await stack.api('POST', '/api/kie/api/v1/veo/generate', { token: u.token, body: { prompt: 'a calm lake', model: 'veo3_fast' } })
  assert.equal(ok.status, 200)
})

test('a request nobody signed is refused before anything else happens', async () => {
  const res = await createTask(null, { prompt: 'hello' })
  assert.equal(res.status, 401)
  assert.equal(moderationCalls(), 0)
  assert.equal(sentToKie().length, 0)
})

// ── Strikes and suspension ───────────────────────────────────────────────────

test('one tap that sends three refused prompts is one strike, not three', async () => {
  const u = await stack.createUser()
  const out = await Promise.all([1, 2, 3].map(i => createTask(u.token, { prompt: `XXX-EXPLICIT variation ${i}` })))
  assert.ok(out.every(r => r.status === 400 && r.body.code === 'CONTENT_BLOCKED'))

  const { countStrikes } = await stack.load('api/_lib/moderation/events.js')
  assert.equal((await events(u.id)).length, 3, 'all three are recorded for the reviewer')
  assert.equal(await countStrikes(u.id, 30), 1)
  assert.equal((await stack.one('select status from users where id = $1', [u.id])).status, 'active')
})

test('the fifth refused attempt, minutes apart, suspends the account and signs it out everywhere', async () => {
  const u = await stack.createUser()
  // Four earlier refusals, each in its own minute.
  for (let i = 1; i <= 4; i++) {
    await stack.sql(
      `insert into moderation_events (user_id, source, action, categories, created_at)
       values ($1, 'prompt', 'blocked', '{sexual}', now() - $2::int * interval '1 minute')`,
      [u.id, i * 5],
    )
  }
  const other = await stack.createUser()   // an innocent bystander's session must survive
  const fifth = await createTask(u.token, { prompt: 'XXX-EXPLICIT again' })

  assert.equal(fifth.status, 403)
  assert.equal(fifth.body.code, 'ACCOUNT_SUSPENDED')
  const row = await stack.one('select status, suspended_reason from users where id = $1', [u.id])
  assert.equal(row.status, 'suspended')
  assert.match(row.suspended_reason, /5 content refusals/)

  const after = await stack.api('GET', '/api/auth/me', { token: u.token })
  assert.equal(after.status, 401, 'the session is gone, so the app signs out')
  assert.equal(after.body.code, 'NOT_AUTHENTICATED')

  const login = await stack.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } })
  assert.equal(login.status, 403)
  assert.equal(login.body.code, 'ACCOUNT_SUSPENDED')

  assert.equal((await stack.api('GET', '/api/auth/me', { token: other.token })).status, 200)
})

test('strikes older than the window, or dismissed by an admin, do not count', async () => {
  const u = await stack.createUser()
  for (let i = 1; i <= 4; i++) {
    await stack.sql(
      `insert into moderation_events (user_id, source, action, categories, created_at, status)
       values ($1, 'prompt', 'blocked', '{sexual}', now() - $2::int * interval '1 minute', $3)`,
      [u.id, i * 5, i === 1 ? 'dismissed' : 'open'],
    )
  }
  await stack.sql(
    `insert into moderation_events (user_id, source, action, categories, created_at)
     values ($1, 'prompt', 'blocked', '{sexual}', now() - interval '45 days')`, [u.id])

  const res = await createTask(u.token, { prompt: 'XXX-EXPLICIT' })
  assert.equal(res.status, 400, 'three live strikes plus this one is four: not suspended')
  assert.equal((await stack.one('select status from users where id = $1', [u.id])).status, 'active')
})

test('anything involving a minor suspends at once, on the first attempt', async () => {
  const u = await stack.createUser()
  const res = await createTask(u.token, { prompt: 'XXX-MINOR something' })
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'ACCOUNT_SUSPENDED')
  assert.match((await stack.one('select suspended_reason from users where id = $1', [u.id])).suspended_reason, /minors/)
  assert.equal(sentToKie().length, 0)
})

test('the minors suspension can be turned off, and the request is still refused', async () => {
  process.env.MODERATION_SUSPEND_ON_MINORS = 'false'
  try {
    const u = await stack.createUser()
    const res = await createTask(u.token, { prompt: 'XXX-MINOR something' })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'CONTENT_BLOCKED')
  } finally { delete process.env.MODERATION_SUSPEND_ON_MINORS }
})

test('an admin account cannot use the app, and is never suspended by the checker', async () => {
  // An administrator holds a panel session, which the app's endpoints do not accept: they are not
  // refused by the checker, because they never get as far as it.
  const admin = await stack.createUser({ role: 'admin' })
  const res = await createTask(admin.token, { prompt: 'XXX-MINOR test' })
  assert.equal(res.status, 401)
  assert.equal(res.body.code, 'NOT_AUTHENTICATED')
  assert.equal(moderationCalls(), 0, 'the checker was never asked')
  assert.equal((await stack.one('select status from users where id = $1', [admin.id])).status, 'active')

  // The rule underneath, for an account made an administrator after it was refused: even at the
  // hardest rule an administrator is not suspended, and the same call does suspend an ordinary account.
  const { applyEnforcement } = await stack.load('api/_lib/moderation/events.js')
  const config = { strikeLimit: 1, strikeWindowDays: 30, suspendOnMinors: true }
  assert.equal((await applyEnforcement(admin.id, { hardRule: true, config })).suspended, false)
  const ordinary = await stack.createUser()
  assert.equal((await applyEnforcement(ordinary.id, { hardRule: true, config })).suspended, true)
})

test('a session that outlives a suspension is refused too', async () => {
  const u = await stack.createUser()
  await stack.sql(`update users set status = 'suspended' where id = $1`, [u.id])   // sessions deliberately left in place
  const res = await stack.api('GET', '/api/auth/me', { token: u.token })
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'ACCOUNT_SUSPENDED')
})

// ── When the checker cannot be reached ───────────────────────────────────────

test('fail-closed (the default): a checker outage refuses the request and sends nothing', async () => {
  stack.openai.mode.status = 503
  const u = await stack.createUser()
  const res = await createTask(u.token, { prompt: 'a perfectly fine prompt' })

  assert.equal(res.status, 503)
  assert.equal(res.body.code, 'MODERATION_UNAVAILABLE')
  assert.equal(sentToKie().length, 0)
  assert.equal(moderationCalls(), 2, 'asked, retried once, gave up')
  assert.deepEqual(await events(u.id), [], 'an outage is not an offence')
})

test('fail-open, when the operator chooses it: the request goes through unchecked', async () => {
  process.env.MODERATION_FAIL_MODE = 'open'
  stack.openai.mode.status = 503
  const u = await stack.createUser()
  const res = await createTask(u.token, { prompt: 'a perfectly fine prompt' })
  assert.equal(res.status, 200)
  assert.equal(sentToKie().length, 1)
})

test('moderation switched off: nothing is checked, nothing is recorded', async () => {
  process.env.MODERATION_ENABLED = 'false'
  const u = await stack.createUser()
  const res = await createTask(u.token, { prompt: 'XXX-EXPLICIT' })
  assert.equal(res.status, 200)
  assert.equal(moderationCalls(), 0)
  assert.deepEqual(await events(u.id), [])
})

// ── KIE's own filter, and the model switch ───────────────────────────────────

test('nsfw_checker is switched on by the server for models that have it — whatever the client said', async () => {
  const u = await stack.createUser()
  await createTask(u.token, { prompt: 'hello there', nsfw_checker: false }, 'bytedance/seedance-2-5')
  assert.equal(sentToKie().at(-1).body.input.nsfw_checker, true)

  await createTask(u.token, { prompt: 'hello there' }, 'kling-3.0/video')
  assert.equal('nsfw_checker' in sentToKie().at(-1).body.input, false, 'a model without the flag gets none')

  process.env.KIE_NSFW_CHECKER = 'false'
  await createTask(u.token, { prompt: 'hello there' }, 'bytedance/seedance-2-5')
  assert.equal('nsfw_checker' in sentToKie().at(-1).body.input, false)
})

test('the filter flag does not depend on our own checker being on', async () => {
  process.env.MODERATION_ENABLED = 'false'
  const u = await stack.createUser()
  await createTask(u.token, { prompt: 'hello there' }, 'wan/2-6-image-to-video')
  assert.equal(sentToKie().at(-1).body.input.nsfw_checker, true)
})

test('a model an admin switched off is refused before anything else; an unpriced model is allowed', async () => {
  const u = await stack.createUser()
  await stack.sql(`insert into model_prices (model, unit, credits, enabled) values ('kling-3.0/video', 'per_second', 20, false)`)

  const off = await createTask(u.token, { prompt: 'hello there' }, 'kling-3.0/video')
  assert.equal(off.status, 403)
  assert.equal(off.body.code, 'MODEL_UNAVAILABLE')
  assert.equal(moderationCalls(), 0, 'refused before the classifier was asked')
  assert.equal(sentToKie().length, 0)

  assert.equal((await createTask(u.token, { prompt: 'hello there' }, 'veo-3-1')).status, 200, 'no row means allowed')

  await stack.sql(`update model_prices set enabled = true`)
  assert.equal((await createTask(u.token, { prompt: 'hello there' }, 'kling-3.0/video')).status, 200, 'switching back on is immediate')
})

// ── Files named in a request ─────────────────────────────────────────────────

test('an uploaded image is checked once the first time it is used, and the answer is kept', async () => {
  const u = await stack.createUser()
  const img = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK') })

  const first = await createTask(u.token, { prompt: 'hello there', image_urls: [img.url] })
  assert.equal(first.status, 200)
  assert.equal(moderationCalls(), 2, 'one call for the text, one for the image')
  assert.equal((await stack.one('select moderation_status from assets where id = $1', [img.id])).moderation_status, 'clear')

  await createTask(u.token, { prompt: 'hello there', image_urls: [img.url] })
  assert.equal(moderationCalls(), 3, 'the second use asks only about the text')
})

test('a refused image is blocked for good, counts as a strike once, and refuses again without a new event', async () => {
  const u = await stack.createUser()
  const img = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-EXPLICIT') })

  const first = await createTask(u.token, { prompt: 'hello there', image_urls: [img.url] })
  assert.equal(first.status, 400)
  assert.equal(first.body.code, 'CONTENT_BLOCKED')
  assert.match(first.body.error, /files/i)
  assert.equal(sentToKie().length, 0)
  assert.equal((await stack.one('select moderation_status from assets where id = $1', [img.id])).moderation_status, 'blocked')

  const second = await createTask(u.token, { prompt: 'hello there', image_urls: [img.url] })
  assert.equal(second.status, 400)
  const evs = await events(u.id)
  assert.equal(evs.length, 1, 'one event, however many times it is tried')
  assert.equal(evs[0].source, 'image')
  assert.equal(evs[0].asset_id, img.id)
})

test('a borderline image is allowed and held for review', async () => {
  const u = await stack.createUser()
  const img = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-BORDER') })
  assert.equal((await createTask(u.token, { prompt: 'hello there', image_urls: [img.url] })).status, 200)
  const evs = await events(u.id)
  assert.equal(evs.length, 1)
  assert.equal(evs[0].action, 'review')
  assert.equal((await stack.one('select moderation_status from assets where id = $1', [img.id])).moderation_status, 'clear')
})

test('someone else\'s file is "not found" — and is not checked or revealed', async () => {
  const mine = await stack.createUser()
  const theirs = await stack.createUser()
  const img = await stack.putAsset({ userId: theirs.id, bytes: jpeg('IMG-OK') })

  const res = await createTask(mine.token, { prompt: 'hello there', image_urls: [img.url] })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'MEDIA_NOT_FOUND')
  assert.equal(sentToKie().length, 0)
  assert.equal((await stack.one('select moderation_status from assets where id = $1', [img.id])).moderation_status, 'unchecked', 'untouched')
})

test('a link we cannot check is refused', async () => {
  const u = await stack.createUser()
  const foreign = await createTask(u.token, { prompt: 'hello there', image_urls: ['https://images.example.com/a.jpg'] })
  assert.equal(foreign.status, 400)
  assert.equal(foreign.body.code, 'MEDIA_NOT_ALLOWED')

  const data = await createTask(u.token, { prompt: 'hello there', image_urls: ['data:image/png;base64,AAAA'] })
  assert.equal(data.body.code, 'MEDIA_NOT_ALLOWED')

  // A link on KIE's own hosts is not exempt: it is fetched and checked like anything else
  // (moderation-bypass.test.js). It used to be allowed for its host alone.
})

test('a file that is not really an image cannot be checked, so it cannot be used', async () => {
  const u = await stack.createUser()
  const fake = await stack.putAsset({ userId: u.id, bytes: notAnImage(), contentType: 'image/jpeg' })
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [fake.url] })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'MEDIA_UNVERIFIABLE')
  assert.equal(sentToKie().length, 0)
  assert.deepEqual(await events(u.id), [], 'a file we could not read is not an offence')
})

test('an image too large to send to the classifier cannot be used', async () => {
  const u = await stack.createUser()
  const big = await stack.putAsset({ userId: u.id, bytes: Buffer.concat([jpeg('IMG-OK'), Buffer.alloc(16 * 1024 * 1024)]) })
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [big.url] })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'MEDIA_UNVERIFIABLE')
})

test('checker down, files only (no prompt): closed refuses an unchecked file, open lets it through, a checked file is never in doubt', async () => {
  const u = await stack.createUser()
  const checked = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK'), moderationStatus: 'clear' })
  const fresh = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK') })
  stack.openai.mode.status = 503

  // Already checked: no question to ask, so the outage does not matter.
  assert.equal((await createTask(u.token, { image_urls: [checked.url] })).status, 200)

  const closed = await createTask(u.token, { image_urls: [fresh.url] })
  assert.equal(closed.status, 503)
  assert.equal(closed.body.code, 'MODERATION_UNAVAILABLE')
  assert.equal((await stack.one('select moderation_status from assets where id = $1', [fresh.id])).moderation_status, 'unchecked')

  process.env.MODERATION_FAIL_MODE = 'open'
  assert.equal((await createTask(u.token, { image_urls: [fresh.url] })).status, 200)
  assert.equal((await stack.one('select moderation_status from assets where id = $1', [fresh.id])).moderation_status, 'unchecked', 'still unchecked: open mode lets it pass, it does not vouch for it')
  assert.deepEqual(await events(u.id), [])
})

test('a request cannot attach an unreasonable number of files', async () => {
  const u = await stack.createUser()
  const urls = Array.from({ length: 41 }, (_, i) => `https://tempfile.aiquickdraw.com/uploads/${i}.png`)
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: urls })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'TOO_MANY_FILES')
})

test('uploads and results sit alongside: a blocked ASSET from a generated result refuses without a strike', async () => {
  const u = await stack.createUser()
  const img = await stack.putAsset({ userId: u.id, origin: 'generated', bytes: jpeg('IMG-EXPLICIT') })
  const res = await createTask(u.token, { prompt: 'hello there', image_urls: [img.url] })
  assert.equal(res.status, 400)
  const { countStrikes } = await stack.load('api/_lib/moderation/events.js')
  assert.equal(await countStrikes(u.id, 30), 0, 'something the generator made is not the user\'s offence')
  assert.equal((await events(u.id))[0].source, 'output')
})

// ── Files sent through the proxy to KIE ──────────────────────────────────────

const upload = (token, bytes, uploadPath = 'images/base64', asDataUrl = true) =>
  stack.api('POST', '/api/kie/api/file-base64-upload', {
    token,
    body: { base64Data: asDataUrl ? `data:application/octet-stream;base64,${bytes.toString('base64')}` : bytes.toString('base64'), uploadPath, fileName: 'x' },
  })
const uploadsToKie = () => stack.kie.requests.filter(r => r.path === '/api/file-base64-upload')

test('a clean image upload is forwarded to KIE', async () => {
  const u = await stack.createUser()
  const res = await upload(u.token, jpeg('IMG-OK'))
  assert.equal(res.status, 200)
  assert.match(res.body.data.downloadUrl, /aiquickdraw/)
  assert.equal(uploadsToKie().length, 1)
})

test('a refused image upload never leaves the server, and counts as a strike', async () => {
  const u = await stack.createUser()
  const res = await upload(u.token, jpeg('IMG-EXPLICIT'))
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'CONTENT_BLOCKED')
  assert.equal(uploadsToKie().length, 0)
  const [e] = await events(u.id)
  assert.equal(e.source, 'image')
  assert.equal(e.asset_id, null, 'no asset row — it never reached storage')
})

test('the real type is read from the bytes: HTML sent as "an image" is refused', async () => {
  const u = await stack.createUser()
  const res = await upload(u.token, notAnImage(), 'images/base64', false)
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'MEDIA_UNVERIFIABLE')
  assert.equal(uploadsToKie().length, 0)
})

test('audio is not checked (there is nothing to check it with) and goes through', async () => {
  const u = await stack.createUser()
  const res = await upload(u.token, Buffer.from('ID3 pretend this is an mp3'), 'audio/base64')
  assert.equal(res.status, 200)
  assert.equal(moderationCalls(), 0)
})

test('an upload with nothing in it is left to KIE to reject', async () => {
  const u = await stack.createUser()
  const res = await stack.api('POST', '/api/kie/api/file-base64-upload', { token: u.token, body: { uploadPath: 'images/base64' } })
  assert.equal(res.status, 200)
  assert.equal(moderationCalls(), 0)
})

// ── A real video, through real ffmpeg ────────────────────────────────────────

function haveFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
}
const skipVideo = haveFfmpeg() ? false : 'ffmpeg is not installed here'

function makeVideo(source) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-video-'))
  const file = path.join(dir, 'v.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', source, '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' })
  const bytes = readFileSync(file)
  rmSync(dir, { recursive: true, force: true })
  return bytes
}
// A busy test pattern reads as fine to the stand-in; a flat colour reads as explicit (see helpers/stack.js).
const goodVideo = () => makeVideo('testsrc=duration=3:size=640x360:rate=10')
const badVideo = () => makeVideo('color=c=red:duration=3:size=320x240:rate=10')

test('a driving video is sampled into frames and checked; a good one passes', { skip: skipVideo }, async () => {
  const u = await stack.createUser()
  const res = await upload(u.token, goodVideo(), 'videos/base64')
  assert.equal(res.status, 200)
  assert.equal(uploadsToKie().length, 1)
  // OpenAI takes one image per request, so four frames are four requests.
  const calls = stack.openai.requests.slice(-4)
  assert.equal(calls.length, 4, 'four frames, four requests')
  assert.ok(calls.every(c => c.body.input.length === 1 && c.body.input[0].type === 'image_url' && c.body.input[0].image_url.url.startsWith('data:image/jpeg;base64,')))
})

test('one bad video is refused before KIE sees it', { skip: skipVideo }, async () => {
  const u = await stack.createUser()
  const res = await upload(u.token, badVideo(), 'videos/base64')
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'CONTENT_BLOCKED')
  assert.equal(uploadsToKie().length, 0)
  assert.equal((await events(u.id))[0].source, 'video')
})

test('a video asset used as a reference is downloaded, sampled, checked, and remembered', { skip: skipVideo }, async () => {
  const u = await stack.createUser()
  const good = await stack.putAsset({ userId: u.id, kind: 'video', bytes: goodVideo() })
  const bad = await stack.putAsset({ userId: u.id, kind: 'video', bytes: badVideo() })

  assert.equal((await createTask(u.token, { prompt: 'hello there', video_urls: [good.url] }, 'kling-3.0/motion-control')).status, 200)
  assert.equal((await stack.one('select moderation_status from assets where id = $1', [good.id])).moderation_status, 'clear')

  const refused = await createTask(u.token, { prompt: 'hello there', video_urls: [bad.url] }, 'kling-3.0/motion-control')
  assert.equal(refused.status, 400)
  assert.equal((await stack.one('select moderation_status from assets where id = $1', [bad.id])).moderation_status, 'blocked')
  assert.equal((await events(u.id)).at(-1).source, 'video')
})

test('an unreadable "video" is unverifiable, not an offence', { skip: skipVideo }, async () => {
  const u = await stack.createUser()
  const junk = await stack.putAsset({ userId: u.id, kind: 'video', bytes: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(200, 9)]) })
  const res = await createTask(u.token, { prompt: 'hello there', video_urls: [junk.url] }, 'kling-3.0/motion-control')
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'MEDIA_UNVERIFIABLE')
  assert.deepEqual(await events(u.id), [])
})

// ── The suggestion endpoint ──────────────────────────────────────────────────

const assist = (token, text, kind = 'script') => stack.api('POST', '/api/prompt-assist', { token, body: { text, kind } })

test('suggestions: clean text is rewritten as before', async () => {
  const u = await stack.createUser()
  const res = await assist(u.token, 'I love this product')
  assert.equal(res.status, 200)
  assert.equal(res.body.suggestion, 'improved: I love this product')
  assert.equal(stack.openai.chat.length, 1)
})

test('suggestions: refused text is not rewritten, and is never a strike', async () => {
  const u = await stack.createUser()
  for (let i = 0; i < 8; i++) {
    // (Different beginnings: texts that begin the same way are one draft — see below.)
    const res = await assist(u.token, `${i} XXX-EXPLICIT draft number ${i}`)
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'CONTENT_BLOCKED')
  }
  assert.equal(stack.openai.chat.length, 0, 'the rewriter was never asked')
  assert.equal((await events(u.id)).length, 8, 'every refusal is recorded')
  assert.equal((await stack.one('select status from users where id = $1', [u.id])).status, 'active', 'but typing a draft is not an offence')
})

test('suggestions: a sentence typed in bursts is ONE queue item that follows the latest text, not one per burst', async () => {
  const u = await stack.createUser()
  const other = await stack.createUser()

  // Held for review: the same draft growing.
  for (const text of ['XXX-BORDER mid 20 girl that', 'XXX-BORDER mid 20 girl that do things n', 'XXX-BORDER mid 20 girl that do things nide']) {
    assert.equal((await assist(u.token, text)).status, 200)
  }
  let rows = await events(u.id)
  assert.equal(rows.length, 1, 'three requests, one entry')
  assert.equal(rows[0].excerpt, 'XXX-BORDER mid 20 girl that do things nide', 'it shows what was typed last')
  assert.equal(rows[0].action, 'review')

  // The same words from someone else are their own entry.
  await assist(other.token, 'XXX-BORDER mid 20 girl that do things')
  assert.equal((await events(other.id)).length, 1)

  // A draft that begins differently is another item, and so is a refusal (a different decision).
  await assist(u.token, 'XXX-BORDER a completely different start')
  await assist(u.token, 'XXX-EXPLICIT now it is refused')
  await assist(u.token, 'XXX-EXPLICIT now it is refused outright')
  rows = await events(u.id)
  assert.deepEqual(rows.map(r => [r.action, r.excerpt]), [
    ['review', 'XXX-BORDER mid 20 girl that do things nide'],
    ['review', 'XXX-BORDER a completely different start'],
    ['blocked', 'XXX-EXPLICIT now it is refused outright'],
  ])

  // Once a person has decided the item, the next draft is news again.
  await stack.sql(`update moderation_events set status = 'dismissed' where user_id = $1`, [u.id])
  await assist(u.token, 'XXX-BORDER mid 20 girl that do things again')
  assert.equal((await events(u.id)).length, 4)

  // And a draft from long ago is not the same draft.
  await stack.sql(`update moderation_events set created_at = now() - interval '2 hours' where user_id = $1 and status = 'open'`, [u.id])
  await assist(u.token, 'XXX-BORDER mid 20 girl that do things once more')
  assert.equal((await events(u.id)).length, 5)
})

test('suggestions: text close to the line still gets its suggestion, and a word about the text; clean text gets no word', async () => {
  const u = await stack.createUser()
  const clean = await assist(u.token, 'I love this product')
  assert.equal(clean.body.notice, undefined)

  const close = await assist(u.token, 'XXX-BORDER she says hello to everyone')
  assert.equal(close.status, 200)
  assert.equal(close.body.suggestion, 'improved: XXX-BORDER she says hello to everyone')
  assert.equal(close.body.notice.code, 'REVIEW')
  assert.match(close.body.notice.message, /content guidelines/)
})

test('suggestions: when the rewriter will not help, the person is told so — and its refusal is never offered as their new text', async () => {
  const u = await stack.createUser()
  for (const said of ["I'm sorry, but I can't assist with that.", 'Sorry, I cannot help with this request.', 'I cannot rewrite that.', 'As an AI, I am not able to do this.']) {
    stack.openai.chatMode.content = said
    const res = await assist(u.token, `a perfectly fine script ${said.length}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.suggestion, null, said)
    assert.equal(res.body.notice.code, 'DECLINED', said)
  }
  // Nothing at all back: nothing to say.
  stack.openai.chatMode.content = '   '
  const empty = await assist(u.token, 'a perfectly fine script, again')
  assert.deepEqual(empty.body, { suggestion: null })
  // A rewrite that merely begins with "I can see" or "Sorry-not-sorry" is a rewrite.
  stack.openai.chatMode.content = 'I can see her smiling warmly at the camera in golden light'
  assert.equal((await assist(u.token, 'a perfectly fine script, thrice')).body.suggestion, 'I can see her smiling warmly at the camera in golden light')
})

test('suggestions: the checker being down refuses (closed) rather than rewriting unchecked text', async () => {
  stack.openai.mode.status = 503
  const u = await stack.createUser()
  const res = await assist(u.token, 'a fine script')
  assert.equal(res.status, 503)
  assert.equal(res.body.code, 'MODERATION_UNAVAILABLE')
})
