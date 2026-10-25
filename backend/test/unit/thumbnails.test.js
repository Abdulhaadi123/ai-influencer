// Previews against the real ffmpeg, on images and videos this test makes itself.
// Skipped (with a reason) on a machine that has no ffmpeg.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { renderThumbnail, thumbKeyFor, objectKeysOf, canThumbnail, THUMB_WIDTH } from '../../api/_lib/thumbnails.js'
import { FramesUnavailableError, UnreadableMediaError } from '../../api/_lib/moderation/frames.js'

function haveFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
}
const skip = haveFfmpeg() ? false : 'ffmpeg is not installed here'

const isJpeg = b => b[0] === 0xff && b[1] === 0xd8
/** Width and height from a JPEG's SOF0 marker — read, not trusted from the filter. */
function sizeOf(jpeg) {
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]))
  return { height: jpeg.readUInt16BE(sof + 5), width: jpeg.readUInt16BE(sof + 7) }
}
const scratch = () => readdirSync(os.tmpdir()).filter(n => n.startsWith('thumb-'))

function makeMedia() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'thumbs-test-'))
  const run = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' })
  run(['-f', 'lavfi', '-i', 'testsrc=size=1536x2752', '-frames:v', '1', path.join(dir, 'tall.png')])
  run(['-f', 'lavfi', '-i', 'testsrc=size=2048x1152', '-frames:v', '1', path.join(dir, 'wide.jpg')])
  run(['-f', 'lavfi', '-i', 'testsrc=size=320x200', '-frames:v', '1', path.join(dir, 'small.webp')])
  run(['-f', 'lavfi', '-i', 'testsrc=duration=3:size=720x1280:rate=24', '-pix_fmt', 'yuv420p', path.join(dir, 'clip.mp4')])
  run(['-f', 'lavfi', '-i', 'testsrc=duration=0.2:size=640x360:rate=10', '-pix_fmt', 'yuv420p', path.join(dir, 'blink.mp4')])
  run(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=640x360:rate=10', '-c:v', 'libvpx', path.join(dir, 'clip.webm')])
  run(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=640x360:rate=10', '-pix_fmt', 'yuv420p', '-f', 'mov', path.join(dir, 'clip.mov')])
  return dir
}

test('the preview key sits beside the file, under the same prefix', () => {
  assert.equal(thumbKeyFor('users/u1/2026/10/abc.png'), 'users/u1/2026/10/abc.thumb.jpg')
  assert.equal(thumbKeyFor('users/u1/2026/10/abc-sealed.mp4'), 'users/u1/2026/10/abc-sealed.thumb.jpg')
  assert.equal(thumbKeyFor('users/u1/2026/10/abc'), 'users/u1/2026/10/abc.thumb.jpg')
  assert.deepEqual(objectKeysOf({ s3_key: 'a.png', thumb_key: 'a.thumb.jpg' }), ['a.png', 'a.thumb.jpg'])
  assert.deepEqual(objectKeysOf({ s3_key: 'a.png', thumb_key: null }), ['a.png'])
})

test('previews are made only from image and video types', () => {
  for (const t of ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']) assert.ok(canThumbnail(t), t)
  for (const t of ['audio/mpeg', 'text/html', 'application/octet-stream', '', null, undefined, 'constructor', '__proto__']) assert.ok(!canThumbnail(t), String(t))
})

test('a tall 2K image becomes a 512-wide JPEG in proportion, at a tiny fraction of the size', { skip }, async () => {
  const dir = makeMedia()
  try {
    const before = scratch().length
    const jpeg = await renderThumbnail(path.join(dir, 'tall.png'), { contentType: 'image/png' })
    assert.ok(isJpeg(jpeg))
    const { width, height } = sizeOf(jpeg)
    assert.equal(width, THUMB_WIDTH)
    assert.ok(Math.abs(height - Math.round(2752 * THUMB_WIDTH / 1536)) <= 2, `height ${height}`)
    assert.ok(jpeg.length < 150 * 1024, `${jpeg.length} bytes`)
    assert.equal(scratch().length, before, 'no temporary folder is left behind')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a wide JPEG is scaled too, and a picture already smaller than the preview is not enlarged', { skip }, async () => {
  const dir = makeMedia()
  try {
    assert.equal(sizeOf(await renderThumbnail(path.join(dir, 'wide.jpg'), { contentType: 'image/jpeg' })).width, THUMB_WIDTH)
    const small = await renderThumbnail(path.join(dir, 'small.webp'), { contentType: 'image/webp' })
    assert.deepEqual(sizeOf(small), { width: 320, height: 200 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a video becomes one still frame, as a JPEG — mp4, quicktime and webm, and a clip shorter than the poster moment', { skip }, async () => {
  const dir = makeMedia()
  try {
    const poster = await renderThumbnail(path.join(dir, 'clip.mp4'), { contentType: 'video/mp4' })
    assert.ok(isJpeg(poster))
    assert.equal(sizeOf(poster).width, THUMB_WIDTH)
    assert.ok(isJpeg(await renderThumbnail(path.join(dir, 'clip.mov'), { contentType: 'video/quicktime' })))
    assert.ok(isJpeg(await renderThumbnail(path.join(dir, 'clip.webm'), { contentType: 'video/webm' })))
    assert.ok(isJpeg(await renderThumbnail(path.join(dir, 'blink.mp4'), { contentType: 'video/mp4' })), 'a 0.2 s clip still gives its first frame')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a file that is not what it claims is an UnreadableMediaError, never a hang or a crash', { skip }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'thumbs-bad-'))
  try {
    const cases = [
      ['page.png', '<!doctype html><html><body>hi</body></html>', 'image/png'],
      ['list.mp4', '#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n', 'video/mp4'],
      ['empty.jpg', '', 'image/jpeg'],
      ['noise.webm', 'x'.repeat(5000), 'video/webm'],
    ]
    for (const [name, body, contentType] of cases) {
      const file = path.join(dir, name)
      writeFileSync(file, body)
      await assert.rejects(renderThumbnail(file, { contentType }), UnreadableMediaError, name)
    }
    await assert.rejects(renderThumbnail(path.join(dir, 'page.png'), { contentType: 'audio/mpeg' }), UnreadableMediaError, 'a type with no preview')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('no ffmpeg on the machine is a FramesUnavailableError — a deployment problem, worth trying again later', async () => {
  const saved = process.env.FFMPEG_PATH
  process.env.FFMPEG_PATH = path.join(os.tmpdir(), 'no-such-ffmpeg-binary')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'thumbs-noff-'))
  try {
    const file = path.join(dir, 'a.png')
    writeFileSync(file, 'x')
    await assert.rejects(renderThumbnail(file, { contentType: 'image/png' }), FramesUnavailableError)
    await assert.rejects(renderThumbnail(file, { contentType: 'video/mp4' }), FramesUnavailableError)
  } finally {
    if (saved === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = saved
    rmSync(dir, { recursive: true, force: true })
  }
})
