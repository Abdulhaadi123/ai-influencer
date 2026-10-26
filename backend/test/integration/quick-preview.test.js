// The quick preview a screen shows while a just-finished image's full file comes down: from storage
// when the result is already stored with its preview, made on the spot from KIE's link when it is not,
// and only ever for a result of the caller's own. Real ffmpeg; skipped (with a reason) where there is none.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { startStack } from '../helpers/stack.js'

function haveFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
}
const skip = haveFfmpeg() ? false : 'ffmpeg is not installed here'

let stack
let thumbs
let cdn
let fetched
let media = {}
const realFetch = globalThis.fetch

before(async () => {
  stack = await startStack()
  thumbs = await stack.load('api/_lib/thumbnails.js')
  cdn = new Map()
  fetched = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://tempfile.aiquickdraw.com/')) {
      fetched.push(url)
      const file = cdn.get(url)
      if (!file) return new Response('gone', { status: 404 })
      return new Response(file.body, { status: 200, headers: { 'content-type': file.contentType, 'content-length': String(file.body.length) } })
    }
    return realFetch(input, init)
  }
  if (!skip) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'quick-preview-it-'))
    const run = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' })
    // A 2K result the size KIE makes them, with grain so it does not compress to nothing.
    run(['-f', 'lavfi', '-i', 'testsrc2=size=1536x2752', '-vf', 'noise=alls=25:allf=t+u', '-frames:v', '1', '-q:v', '2', path.join(dir, 'result.jpg')])
    run(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=360x640:rate=24', '-pix_fmt', 'yuv420p', path.join(dir, 'result.mp4')])
    media = { jpg: readFileSync(path.join(dir, 'result.jpg')), mp4: readFileSync(path.join(dir, 'result.mp4')) }
    rmSync(dir, { recursive: true, force: true })
  }
})
after(async () => { globalThis.fetch = realFetch; await stack?.stop() })
beforeEach(async () => { await thumbs.thumbnailsSettled(); await stack.reset(); cdn.clear(); fetched.length = 0 })

let n = 0
/** A finished job of `user`'s whose result is on KIE's CDN, as the app's poll leaves it (state success, result_url set). */
async function finishedJob(user, bytes, contentType = 'image/jpeg', kind = 'image') {
  const url = `https://tempfile.aiquickdraw.com/r/${++n}.${contentType === 'video/mp4' ? 'mp4' : 'jpg'}`
  cdn.set(url, { body: bytes, contentType })
  await stack.sql(
    `insert into generation_jobs (user_id, kie_task_id, kind, label, model, state, result_url, completed_at)
     values ($1, $2, $3, 'Influencer image', 'nano-banana-pro', 'success', $4, now())`,
    [user.id, `qp-${n}`, kind, url],
  )
  return url
}

const quick = (user, sourceUrl) =>
  stack.api('POST', '/api/storage/quick-preview', { token: user.token, body: { sourceUrl } })

const jpegOf = dataUrl => Buffer.from(String(dataUrl).replace(/^data:image\/jpeg;base64,/, ''), 'base64')
const widthOf = jpeg => {
  // The width from the JPEG's start-of-frame segment.
  for (let i = 2; i < jpeg.length - 9;) {
    if (jpeg[i] !== 0xff) return null
    const marker = jpeg[i + 1]
    const len = jpeg.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xc3) return jpeg.readUInt16BE(i + 7)
    i += 2 + len
  }
  return null
}

test('a result not stored yet: a small JPEG made from KIE\'s file, in the answer, nothing stored', { skip }, async () => {
  const u = await stack.createUser()
  const url = await finishedJob(u, media.jpg)

  const res = await quick(u, url)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.kind, 'rendered')
  assert.match(res.body.url, /^data:image\/jpeg;base64,/)
  const jpeg = jpegOf(res.body.url)
  assert.ok(jpeg[0] === 0xff && jpeg[1] === 0xd8, 'a JPEG')
  assert.equal(widthOf(jpeg), thumbs.THUMB_WIDTH, 'scaled to the preview width')
  assert.ok(jpeg.length < media.jpg.length / 10, `a fraction of the file (${jpeg.length} of ${media.jpg.length} bytes)`)
  assert.equal((await stack.one('select count(*)::int as n from assets')).n, 0, 'storing is left to ingest')
  assert.match(res.headers.get('cache-control') || '', /no-store/, 'a signed or private answer is never cached')
})

test('a result already stored with its preview: a signed link to that preview, without fetching from KIE', { skip }, async () => {
  const u = await stack.createUser()
  const url = await finishedJob(u, media.jpg)
  const ingest = await stack.api('POST', '/api/storage/ingest', { token: u.token, body: { sourceUrl: url } })
  assert.equal(ingest.status, 200, JSON.stringify(ingest.body))
  await thumbs.thumbnailsSettled()
  fetched.length = 0

  const res = await quick(u, url)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.kind, 'stored')
  const row = await stack.one('select thumb_key from assets where id = $1', [ingest.body.assetId])
  assert.ok(row.thumb_key)
  assert.ok(res.body.url.includes(row.thumb_key.split('/').pop()), 'the preview\'s own link')
  assert.deepEqual(fetched, [], 'nothing fetched from KIE')
})

