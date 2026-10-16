// Small pure modules: the KIE filter flag, file sniffing, moderation settings,
// the credits parser, and the admin helpers that need no database.

import test from 'node:test'
import assert from 'node:assert/strict'

import { withProviderFilters, NSFW_CHECKER_MODELS, nsfwCheckerEnabled } from '../../api/_lib/moderation/kieFilters.js'
import { sniffMedia } from '../../api/_lib/moderation/sniff.js'
import { isSealed, sealedKeyFor } from '../../api/_lib/moderation/seal.js'
import { UPLOAD_TTL_SECONDS } from '../../api/_lib/s3.js'
import { moderationConfig, describeModeration } from '../../api/_lib/moderation/config.js'
import { creditsFrom } from '../../api/_lib/kieStatus.js'
import { statusFromCallback } from '../../api/kie-callback.js'
import { likeTerm, pageOf } from '../../api/_lib/admin.js'
import { sampleTimes } from '../../api/_lib/moderation/frames.js'

// ── KIE's nsfw_checker flag ──────────────────────────────────────────────────

test('the flag is added for a model that has it, and only to its input', () => {
  const body = { model: 'bytedance/seedance-2-5', callBackUrl: 'https://x.test/cb', input: { prompt: 'hello there' } }
  const out = withProviderFilters(body)
  assert.deepEqual(out.input, { prompt: 'hello there', nsfw_checker: true })
  assert.equal(out.model, body.model)
  assert.equal(out.callBackUrl, body.callBackUrl)
  assert.equal(body.input.nsfw_checker, undefined, 'the caller\'s object is not mutated')
})

test('the app cannot switch it off: a client-sent false is overridden', () => {
  const out = withProviderFilters({ model: 'wan/2-6-image-to-video', input: { nsfw_checker: false } })
  assert.equal(out.input.nsfw_checker, true)
})

test('a model without the flag is left exactly alone (an unknown field could fail its jobs)', () => {
  for (const model of ['kling-3.0/video', 'kling-3.0/motion-control', 'nano-banana-pro', 'veo3_fast', 'veo-3-1', 'minimax-h3/text-to-video', 'pixverse-v6/image-to-video']) {
    const body = { model, input: { prompt: 'x y' } }
    assert.equal(withProviderFilters(body), body, `${model} must be returned untouched`)
  }
})

test('the models the app actually offers that have the flag are all covered', () => {
  // From mobile/core/config/videoModels.js, checked against KIE's documentation.
  for (const id of [
    'bytedance/seedance-2-5', 'bytedance/seedance-2-mini', 'bytedance/seedance-2-fast',
    'hailuo/2-3-image-to-video-pro', 'wan/2-6-image-to-video', 'wan/2-5-image-to-video',
    'wan/2-2-animate-move', 'grok-imagine/image-to-video',
  ]) assert.ok(NSFW_CHECKER_MODELS.has(id), id)
})

test('KIE_NSFW_CHECKER=false turns it off; anything else leaves it on', () => {
  const body = { model: 'bytedance/seedance-2-5', input: {} }
  assert.equal(withProviderFilters(body, { KIE_NSFW_CHECKER: 'false' }), body)
  assert.equal(nsfwCheckerEnabled({}), true)
  assert.equal(nsfwCheckerEnabled({ KIE_NSFW_CHECKER: 'FALSE' }), false)
  assert.equal(nsfwCheckerEnabled({ KIE_NSFW_CHECKER: 'maybe' }), true)
})

test('a malformed request passes through for KIE to reject', () => {
  for (const body of [null, undefined, 'x', 5, { model: 'bytedance/seedance-2-5' }, { model: 'bytedance/seedance-2-5', input: 'a string' }, { model: 'bytedance/seedance-2-5', input: [] }]) {
    assert.equal(withProviderFilters(body), body)
  }
})

// ── Sniffing ─────────────────────────────────────────────────────────────────

const pad = bytes => Buffer.concat([Buffer.from(bytes), Buffer.alloc(32)])

