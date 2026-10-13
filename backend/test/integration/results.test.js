// What happens to a result after the generator makes it: stored, checked, and
// either shown to its owner or quarantined. Covers the three collectors (the
// webhook/worker `collect`, the app's `ingest`, the worker's re-check sweep).

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { startStack, jpeg, notAnImage } from '../helpers/stack.js'

let stack
let cdn                    // url → { body, contentType }: what KIE's CDN serves
const realFetch = globalThis.fetch

before(async () => {
  stack = await startStack()
  cdn = new Map()
  // Results are fetched from KIE's CDN over https; nothing here may touch the internet.
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://tempfile.aiquickdraw.com/')) {
      const file = cdn.get(url)
      if (!file) return new Response('gone', { status: 404 })
      return new Response(file.body, { status: 200, headers: { 'content-type': file.contentType, 'content-length': String(file.body.length) } })
    }
    return realFetch(input, init)
  }
})
after(async () => { globalThis.fetch = realFetch; await stack?.stop() })
beforeEach(async () => { await stack.reset(); cdn.clear(); delete process.env.MODERATION_ENABLED })

let counter = 0
/** A finished job whose result sits on the CDN, ready to be collected. */
async function finishedJob({ user, bytes, contentType = 'image/jpeg', kind = 'image', influencerId = null }) {
  const url = `https://tempfile.aiquickdraw.com/results/${++counter}.${kind === 'video' ? 'mp4' : 'jpg'}`
  cdn.set(url, { body: bytes, contentType })
  const job = await stack.one(
    `insert into generation_jobs (user_id, influencer_id, kie_task_id, kind, label, model, state, result_url)
     values ($1, $2, $3, $4, 'Video', 'kling-3.0/video', 'success', $5) returning *`,
    [user.id, influencerId, `task-${counter}`, kind, url],
  )
  return job
}

const influencerFor = async user => (await stack.one(`insert into influencers (user_id, name) values ($1, 'Mia') returning id`, [user.id])).id
const gallery = userId => stack.sql('select asset_id from generations where user_id = $1', [userId])
const jobRow = id => stack.one('select state, fail_msg, asset_id from generation_jobs where id = $1', [id])
const assetRow = id => stack.one('select moderation_status from assets where id = $1', [id])

async function collectJob(job) {
  const { collect } = await stack.load('api/_lib/collect.js')
  return collect(job, '[test]')
}

// ── collect (webhook and worker) ─────────────────────────────────────────────

test('a clean result is stored, checked, and filed in the gallery', async () => {
  const u = await stack.createUser()
  const inf = await influencerFor(u)
  const job = await finishedJob({ user: u, bytes: jpeg('IMG-OK'), influencerId: inf })

  assert.equal(await collectJob(job), true)
  const done = await jobRow(job.id)
  assert.equal((await assetRow(done.asset_id)).moderation_status, 'clear')
  assert.deepEqual((await gallery(u.id)).map(g => g.asset_id), [done.asset_id])
  assert.equal(done.state, 'success')
})

test('a refused result is stored for an admin but never reaches its owner', async () => {
  const u = await stack.createUser()
  const inf = await influencerFor(u)
  const job = await finishedJob({ user: u, bytes: jpeg('IMG-EXPLICIT'), influencerId: inf })

  assert.equal(await collectJob(job), true, 'handled — nothing to retry')
  const row = await jobRow(job.id)
  assert.equal((await assetRow(row.asset_id)).moderation_status, 'blocked')
  assert.deepEqual(await gallery(u.id), [], 'not filed')

  const { OUTPUT_REMOVED_MESSAGE } = await stack.load('api/_lib/moderation/service.js')
  assert.equal(row.state, 'fail')
  assert.equal(row.fail_msg, OUTPUT_REMOVED_MESSAGE)

  const [e] = await stack.sql('select source, action, categories, asset_id from moderation_events where user_id = $1', [u.id])
  assert.equal(e.source, 'output')
  assert.equal(e.action, 'blocked')
  assert.equal(e.asset_id, row.asset_id)

  const { countStrikes } = await stack.load('api/_lib/moderation/events.js')
  assert.equal(await countStrikes(u.id, 30), 0, 'not the user\'s offence')
  assert.equal((await stack.one('select status from users where id = $1', [u.id])).status, 'active')
})

test('a blocked result is not handed out, and cannot be filed by the app', async () => {
  const u = await stack.createUser()
  const inf = await influencerFor(u)
  const bad = await finishedJob({ user: u, bytes: jpeg('IMG-EXPLICIT'), influencerId: inf })
  const good = await finishedJob({ user: u, bytes: jpeg('IMG-OK'), influencerId: inf })
  await collectJob(bad); await collectJob(good)
  const badId = (await jobRow(bad.id)).asset_id
  const goodId = (await jobRow(good.id)).asset_id

  const urls = await stack.api('POST', '/api/storage/download-url', { token: u.token, body: { assetIds: [badId, goodId] } })
  assert.equal(urls.status, 200)
  assert.deepEqual(Object.keys(urls.body.urls), [goodId], 'the blocked file is absent, like a file that is not yours')

  const add = await stack.api('POST', '/api/generations/add', { token: u.token, body: { assetId: badId, influencerId: inf, kind: 'image' } })
  assert.equal(add.status, 403)
  assert.equal(add.body.code, 'CONTENT_BLOCKED')
})