test('stored but its preview not made yet: made on the spot from KIE\'s file', { skip }, async () => {
  const u = await stack.createUser()
  const url = await finishedJob(u, media.jpg)
  await stack.putAsset({ userId: u.id, kind: 'image', origin: 'generated', bytes: media.jpg, contentType: 'image/jpeg' })
  await stack.sql('update assets set source_url = $1 where user_id = $2', [url, u.id])
  await stack.sql('update generation_jobs set result_url = null where user_id = $1', [u.id])   // collected, as ingest leaves it

  const res = await quick(u, url)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.kind, 'rendered')
})

test('only a result of the caller\'s own: another account\'s job is "not found", and nothing is fetched', { skip }, async () => {
  const owner = await stack.createUser()
  const stranger = await stack.createUser()
  const url = await finishedJob(owner, media.jpg)

  const res = await quick(stranger, url)
  assert.equal(res.status, 404)
  assert.deepEqual(fetched, [], 'KIE is never asked for someone else\'s result')
})

test('an address that is no job\'s result at all is "not found" — this is not a proxy for KIE\'s hosts', async () => {
  const u = await stack.createUser()
  const res = await quick(u, 'https://tempfile.aiquickdraw.com/r/somebody-elses.jpg')
  assert.equal(res.status, 404)
  assert.deepEqual(fetched, [])
})

test('a link outside KIE\'s hosts, or not https, is refused before anything is looked up', async () => {
  const u = await stack.createUser()
  for (const sourceUrl of ['http://tempfile.aiquickdraw.com/r/1.jpg', 'https://169.254.169.254/latest/meta-data', 'https://evil.example/x.jpg', '', 42]) {
    const res = await quick(u, sourceUrl)
    assert.equal(res.status, 400, `refused: ${sourceUrl}`)
    assert.equal(res.body.code, 'BAD_SOURCE')
  }
})

test('a stored result that moderation blocked gets no preview', { skip }, async () => {
  const u = await stack.createUser()
  const url = await finishedJob(u, media.jpg)
  await stack.putAsset({ userId: u.id, kind: 'image', origin: 'generated', bytes: media.jpg, contentType: 'image/jpeg', moderationStatus: 'blocked' })
  await stack.sql('update assets set source_url = $1, thumb_key = s3_key where user_id = $2', [url, u.id])

  const res = await quick(u, url)
  assert.equal(res.status, 404)
  assert.deepEqual(fetched, [])
})

test('a video result gets no quick preview (videos have their own poster frame)', { skip }, async () => {
  const u = await stack.createUser()
  const url = await finishedJob(u, media.mp4, 'video/mp4', 'video')
  const res = await quick(u, url)
  assert.equal(res.status, 404, 'only image jobs qualify')
})

test('KIE no longer has the file: a clear 502, not a crash', { skip }, async () => {
  const u = await stack.createUser()
  const url = await finishedJob(u, media.jpg)
  cdn.delete(url)
  const res = await quick(u, url)
  assert.equal(res.status, 502)
  assert.equal(res.body.code, 'SOURCE_UNAVAILABLE')
})

/** An image job of `user`'s that KIE has finished but whose row has not heard yet (no result_url). */
async function unrecordedJob(user, bytes) {
  const taskId = `qp-task-${++n}`
  const url = `https://tempfile.aiquickdraw.com/r/${n}.jpg`
  cdn.set(url, { body: bytes, contentType: 'image/jpeg' })
  await stack.sql(
    `insert into generation_jobs (user_id, kie_task_id, kind, label, model, state) values ($1, $2, 'image', 'Influencer image', 'nano-banana-pro', 'generating')`,
    [user.id, taskId],
  )
  stack.kie.tasks.set(taskId, { taskId, state: 'success', resultJson: JSON.stringify({ resultUrls: [url] }), completeTime: Date.now(), creditsConsumed: 18 })
  return { taskId, url }
}

test('the phone heard "finished" before the job row did: its own taskId lets KIE confirm the link, and the row is brought up to date', { skip }, async () => {
  const u = await stack.createUser()
  const { taskId, url } = await unrecordedJob(u, media.jpg)

  assert.equal((await quick(u, url)).status, 404, 'without the taskId the link is not known to be theirs')

  const res = await stack.api('POST', '/api/storage/quick-preview', { token: u.token, body: { sourceUrl: url, taskId } })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.kind, 'rendered')
  const job = await stack.one('select state, result_url from generation_jobs where user_id = $1 and kie_task_id = $2', [u.id, taskId])
  assert.equal(job.state, 'success')
  assert.equal(job.result_url, url, 'recorded, as a sync would')
})

test('a taskId does not open someone else\'s result, nor a link that is not that task\'s', { skip }, async () => {
  const owner = await stack.createUser()
  const other = await stack.createUser()
  const { taskId, url } = await unrecordedJob(owner, media.jpg)

  const theirs = await stack.api('POST', '/api/storage/quick-preview', { token: other.token, body: { sourceUrl: url, taskId } })
  assert.equal(theirs.status, 404, 'another account\'s task')

  const mine = await unrecordedJob(other, media.jpg)
  const wrongLink = await stack.api('POST', '/api/storage/quick-preview', { token: other.token, body: { sourceUrl: url, taskId: mine.taskId } })
  assert.equal(wrongLink.status, 404, 'their own task, but the link is not its result')
  assert.ok(!fetched.includes(url), 'the other result was never fetched')
})

test('signed out: refused', async () => {
  const res = await stack.api('POST', '/api/storage/quick-preview', { body: { sourceUrl: 'https://tempfile.aiquickdraw.com/r/1.jpg' } })
  assert.equal(res.status, 401)
})