test('sniffMedia recognises what the app stores, from the bytes alone', () => {
  assert.deepEqual(sniffMedia(pad([0xff, 0xd8, 0xff, 0xe0])), { kind: 'image', contentType: 'image/jpeg' })
  assert.deepEqual(sniffMedia(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), { kind: 'image', contentType: 'image/png' })
  assert.deepEqual(sniffMedia(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)])), { kind: 'image', contentType: 'image/webp' })
  assert.deepEqual(sniffMedia(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(16)])), { kind: 'video', contentType: 'video/mp4' })
  assert.deepEqual(sniffMedia(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(16)])), { kind: 'video', contentType: 'video/quicktime' })
  assert.deepEqual(sniffMedia(Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('moov'), Buffer.alloc(24)])), { kind: 'video', contentType: 'video/quicktime' })
  assert.deepEqual(sniffMedia(pad([0x1a, 0x45, 0xdf, 0xa3])), { kind: 'video', contentType: 'video/webm' })
})

test('sniffMedia refuses what it does not know — including text posing as media', () => {
  for (const bytes of [
    Buffer.from('<!doctype html><html></html>'),
    Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n'),
    Buffer.from('%PDF-1.7 and more bytes'),
    Buffer.alloc(40),
    Buffer.from('short'),
    Buffer.alloc(0),
  ]) assert.equal(sniffMedia(bytes), null)
  assert.equal(sniffMedia(null), null)
  assert.equal(sniffMedia(undefined), null)
})

test('sniffMedia knows audio from its bytes: WAV, MP3 (tag or bare frame), M4A', () => {
  assert.deepEqual(sniffMedia(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(8)])), { kind: 'audio', contentType: 'audio/wav' })
  assert.deepEqual(sniffMedia(pad([0x49, 0x44, 0x33, 0x04, 0x00])), { kind: 'audio', contentType: 'audio/mpeg' })
  assert.deepEqual(sniffMedia(pad([0xff, 0xfb, 0x90, 0x00])), { kind: 'audio', contentType: 'audio/mpeg' })
  for (const brand of ['M4A ', 'M4B ', 'M4P ']) {
    assert.deepEqual(sniffMedia(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp' + brand), Buffer.alloc(16)])), { kind: 'audio', contentType: 'audio/mp4' }, brand)
  }
})

test('sniffMedia: a JPEG is never taken for an MPEG frame, nor a video for audio', () => {
  // FF D8 starts every JPEG; the MPEG frame sync is FF E0 and up. The images are checked first
  // and the sync test needs all three top bits, so the two cannot be confused.
  assert.equal(sniffMedia(pad([0xff, 0xd8, 0xff, 0xdb])).kind, 'image')
  assert.equal(sniffMedia(pad([0xff, 0xd8, 0x00, 0x00])), null, 'FF D8 without the third FF is neither')
  // An ordinary MP4 brand stays a video.
  assert.equal(sniffMedia(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)])).kind, 'video')
  // A RIFF that is neither WEBP nor WAVE is nothing we store.
  assert.equal(sniffMedia(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST'), Buffer.alloc(8)])), null)
})

// ── Sealing ──────────────────────────────────────────────────────────────────

const MIN = 60 * 1000
const LINK_LIFE_MS = UPLOAD_TTL_SECONDS * 1000
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0)
const ago = ms => new Date(NOW - ms)

test('isSealed: only a young, unconfirmed upload is open to rewriting', () => {
  // The one case that is not sealed.
  assert.equal(isSealed({ origin: 'upload', sealed_at: null, created_at: ago(1 * MIN) }, NOW), false)
  // Everything else is.
  assert.equal(isSealed({ origin: 'upload', sealed_at: ago(0), created_at: ago(1 * MIN) }, NOW), true, 'sealed_at set')
  assert.equal(isSealed({ origin: 'generated', sealed_at: null, created_at: ago(1 * MIN) }, NOW), true, 'the server wrote it; no link exists')
  assert.equal(isSealed({ origin: 'generated', sealed_at: null, created_at: null }, NOW), true)
})

test('isSealed: an upload counts as sealed only after its link is certainly dead', () => {
  const at = ms => isSealed({ origin: 'upload', sealed_at: null, created_at: ago(ms) }, NOW)
  assert.equal(at(LINK_LIFE_MS - MIN), false, 'link still valid')
  assert.equal(at(LINK_LIFE_MS + 5 * MIN), false, 'expired, but inside the clock margin')
  assert.equal(at(LINK_LIFE_MS + 16 * MIN), true, 'expired and past the margin')
  assert.equal(at(180 * MIN), true, 'a file uploaded long before sealing existed')
})