test('a second collector racing the first cannot put a blocked result back', async () => {
  const u = await stack.createUser()
  const inf = await influencerFor(u)
  const job = await finishedJob({ user: u, bytes: jpeg('IMG-EXPLICIT'), influencerId: inf })
  await collectJob(job)
  // The webhook and the worker both end up here for the same job; the job row now
  // says "fail", but a collector holding the old copy of the row still calls this.
  await collectJob({ ...job, asset_id: null })
  assert.deepEqual(await gallery(u.id), [])
  assert.equal((await stack.sql('select 1 from moderation_events where user_id = $1', [u.id])).length, 1, 'one event, not two')
})

test('the checker being down never costs the user a result they paid for', async () => {
  stack.openai.mode.status = 503
  const u = await stack.createUser()
  const inf = await influencerFor(u)
  const job = await finishedJob({ user: u, bytes: jpeg('IMG-OK'), influencerId: inf })

  assert.equal(await collectJob(job), true)
  const row = await jobRow(job.id)
  assert.equal((await assetRow(row.asset_id)).moderation_status, 'unchecked', 'stored, not yet checked')
  assert.equal((await gallery(u.id)).length, 1, 'and visible: it is theirs')
  assert.equal(row.state, 'success')
})

test('moderation switched off: the result is stored and filed, the classifier is not asked', async () => {
  process.env.MODERATION_ENABLED = 'false'
  const u = await stack.createUser()
  const inf = await influencerFor(u)
  const job = await finishedJob({ user: u, bytes: jpeg('IMG-EXPLICIT'), influencerId: inf })
  await collectJob(job)
  assert.equal(stack.openai.requests.length, 0)
  assert.equal((await gallery(u.id)).length, 1)
})

test('a result no classifier can read is let through and put in front of a person', async () => {
  const u = await stack.createUser()
  const inf = await influencerFor(u)
  const job = await finishedJob({ user: u, bytes: notAnImage(), influencerId: inf })
  await collectJob(job)

  const row = await jobRow(job.id)
  assert.equal((await assetRow(row.asset_id)).moderation_status, 'clear')
  assert.equal((await gallery(u.id)).length, 1)
  const [e] = await stack.sql('select action, categories from moderation_events where user_id = $1', [u.id])
  assert.equal(e.action, 'review')
  assert.deepEqual(e.categories, ['unverifiable'])
})

test('a wizard result with no influencer yet is checked and stored, with no gallery to file in', async () => {
  const u = await stack.createUser()
  const job = await finishedJob({ user: u, bytes: jpeg('IMG-EXPLICIT'), influencerId: null })
  await collectJob(job)
  assert.equal((await assetRow((await jobRow(job.id)).asset_id)).moderation_status, 'blocked')
})

// ── ingest (the app's own collector) ─────────────────────────────────────────

test('ingest: a clean result is saved; a refused one is reported as removed; an outage lets it through', async () => {
  const u = await stack.createUser()
  const goodUrl = 'https://tempfile.aiquickdraw.com/results/ingest-good.jpg'
  const badUrl = 'https://tempfile.aiquickdraw.com/results/ingest-bad.jpg'
  cdn.set(goodUrl, { body: jpeg('IMG-OK'), contentType: 'image/jpeg' })
  cdn.set(badUrl, { body: jpeg('IMG-EXPLICIT'), contentType: 'image/jpeg' })

  const good = await stack.api('POST', '/api/storage/ingest', { token: u.token, body: { sourceUrl: goodUrl } })
  assert.equal(good.status, 200)
  assert.equal((await assetRow(good.body.assetId)).moderation_status, 'clear')

  const bad = await stack.api('POST', '/api/storage/ingest', { token: u.token, body: { sourceUrl: badUrl } })
  assert.equal(bad.status, 403)
  assert.equal(bad.body.code, 'CONTENT_BLOCKED')
  const stored = await stack.one(`select moderation_status from assets where user_id = $1 and source_url = $2`, [u.id, badUrl])
  assert.equal(stored.moderation_status, 'blocked', 'kept for the admin')

  // Same result asked for again: still refused, and no second event.
  assert.equal((await stack.api('POST', '/api/storage/ingest', { token: u.token, body: { sourceUrl: badUrl } })).status, 403)
  assert.equal((await stack.sql('select 1 from moderation_events where user_id = $1', [u.id])).length, 1)

  stack.openai.mode.status = 503
  const outageUrl = 'https://tempfile.aiquickdraw.com/results/ingest-outage.jpg'
  cdn.set(outageUrl, { body: jpeg('IMG-OK'), contentType: 'image/jpeg' })
  const outage = await stack.api('POST', '/api/storage/ingest', { token: u.token, body: { sourceUrl: outageUrl } })
  assert.equal(outage.status, 200)
  assert.equal((await assetRow(outage.body.assetId)).moderation_status, 'unchecked')
})

