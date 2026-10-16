// Per-second billing for a model that bills the VIDEO it is given (Kling Motion Control).
//
// KIE ignores a `duration` on that model and charges for the seconds of the driving clip
// (measured live: a 4 s clip at 720p cost exactly 4 × the per-second rate). So the server
// measures the clip itself, with real ffprobe, on videos this test makes with real ffmpeg —
// and a client cannot pay less by writing a shorter `duration`.
//
// Skipped (with a reason) on a machine that has no ffmpeg.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { startStack } from '../helpers/stack.js'

let stack
before(async () => { stack = await startStack({}) })
after(async () => { await stack?.stop() })
beforeEach(async () => {
  await stack.reset()
  delete process.env.BILLING_ENFORCED
})

function haveFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
}
const skip = haveFfmpeg() ? false : 'ffmpeg is not installed here'

/** A real MP4 of the given length. A busy test pattern reads as fine to the stand-in classifier. */
function makeVideo(seconds) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clip-test-'))
  const file = path.join(dir, 'v.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=640x360:rate=10`, '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' })
  const bytes = readFileSync(file)
  rmSync(dir, { recursive: true, force: true })
  return bytes
}

const MODEL = 'kling-3.0/motion-control'
const enforce = () => { process.env.BILLING_ENFORCED = 'true' }
const give = (userId, credits) => stack.sql(`insert into credit_ledger (user_id, kind, delta, ref) values ($1, 'grant', $2, $3)`, [userId, credits, `test-grant-${Math.random()}`])
const ledger = userId => stack.sql(`select kind, delta::float8 as delta, note, model from credit_ledger where user_id = $1 order by id`, [userId])
const balance = async user => (await stack.api('GET', '/api/billing/me', { token: user.token })).body.balance
const sentToKie = () => stack.kie.requests.filter(r => r.path === '/api/v1/jobs/createTask')
const motion = (token, url, mode, extra = {}) => stack.api('POST', '/api/kie/api/v1/jobs/createTask', {
  token,
  body: { model: MODEL, input: { prompt: 'a person dancing in a room', video_urls: [url], mode, character_orientation: 'video', ...extra } },
})

// KIE's published rates, as measured: 20 credits a second at 720p, 27 at 1080p.
const PRICES = `
  insert into model_prices (model, credits, unit) values
    ('${MODEL}:720p', 20, 'per_second'),
    ('${MODEL}:1080p', 27, 'per_second')`

test('the clip is measured on the server, and each mode is billed at its own rate per second', { skip }, async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 1000)
  enforce()
  const clip = await stack.putAsset({ userId: u.id, kind: 'video', bytes: makeVideo(4) })

  assert.equal((await motion(u.token, clip.url, '720p')).status, 200)
  assert.equal((await motion(u.token, clip.url, '1080p')).status, 200)

  const spends = (await ledger(u.id)).filter(r => r.kind === 'spend')
  assert.deepEqual(spends.map(r => r.delta), [-80, -108], '4 s × 20 and 4 s × 27')
  assert.equal(spends[0].model, MODEL, 'the ledger names the model, not the price row')
  assert.match(spends[0].note, /4 s × 20/, 'and the admin can see the sum')
  assert.equal(await balance(u), 1000 - 80 - 108)
  assert.equal(sentToKie().length, 2)
})

test('a client cannot pay for a shorter clip by writing a shorter duration', { skip }, async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 1000)
  enforce()
  const clip = await stack.putAsset({ userId: u.id, kind: 'video', bytes: makeVideo(4) })

  for (const duration of [1, '1', 0.5]) {
    assert.equal((await motion(u.token, clip.url, '720p', { duration })).status, 200)
  }
  assert.deepEqual((await ledger(u.id)).filter(r => r.kind === 'spend').map(r => r.delta), [-80, -80, -80])
})

test('a longer duration than the clip is paid for as written, never less', { skip }, async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 1000)
  enforce()
  const clip = await stack.putAsset({ userId: u.id, kind: 'video', bytes: makeVideo(4) })
  assert.equal((await motion(u.token, clip.url, '720p', { duration: 10 })).status, 200)
  assert.equal((await ledger(u.id)).at(-1).delta, -200)
})

test('a part of a second counts as a whole one, as KIE bills by the second', { skip }, async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 1000)
  enforce()
  const clip = await stack.putAsset({ userId: u.id, kind: 'video', bytes: makeVideo(3.4) })
  assert.equal((await motion(u.token, clip.url, '720p')).status, 200)
  assert.equal((await ledger(u.id)).at(-1).delta, -80, '3.4 s is billed as 4 s')
})

test('a mode with no row of its own is billed by the model\'s row', { skip }, async () => {
  const u = await stack.createUser()
  await stack.sql(`insert into model_prices (model, credits, unit) values ('${MODEL}', 25, 'per_second')`)
  await give(u.id, 1000)
  enforce()
  const clip = await stack.putAsset({ userId: u.id, kind: 'video', bytes: makeVideo(4) })
  assert.equal((await motion(u.token, clip.url, 'pro')).status, 200)
  assert.equal((await ledger(u.id)).at(-1).delta, -100)
})

test('not enough credits for the measured price is a 402 that names it, and KIE is never asked', { skip }, async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 100)
  enforce()
  const clip = await stack.putAsset({ userId: u.id, kind: 'video', bytes: makeVideo(4) })
  const res = await motion(u.token, clip.url, '1080p')
  assert.equal(res.status, 402)
  assert.equal(res.body.code, 'INSUFFICIENT_CREDITS')
  assert.equal(res.body.price, 108)
  assert.equal(res.body.balance, 100)
  assert.equal(sentToKie().length, 0)
})

