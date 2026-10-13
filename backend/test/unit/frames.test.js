// Frame sampling against the real ffmpeg, on videos this test makes itself.
// Skipped (with a reason) on a machine that has no ffmpeg.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { extractFrames, FramesUnavailableError, UnreadableMediaError } from '../../api/_lib/moderation/frames.js'

const config = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }

function haveFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
}
const skip = haveFfmpeg() ? false : 'ffmpeg and ffprobe are not installed here'

const scratchDirs = () => readdirSync(os.tmpdir()).filter(n => n.startsWith('moderation-'))
const isJpeg = b => b[0] === 0xff && b[1] === 0xd8

function makeVideos() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'frames-test-'))
  const run = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' })
  run(['-f', 'lavfi', '-i', 'testsrc=duration=4:size=640x360:rate=10', '-pix_fmt', 'yuv420p', path.join(dir, 'a.mp4')])
  run(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10', '-c:v', 'libvpx', path.join(dir, 'a.webm')])
  run(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10', '-pix_fmt', 'yuv420p', '-f', 'mov', path.join(dir, 'a.mov')])
  return dir
}

test('frames come out of an mp4, spread across it, as JPEGs no wider than 512px', { skip }, async () => {
  const dir = makeVideos()
  try {
    const frames = await extractFrames(path.join(dir, 'a.mp4'), { contentType: 'video/mp4', count: 4, config })
    assert.equal(frames.length, 4)
    assert.ok(frames.every(isJpeg))
    assert.equal(new Set(frames.map(f => f.toString('base64'))).size, 4, 'four different moments, not one frame four times')

    // Width is in the JPEG's SOF0 marker; read it rather than trusting the filter.
    const sof = frames[0].indexOf(Buffer.from([0xff, 0xc0]))
    assert.ok(sof > 0)
    assert.equal(frames[0].readUInt16BE(sof + 7), 512, 'a 640px frame is scaled down to 512')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('webm and quicktime work too, and a clip shorter than the frame count still yields frames', { skip }, async () => {
  const dir = makeVideos()
  try {
    const webm = await extractFrames(path.join(dir, 'a.webm'), { contentType: 'video/webm', count: 3, config })
    assert.ok(webm.length >= 1 && webm.every(isJpeg))
    const mov = await extractFrames(path.join(dir, 'a.mov'), { contentType: 'video/quicktime', count: 8, config })
    assert.ok(mov.length >= 1 && mov.every(isJpeg))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('no ffmpeg on the machine is its own error, not "bad video"', { skip }, async () => {
  const dir = makeVideos()
  try {
    await assert.rejects(
      extractFrames(path.join(dir, 'a.mp4'), { contentType: 'video/mp4', count: 2, config: { ffmpegPath: 'no-such-ffmpeg', ffprobePath: 'no-such-ffprobe' } }),
      FramesUnavailableError,
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a playlist that claims to be an mp4 is refused, not followed', { skip }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'frames-test-'))
  try {
    // If ffmpeg were allowed to guess the format it would treat this as HLS and
    // try to open the file it names.
    const file = path.join(dir, 'fake.mp4')
    writeFileSync(file, '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\nfile:///etc/hosts\n#EXT-X-ENDLIST\n')
    await assert.rejects(extractFrames(file, { contentType: 'video/mp4', count: 2, config }), UnreadableMediaError)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('garbage and unsupported types are refused', { skip }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'frames-test-'))
  try {
    const garbage = path.join(dir, 'garbage.mp4')
    writeFileSync(garbage, Buffer.alloc(4096, 7))
    await assert.rejects(extractFrames(garbage, { contentType: 'video/mp4', count: 2, config }), UnreadableMediaError)
    await assert.rejects(extractFrames(garbage, { contentType: 'text/html', count: 2, config }), UnreadableMediaError)
    await assert.rejects(extractFrames(path.join(dir, 'missing.mp4'), { contentType: 'video/mp4', count: 2, config }), UnreadableMediaError)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('no scratch directory is left behind, success or failure', { skip }, async () => {
  const before = scratchDirs().length
  const dir = makeVideos()
  try {
    await extractFrames(path.join(dir, 'a.mp4'), { contentType: 'video/mp4', count: 2, config })
    writeFileSync(path.join(dir, 'bad.mp4'), Buffer.alloc(2048, 1))
    await assert.rejects(extractFrames(path.join(dir, 'bad.mp4'), { contentType: 'video/mp4', count: 2, config }))
    assert.equal(scratchDirs().length, before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a filename with shell metacharacters is just a filename (no shell is involved)', { skip }, async () => {
  const dir = makeVideos()
  try {
    const odd = path.join(dir, 'a b; echo pwned $(whoami) `id`.mp4')
    writeFileSync(odd, (await import('node:fs')).readFileSync(path.join(dir, 'a.mp4')))
    const frames = await extractFrames(odd, { contentType: 'video/mp4', count: 2, config })
    assert.ok(frames.length >= 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