// ── The worker's re-check sweep ──────────────────────────────────────────────

test('the sweep checks what could not be checked, and quarantines a bad result that was already showing', async () => {
  stack.openai.mode.status = 503
  const u = await stack.createUser()
  const inf = await influencerFor(u)
  const bad = await finishedJob({ user: u, bytes: jpeg('IMG-EXPLICIT'), influencerId: inf })
  const good = await finishedJob({ user: u, bytes: jpeg('IMG-OK'), influencerId: inf })
  await collectJob(bad); await collectJob(good)
  assert.equal((await gallery(u.id)).length, 2, 'both visible during the outage')

  stack.openai.mode.status = null
  const { sweepUnchecked } = await stack.load('server/worker.js')
  await sweepUnchecked()

  const badAsset = (await jobRow(bad.id)).asset_id
  const goodAsset = (await jobRow(good.id)).asset_id
  assert.equal((await assetRow(badAsset)).moderation_status, 'blocked')
  assert.equal((await assetRow(goodAsset)).moderation_status, 'clear')
  assert.deepEqual((await gallery(u.id)).map(g => g.asset_id), [goodAsset], 'the bad one is taken down')
  assert.equal((await jobRow(bad.id)).state, 'fail')
  assert.equal((await jobRow(good.id)).state, 'success')
})

test('while the checker stays down the sweep backs off instead of asking again every cycle', async () => {
  stack.openai.mode.status = 503
  const u = await stack.createUser()
  const inf = await influencerFor(u)
  await collectJob(await finishedJob({ user: u, bytes: jpeg('IMG-OK'), influencerId: inf }))
  stack.openai.requests.length = 0

  const { sweepUnchecked } = await stack.load('server/worker.js')
  const t0 = Date.now() + 10_000_000   // a clock of its own: the backoff map is keyed on it
  await sweepUnchecked(t0)
  const first = stack.openai.requests.length
  assert.ok(first >= 1)

  await sweepUnchecked(t0 + 1000)
  assert.equal(stack.openai.requests.length, first, 'a second later: nothing asked')

  await sweepUnchecked(t0 + 5 * 60_000)
  assert.ok(stack.openai.requests.length > first, 'minutes later: tried again')
})

test('the sweep looks only at generated results that are still unchecked and recent', async () => {
  const u = await stack.createUser()
  const fresh = await stack.putAsset({ userId: u.id, origin: 'generated', bytes: jpeg('IMG-OK') })
  const upload = await stack.putAsset({ userId: u.id, origin: 'upload', bytes: jpeg('IMG-OK') })
  const checked = await stack.putAsset({ userId: u.id, origin: 'generated', bytes: jpeg('IMG-OK'), moderationStatus: 'clear' })
  const old = await stack.putAsset({ userId: u.id, origin: 'generated', bytes: jpeg('IMG-OK') })
  await stack.sql(`update assets set created_at = now() - interval '3 days' where id = $1`, [old.id])

  const { listUncheckedResults } = await stack.load('api/_lib/moderation/service.js')
  const ids = (await listUncheckedResults()).map(a => a.id)
  assert.deepEqual(ids, [fresh.id])
  assert.ok(![upload.id, checked.id, old.id].some(id => ids.includes(id)))
})

test('the sweep does nothing at all when moderation is off', async () => {
  process.env.MODERATION_ENABLED = 'false'
  const u = await stack.createUser()
  await stack.putAsset({ userId: u.id, origin: 'generated', bytes: jpeg('IMG-EXPLICIT') })
  const { sweepUnchecked } = await stack.load('server/worker.js')
  await sweepUnchecked()
  assert.equal(stack.openai.requests.length, 0)
})

// ── Video results, through real ffmpeg ───────────────────────────────────────

function haveFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
}
const skipVideo = haveFfmpeg() ? false : 'ffmpeg is not installed here'
function makeVideo(source) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'results-video-'))
  const file = path.join(dir, 'v.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', source, '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' })
  const bytes = readFileSync(file)
  rmSync(dir, { recursive: true, force: true })
  return bytes
}

test('a generated video is checked by its frames: good is filed, bad is quarantined', { skip: skipVideo }, async () => {
  const u = await stack.createUser()
  const inf = await influencerFor(u)
  const good = await finishedJob({ user: u, kind: 'video', contentType: 'video/mp4', bytes: makeVideo('testsrc=duration=3:size=640x360:rate=10'), influencerId: inf })
  const bad = await finishedJob({ user: u, kind: 'video', contentType: 'video/mp4', bytes: makeVideo('color=c=red:duration=3:size=320x240:rate=10'), influencerId: inf })
  await collectJob(good); await collectJob(bad)

  assert.equal((await assetRow((await jobRow(good.id)).asset_id)).moderation_status, 'clear')
  assert.equal((await assetRow((await jobRow(bad.id)).asset_id)).moderation_status, 'blocked')
  assert.deepEqual((await gallery(u.id)).map(g => g.asset_id), [(await jobRow(good.id)).asset_id])
})