test('switching one mode off refuses that mode and leaves the other working', { skip }, async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await stack.sql(`update model_prices set enabled = false where model = '${MODEL}:1080p'`)
  await give(u.id, 1000)
  enforce()
  const clip = await stack.putAsset({ userId: u.id, kind: 'video', bytes: makeVideo(4) })

  const off = await motion(u.token, clip.url, '1080p')
  assert.equal(off.status, 403)
  assert.equal(off.body.code, 'MODEL_UNAVAILABLE')
  assert.equal((await motion(u.token, clip.url, '720p')).status, 200)
  assert.equal(sentToKie().length, 1)
})

test('when KIE refuses the request the measured price is given back', { skip }, async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await give(u.id, 1000)
  enforce()
  const clip = await stack.putAsset({ userId: u.id, kind: 'video', bytes: makeVideo(4) })
  stack.kie.createStatus = { status: 200, body: { code: 500, msg: 'mode is not within the range of allowed options' } }
  const res = await motion(u.token, clip.url, '720p')
  assert.equal(res.body.code, 500, 'what KIE said is passed on')
  assert.equal(await balance(u), 1000)
})

test('another account\'s video is not found, so it cannot be priced or used', { skip }, async () => {
  const mine = await stack.createUser()
  const theirs = await stack.createUser()
  await stack.sql(PRICES)
  await give(mine.id, 1000)
  enforce()
  const clip = await stack.putAsset({ userId: theirs.id, kind: 'video', bytes: makeVideo(4) })
  const res = await motion(mine.token, clip.url, '720p')
  assert.equal(res.status, 400)
  assert.equal(await balance(mine), 1000)
  assert.equal(sentToKie().length, 0)
})

test('shadow mode measures and reports but takes nothing', { skip }, async () => {
  const u = await stack.createUser()
  await stack.sql(PRICES)
  const clip = await stack.putAsset({ userId: u.id, kind: 'video', bytes: makeVideo(4) })
  assert.equal((await motion(u.token, clip.url, '720p')).status, 200)
  assert.deepEqual(await ledger(u.id), [])
})

// ── The measuring itself ─────────────────────────────────────────────────────

test('clipSecondsOf: no video is null; the longest of several wins; junk and strangers\' links cannot be measured', { skip }, async () => {
  const { clipSecondsOf, ClipError } = await stack.load('api/_lib/clipLength.js')
  const u = await stack.createUser()
  assert.equal(await clipSecondsOf({ user: u, payload: { model: MODEL, input: { prompt: 'hello there' } } }), null)

  const short = await stack.putAsset({ userId: u.id, kind: 'video', bytes: makeVideo(2) })
  const long = await stack.putAsset({ userId: u.id, kind: 'video', bytes: makeVideo(5) })
  const seconds = await clipSecondsOf({ user: u, payload: { model: MODEL, input: { video_urls: [short.url, long.url] } } })
  assert.ok(seconds > 4.9 && seconds < 5.2, `the longer clip, got ${seconds}`)

  const junk = await stack.putAsset({ userId: u.id, kind: 'video', bytes: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(200, 9)]) })
  await assert.rejects(clipSecondsOf({ user: u, payload: { model: MODEL, input: { video_urls: [junk.url] } } }), e => e instanceof ClipError && e.code === 'CLIP_UNREADABLE')

  const image = await stack.putAsset({ userId: u.id, kind: 'image', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]) })
  await assert.rejects(clipSecondsOf({ user: u, payload: { model: MODEL, input: { video_urls: [image.url] } } }), e => e.code === 'CLIP_UNREADABLE', 'an image is not a clip')

  await assert.rejects(clipSecondsOf({ user: u, payload: { model: MODEL, input: { video_urls: ['https://example.com/a.mp4'] } } }), e => e.code === 'MEDIA_NOT_ALLOWED')
})

test('billedSeconds: whole seconds rounded up, with 50 ms of slack for a container that reports a hair too long', async () => {
  const { billedSeconds } = await stack.load('api/_lib/billing.js')
  assert.equal(billedSeconds(4), 4)
  assert.equal(billedSeconds(4.0003), 4)
  assert.equal(billedSeconds(4.05), 4)
  assert.equal(billedSeconds(4.06), 5)
  assert.equal(billedSeconds(3.4), 4)
  assert.equal(billedSeconds(0.2), 1, 'never less than a second')
})

// ── The admin panel's view of it ─────────────────────────────────────────────

test('admin: a model priced only by mode is not reported as unpriced', async () => {
  const admin = await stack.createUser({ role: 'admin' })
  const u = await stack.createUser()
  await stack.sql(PRICES)
  await stack.sql(`insert into generation_jobs (user_id, kie_task_id, kind, label, model, state) values ($1, 'task-a', 'video', 'Motion', $2, 'success'), ($1, 'task-b', 'video', 'Other', 'some/other-model', 'success')`, [u.id, MODEL])
  const res = await stack.api('GET', '/api/admin/prices', { token: admin.token })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.unpriced.map(r => r.model), ['some/other-model'])
  assert.deepEqual(res.body.prices.map(p => p.model).sort(), [`${MODEL}:1080p`, `${MODEL}:720p`])
})