test('isSealed: no creation time means unsealed, never a crash', () => {
  assert.equal(isSealed({ origin: 'upload', sealed_at: null, created_at: null }, NOW), false)
  assert.equal(isSealed({ origin: 'upload', sealed_at: null, created_at: 'not a date' }, NOW), false)
  assert.equal(isSealed({ origin: 'upload' }, NOW), false)
})

test('sealedKeyFor keeps the folder and the extension and only marks the name', () => {
  const dir = 'users/11111111-2222-3333-4444-555555555555/2026/10'
  assert.equal(sealedKeyFor(`${dir}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg`), `${dir}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-sealed.jpg`)
  assert.equal(sealedKeyFor(`${dir}/x.mp4`), `${dir}/x-sealed.mp4`)
  assert.equal(sealedKeyFor(`${dir}/x`), `${dir}/x-sealed`, 'no extension')
  assert.equal(sealedKeyFor('users/a.b/c'), 'users/a.b/c-sealed', 'a dot in a folder is not an extension')
  assert.notEqual(sealedKeyFor(`${dir}/x.jpg`), `${dir}/x.jpg`, 'always a different key — a copy onto itself would seal nothing')
})

// ── Settings ─────────────────────────────────────────────────────────────────

test('moderation is on when a key is configured, unless it is switched off', () => {
  assert.equal(moderationConfig({}).enabled, false)
  assert.equal(moderationConfig({ OPENAI_API_KEY: 'k' }).enabled, true)
  assert.equal(moderationConfig({ OPENAI_API_KEY: 'k', MODERATION_ENABLED: 'false' }).enabled, false)
  assert.equal(moderationConfig({ MODERATION_ENABLED: 'true' }).enabled, true, 'explicit on, even with no key (and the server says so loudly)')
  assert.equal(moderationConfig({ OPENAI_API_KEY: 'k', MODERATION_ENABLED: 'TRUE' }).enabled, true)
})

test('it fails closed unless told otherwise', () => {
  assert.equal(moderationConfig({}).failClosed, true)
  assert.equal(moderationConfig({ MODERATION_FAIL_MODE: 'open' }).failClosed, false)
  assert.equal(moderationConfig({ MODERATION_FAIL_MODE: 'OPEN' }).failClosed, false)
  assert.equal(moderationConfig({ MODERATION_FAIL_MODE: 'typo' }).failClosed, true, 'a typo must not silently open the gate')
})

test('numbers fall back to their defaults when they are not sensible', () => {
  const c = moderationConfig({ MODERATION_STRIKE_LIMIT: '-3', MODERATION_STRIKE_WINDOW_DAYS: 'abc', MODERATION_VIDEO_FRAMES: '99', MODERATION_TIMEOUT_MS: '0' })
  assert.equal(c.strikeLimit, 5)
  assert.equal(c.strikeWindowDays, 30)
  assert.equal(c.videoFrames, 8, 'capped')
  assert.equal(c.timeoutMs, 15000)
  assert.equal(moderationConfig({ MODERATION_STRIKE_LIMIT: '2' }).strikeLimit, 2)
})

test('a broken MODERATION_THRESHOLDS does not take requests down, and startup says so', () => {
  const env = { OPENAI_API_KEY: 'k', MODERATION_THRESHOLDS: '{broken' }
  const c = moderationConfig(env)
  assert.match(c.thresholdsProblem, /not valid JSON/)
  assert.ok(c.rules.sexual, 'the defaults are in use')
  assert.ok(describeModeration(env).some(l => l.level === 'error' && /not valid JSON/.test(l.text)))
})

