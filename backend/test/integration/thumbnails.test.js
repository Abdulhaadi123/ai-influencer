// Gallery previews end to end: made when a result is stored or an upload confirmed, handed out with the
// file's own ownership check, deleted with the file, and made later by the worker for anything older.
// Real ffmpeg on images and videos this test makes itself; skipped (with a reason) where there is none.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { startStack, jpeg } from '../helpers/stack.js'

function haveFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
}
const skip = haveFfmpeg() ? false : 'ffmpeg is not installed here'

let stack
let cdn
let media = {}
let thumbs, worker
const realFetch = globalThis.fetch

before(async () => {
  stack = await startStack()
  thumbs = await stack.load('api/_lib/thumbnails.js')
  worker = await stack.load('server/worker.js')
  cdn = new Map()
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://tempfile.aiquickdraw.com/')) {
      const file = cdn.get(url)
      if (!file) return new Response('gone', { status: 404 })
      return new Response(file.body, { status: 200, headers: { 'content-type': file.contentType, 'content-length': String(file.body.length) } })
    }
    return realFetch(input, init)
  }
  if (!skip) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'thumbs-it-'))
    const run = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' })
    // Grain, like a photograph's: a flat test pattern compresses to almost nothing as a PNG, which no
    // generated picture does.
    run(['-f', 'lavfi', '-i', 'testsrc2=size=1536x2752', '-vf', 'noise=alls=25:allf=t+u', '-frames:v', '1', path.join(dir, 'result.png')])
    run(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=720x1280:rate=24', '-pix_fmt', 'yuv420p', path.join(dir, 'result.mp4')])
    run(['-f', 'lavfi', '-i', 'testsrc=size=1024x1024', '-frames:v', '1', path.join(dir, 'upload.jpg')])
    media = {
      png: readFileSync(path.join(dir, 'result.png')),
      mp4: readFileSync(path.join(dir, 'result.mp4')),
      jpg: readFileSync(path.join(dir, 'upload.jpg')),
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
after(async () => { globalThis.fetch = realFetch; await stack?.stop() })
beforeEach(async () => { await thumbs.thumbnailsSettled(); await stack.reset(); cdn.clear(); delete process.env.FFMPEG_PATH })

let n = 0
/** A generated result on KIE's CDN, stored through the app's own ingest call. */
async function ingest(user, bytes, contentType) {
  const url = `https://tempfile.aiquickdraw.com/r/${++n}.${contentType === 'video/mp4' ? 'mp4' : 'png'}`
  cdn.set(url, { body: bytes, contentType })
  const res = await stack.api('POST', '/api/storage/ingest', { token: user.token, body: { sourceUrl: url } })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  await thumbs.thumbnailsSettled()
  return res.body.assetId
}

const asset = id => stack.one('select id, s3_key, thumb_key, thumb_checked_at from assets where id = $1', [id])
const object = key => stack.s3.objects.get(key)
const isJpeg = b => b && b[0] === 0xff && b[1] === 0xd8
const links = (user, assetIds, purpose) =>
  stack.api('POST', '/api/storage/download-url', { token: user.token, body: { assetIds, ...(purpose ? { purpose } : {}) } })

test('a stored image gets a small JPEG preview beside it, a tiny fraction of the file', { skip }, async () => {
  const u = await stack.createUser()
  const id = await ingest(u, media.png, 'image/png')
  const row = await asset(id)
  assert.equal(row.thumb_key, thumbs.thumbKeyFor(row.s3_key))
  assert.ok(row.thumb_checked_at)
  const preview = object(row.thumb_key)
  assert.ok(isJpeg(preview.body))
  assert.equal(preview.contentType, 'image/jpeg')
  assert.ok(preview.body.length * 20 < object(row.s3_key).body.length, `${preview.body.length} vs ${object(row.s3_key).body.length} bytes`)
  assert.ok(row.thumb_key.startsWith(`users/${u.id}/`), 'under the owner\'s prefix')
})

test('a stored video gets a still frame as its preview', { skip }, async () => {
  const u = await stack.createUser()
  const row = await asset(await ingest(u, media.mp4, 'video/mp4'))
  assert.ok(isJpeg(object(row.thumb_key)?.body))
})

test('the preview link comes with the file\'s, for display only — and never for a file that is not yours', { skip }, async () => {
  const mia = await stack.createUser()
  const bob = await stack.createUser()
  const id = await ingest(mia, media.png, 'image/png')

  const shown = await links(mia, [id])
  assert.ok(shown.body.urls[id].url)
  assert.ok(shown.body.urls[id].thumbUrl, 'a display link has its preview')
  const fetched = await realFetch(shown.body.urls[id].thumbUrl)
  assert.equal(fetched.status, 200)
  assert.ok(isJpeg(Buffer.from(await fetched.arrayBuffer())), 'the link opens the JPEG')

  assert.equal((await links(mia, [id], 'generation')).body.urls[id].thumbUrl, undefined, 'the generator gets the file, not a preview')
  assert.deepEqual((await links(bob, [id])).body.urls, {}, 'another account gets nothing, preview included')

  await stack.sql(`update assets set moderation_status = 'blocked' where id = $1`, [id])
  assert.deepEqual((await links(mia, [id])).body.urls, {}, 'a blocked file is not shown, nor its preview')
})

test('a file without a preview is answered as before: just the file\'s link', async () => {
  const u = await stack.createUser()
  const { id } = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK') })
  const res = await links(u, [id])
  assert.ok(res.body.urls[id].url)
  assert.equal('thumbUrl' in res.body.urls[id], false)
})

test('a file that cannot have a preview is recorded as such and never tried again; its result is still stored', async () => {
  const u = await stack.createUser()
  const id = await ingest(u, jpeg('IMG-OK'), 'image/jpeg')   // a JPEG header with nothing after it
  const row = await asset(id)
  assert.equal(row.thumb_key, null)
  assert.ok(row.thumb_checked_at, 'recorded')
  assert.ok(object(row.s3_key), 'the result itself is stored')
  assert.deepEqual(await thumbs.listWithoutThumbnail({ limit: 10, olderThanSeconds: 0 }), [], 'the worker will not ask about it')
})

test('without ffmpeg the result is stored anyway, and the preview is left for later', async () => {
  process.env.FFMPEG_PATH = path.join(os.tmpdir(), 'no-such-ffmpeg-binary')
  const u = await stack.createUser()
  const id = await ingest(u, skip ? jpeg('IMG-OK') : media.png, skip ? 'image/jpeg' : 'image/png')
  const row = await asset(id)
  assert.ok(object(row.s3_key))
  assert.equal(row.thumb_key, null)
  assert.equal(row.thumb_checked_at, null, 'not recorded as impossible: ffmpeg may be there next time')
})

test('an upload gets its preview once confirmed, from the sealed copy', { skip }, async () => {
  const u = await stack.createUser()
  const ask = await stack.api('POST', '/api/storage/upload-url', { token: u.token, body: { contentType: 'image/jpeg', byteSize: media.jpg.length } })
  assert.equal(ask.status, 200)
  const put = await realFetch(ask.body.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: media.jpg })
  assert.equal(put.status, 200)
  assert.equal((await stack.api('POST', '/api/storage/confirm', { token: u.token, body: { assetId: ask.body.assetId } })).status, 200)
  await thumbs.thumbnailsSettled()

  const row = await asset(ask.body.assetId)
  assert.match(row.s3_key, /-sealed\.jpg$/)
  assert.equal(row.thumb_key, thumbs.thumbKeyFor(row.s3_key))
  assert.ok(isJpeg(object(row.thumb_key)?.body))
})

test('deleting a file deletes its preview — one file, a gallery entry, an influencer, an account', { skip }, async () => {
  const u = await stack.createUser()
  const remaining = () => [...stack.s3.objects.keys()].filter(k => k.startsWith(`users/${u.id}/`))

  // One file.
  let row = await asset(await ingest(u, media.png, 'image/png'))
  assert.equal((await stack.api('POST', '/api/storage/delete', { token: u.token, body: { assetId: row.id } })).status, 204)
  assert.deepEqual(remaining(), [])

  // A gallery entry.
  const inf = (await stack.one(`insert into influencers (user_id, name) values ($1, 'Mia') returning id`, [u.id])).id
  row = await asset(await ingest(u, media.png, 'image/png'))
  const gen = (await stack.api('POST', '/api/generations/add', { token: u.token, body: { assetId: row.id, influencerId: inf } })).body.generation
  assert.equal((await stack.api('POST', '/api/generations/delete', { token: u.token, body: { generationId: gen.id } })).status, 204)
  assert.deepEqual(remaining(), [])

  // An influencer and everything of it.
  for (const bytes of [media.png, media.mp4]) {
    const id = await ingest(u, bytes, bytes === media.png ? 'image/png' : 'video/mp4')
    await stack.sql('update assets set influencer_id = $2 where id = $1', [id, inf])
  }
  assert.equal(remaining().length, 4, 'two files and two previews')
  assert.equal((await stack.api('POST', '/api/influencers/delete', { token: u.token, body: { influencerId: inf } })).status, 200)
  assert.deepEqual(remaining(), [])

  // The whole account.
  await ingest(u, media.png, 'image/png')
  assert.equal(remaining().length, 2)
  assert.equal((await stack.api('POST', '/api/account/delete', { token: u.token, body: { email: u.email, password: u.password } })).status, 200)
  assert.deepEqual(remaining(), [])
})

test('a file deleted while its preview is being made leaves nothing behind', { skip }, async () => {
  const u = await stack.createUser()
  const { id, key } = await stack.putAsset({ userId: u.id, bytes: media.jpg, origin: 'generated' })
  await stack.sql('delete from assets where id = $1', [id])
  stack.s3.objects.delete(key)
  const result = await thumbs.makeThumbnail({ id, s3_key: key, kind: 'image', content_type: 'image/jpeg' }, { bytes: media.jpg })
  assert.equal(result.status, 'gone')
  assert.equal(object(thumbs.thumbKeyFor(key)), undefined, 'the preview written for it was removed')
})

test('the worker gives older files their previews, newest first, and leaves alone what it should', { skip }, async () => {
  const u = await stack.createUser()
  const old = await stack.putAsset({ userId: u.id, bytes: media.jpg, origin: 'generated', ageMinutes: 60 * 24 })
  const video = await stack.putAsset({ userId: u.id, kind: 'video', bytes: media.mp4, origin: 'generated', ageMinutes: 60 })
  const blocked = await stack.putAsset({ userId: u.id, bytes: media.jpg, origin: 'generated', moderationStatus: 'blocked', ageMinutes: 60 })
  const unconfirmed = await stack.putAsset({ userId: u.id, bytes: media.jpg, sealed: false, ageMinutes: 10 })
  const oldUnconfirmed = await stack.putAsset({ userId: u.id, bytes: media.jpg, sealed: false, ageMinutes: 120 })
  const audio = await stack.putAsset({ userId: u.id, kind: 'audio', bytes: Buffer.from('ID3'), origin: 'generated', ageMinutes: 60 })
  const fresh = await stack.putAsset({ userId: u.id, bytes: media.jpg, origin: 'generated', ageMinutes: 0 })

  const waiting = (await thumbs.listWithoutThumbnail({ limit: 50 })).map(a => a.id)
  assert.deepEqual(waiting, [video.id, oldUnconfirmed.id, old.id], 'newest first; not blocked, not an upload that may still change, not audio, not one the API is still on')

  await worker.sweepThumbnails()
  for (const a of [old, video, oldUnconfirmed]) assert.ok((await asset(a.id)).thumb_key, a.id)
  for (const a of [blocked, unconfirmed, audio, fresh]) assert.equal((await asset(a.id)).thumb_key, null, a.id)
  assert.deepEqual(await thumbs.listWithoutThumbnail({ limit: 50 }), [], 'nothing left for the next sweep')
})

test('the worker waits longer each time a preview fails for a reason that may pass', async () => {
  process.env.FFMPEG_PATH = path.join(os.tmpdir(), 'no-such-ffmpeg-binary')
  const u = await stack.createUser()
  const a = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK'), origin: 'generated', ageMinutes: 60 })
  const gets = () => stack.s3.log.filter(l => l.startsWith('GET ') && l.includes(a.key)).length

  await worker.sweepThumbnails()
  assert.equal(gets(), 1)
  await worker.sweepThumbnails()
  assert.equal(gets(), 1, 'not straight back to it on the next cycle')
  assert.equal((await asset(a.id)).thumb_checked_at, null, 'still waiting, not given up on')
})