test('the startup report tells the operator what will happen', () => {
  const levels = env => describeModeration(env).map(l => l.level)
  assert.deepEqual(levels({}), ['warn'], 'no key: off, and says so')
  assert.deepEqual(levels({ OPENAI_API_KEY: 'k' }), ['info'])
  assert.deepEqual(levels({ OPENAI_API_KEY: 'k', MODERATION_ENABLED: 'false' }), ['warn'])
  assert.deepEqual(levels({ MODERATION_ENABLED: 'true' }), ['error'], 'on with no key: every generation refused')
  assert.match(describeModeration({ MODERATION_ENABLED: 'true' })[0].text, /every generation will be refused/)
  assert.match(describeModeration({ MODERATION_ENABLED: 'true', MODERATION_FAIL_MODE: 'open' })[0].text, /NOT being checked/)
})

test('the report never contains the key', () => {
  const text = JSON.stringify(describeModeration({ OPENAI_API_KEY: 'sk-secret-value' }))
  assert.ok(!text.includes('sk-secret-value'))
})

// ── KIE credits ──────────────────────────────────────────────────────────────

test('creditsFrom: a plain non-negative number, or null — never a guess', () => {
  assert.equal(creditsFrom(60), 60)
  assert.equal(creditsFrom(0), 0, 'zero is what KIE reports for a failed task, and is not "unknown"')
  assert.equal(creditsFrom(12.5), 12.5)
  assert.equal(creditsFrom('42'), 42)
  for (const bad of [undefined, null, '', '  ', 'abc', NaN, Infinity, -1, '-5', {}, [], true]) assert.equal(creditsFrom(bad), null, String(bad))
})

test('the callback carries creditsConsumed in both of KIE\'s shapes', () => {
  const unified = statusFromCallback({
    code: 200,
    data: { taskId: 't', state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://tempfile.aiquickdraw.com/a.mp4'] }), creditsConsumed: 27 },
  })
  assert.equal(unified.credits, 27)

  const veo = statusFromCallback({
    code: 200,
    data: { taskId: 't', info: { resultUrls: ['https://tempfile.aiquickdraw.com/v.mp4'] }, creditsConsumed: 60 },
  })
  assert.equal(veo.credits, 60)
  assert.equal(veo.state, 'success')

  const failed = statusFromCallback({ code: 501, msg: 'Failed', data: { taskId: 't', state: 'fail', failMsg: 'x', creditsConsumed: 0 } })
  assert.equal(failed.credits, 0)
  assert.equal(failed.state, 'fail')
})

test('a callback with no creditsConsumed records nothing rather than a guess', () => {
  assert.equal(statusFromCallback({ code: 200, data: { taskId: 't', state: 'success' } }).credits, null)
  assert.equal(statusFromCallback({ code: 200 }).credits, null)
})

// ── Admin helpers ────────────────────────────────────────────────────────────

test('likeTerm makes wildcard characters literal', () => {
  assert.equal(likeTerm('50%_off\\'), '50\\%\\_off\\\\')
  assert.equal(likeTerm('plain'), 'plain')
})

test('pageOf bounds what a client may ask for', () => {
  assert.deepEqual(pageOf({ query: {} }), { page: 1, pageSize: 50, limit: 50, offset: 0 })
  assert.deepEqual(pageOf({ query: { page: '3', pageSize: '10' } }), { page: 3, pageSize: 10, limit: 10, offset: 20 })
  assert.equal(pageOf({ query: { pageSize: '100000' } }).pageSize, 100)
  assert.equal(pageOf({ query: { pageSize: '0' } }).pageSize, 50)
  assert.equal(pageOf({ query: { page: '-4' } }).page, 1)
  assert.equal(pageOf({ query: { page: 'abc', pageSize: 'xyz' } }).offset, 0)
  assert.equal(pageOf({}).page, 1)
})

// ── Frame timing ─────────────────────────────────────────────────────────────

test('sampleTimes: the middle of each slice, never the very first or last instant', () => {
  assert.deepEqual(sampleTimes(4, 4), [0.5, 1.5, 2.5, 3.5])
  assert.deepEqual(sampleTimes(10, 1), [0])
  assert.deepEqual(sampleTimes(0, 4), [0], 'an unknown duration samples the start')
  assert.deepEqual(sampleTimes(Number.NaN, 4), [0])
  const short = sampleTimes(0.05, 4)
  assert.ok(short.every(t => t >= 0 && t <= 0.05), 'a clip shorter than the margin stays inside it')
})
