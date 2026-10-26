// "Saved to Gallery": when the toast appears, when results join one, when to stay quiet, what is unseen.
// Run with:  node --test "core/notices/*.test.js"

import test from 'node:test'
import assert from 'node:assert/strict'

import { createGalleryNotices, toastTitle, badgeText, TOAST_MS } from './galleryNotice.js'
import { onGalleryAdded, emitGalleryAdded } from './galleryEvents.js'

/** A notice board with a clock the test moves. */
function board() {
  let t = 1_000_000
  const notices = createGalleryNotices({ now: () => t })
  return { notices, tick: ms => { t += ms }, snap: () => notices.getSnapshot() }
}
const video = (id, extra = {}) => ({ id, type: 'video', label: 'Video', url: 'https://x.test/v.mp4', thumbUrl: null, ...extra })
const image = (id, extra = {}) => ({ id, type: 'image', label: 'Image', url: 'https://x.test/i.jpg', thumbUrl: 'https://x.test/i.thumb.jpg', ...extra })

// ── The toast ────────────────────────────────────────────────────────────────

test('a result filed in a gallery nobody is looking at: a toast about it and one unseen', () => {
  const { notices, snap } = board()
  notices.add({ influencerId: 'ashley', entry: video('g1') })
  const { toast, unseen } = snap()
  assert.equal(toast.influencerId, 'ashley')
  assert.equal(toast.count, 1)
  assert.deepEqual(toast.kinds, { image: 0, video: 1 })
  assert.equal(toast.latest.type, 'video')
  assert.equal(toast.latest.thumbUrl, null, 'a new video has no preview yet: the toast draws a tile')
  assert.deepEqual(unseen, { ashley: 1 })
})

test('an image brings its preview into the toast', () => {
  const { notices, snap } = board()
  notices.add({ influencerId: 'ashley', entry: image('g1') })
  assert.equal(snap().toast.latest.thumbUrl, 'https://x.test/i.thumb.jpg')
  assert.equal(snap().toast.latest.type, 'image')
})

test('three results in a row become one toast that counts them, not three toasts', () => {
  const { notices, tick, snap } = board()
  notices.add({ influencerId: 'ashley', entry: image('g1') })
  const first = snap().toast.id
  tick(1500)
  notices.add({ influencerId: 'ashley', entry: image('g2') })
  tick(1500)
  notices.add({ influencerId: 'ashley', entry: image('g3', { thumbUrl: 'https://x.test/3.thumb.jpg' }) })
  const { toast, unseen } = snap()
  assert.equal(toast.id, first, 'the same toast')
  assert.equal(toast.count, 3)
  assert.deepEqual(toast.kinds, { image: 3, video: 0 })
  assert.equal(toast.latest.thumbUrl, 'https://x.test/3.thumb.jpg', 'it shows the newest')
  assert.deepEqual(unseen, { ashley: 3 })
})

test('each arrival starts the clock again, so a steady trickle stays one toast', () => {
  const { notices, tick, snap } = board()
  notices.add({ influencerId: 'a', entry: image('1') })
  const id = snap().toast.id
  for (let i = 2; i <= 5; i++) { tick(TOAST_MS - 100); notices.add({ influencerId: 'a', entry: image(String(i)) }) }
  assert.equal(snap().toast.id, id)
  assert.equal(snap().toast.count, 5)
})

test('after the toast\'s time has passed a new result is a new toast', () => {
  const { notices, tick, snap } = board()
  notices.add({ influencerId: 'a', entry: image('1') })
  const first = snap().toast.id
  tick(TOAST_MS)
  notices.add({ influencerId: 'a', entry: image('2') })
  assert.notEqual(snap().toast.id, first)
  assert.equal(snap().toast.count, 1)
  assert.deepEqual(snap().unseen, { a: 2 }, 'but both are still unseen')
})

test('a result for another influencer is a toast of its own, and the badges are kept apart', () => {
  const { notices, snap } = board()
  notices.add({ influencerId: 'a', entry: image('1') })
  notices.add({ influencerId: 'b', entry: video('2') })
  assert.equal(snap().toast.influencerId, 'b')
  assert.equal(snap().toast.count, 1)
  assert.deepEqual(snap().unseen, { a: 1, b: 1 })
})

test('mixed kinds are counted by kind', () => {
  const { notices, snap } = board()
  notices.add({ influencerId: 'a', entry: image('1') })
  notices.add({ influencerId: 'a', entry: video('2') })
  assert.deepEqual(snap().toast.kinds, { image: 1, video: 1 })
})

test('dismissing closes that toast, and a stale dismissal cannot close a newer one', () => {
  const { notices, tick, snap } = board()
  notices.add({ influencerId: 'a', entry: image('1') })
  const old = snap().toast.id
  tick(TOAST_MS)
  notices.add({ influencerId: 'a', entry: image('2') })
  notices.dismissToast(old)
  assert.ok(snap().toast, 'the newer toast is still there')
  notices.dismissToast(snap().toast.id)
  assert.equal(snap().toast, null)
  assert.deepEqual(snap().unseen, { a: 2 }, 'closing the toast does not mark them seen')
})

// ── Staying quiet ────────────────────────────────────────────────────────────

test('while that gallery is open the result simply appears: no toast, no badge', () => {
  const { notices, snap } = board()
  notices.setViewing('a')
  notices.add({ influencerId: 'a', entry: video('1') })
  assert.equal(snap().toast, null)
  assert.deepEqual(snap().unseen, {})
  notices.add({ influencerId: 'b', entry: video('2') })
  assert.equal(snap().toast.influencerId, 'b', 'another influencer\'s result still is announced')
})

test('opening the gallery clears its badge and its toast; leaving it brings the announcements back', () => {
  const { notices, snap } = board()
  notices.add({ influencerId: 'a', entry: image('1') })
  notices.add({ influencerId: 'a', entry: image('2') })
  assert.deepEqual(snap().unseen, { a: 2 })
  notices.setViewing('a')
  assert.deepEqual(snap().unseen, {})
  assert.equal(snap().toast, null)
  notices.setViewing(null)
  notices.add({ influencerId: 'a', entry: image('3') })
  assert.equal(snap().toast.count, 1)
  assert.deepEqual(snap().unseen, { a: 1 })
})

test('marking one influencer seen leaves another\'s toast and badge alone', () => {
  const { notices, snap } = board()
  notices.add({ influencerId: 'a', entry: image('1') })
  notices.add({ influencerId: 'b', entry: image('2') })
  notices.markSeen('a')
  assert.deepEqual(snap().unseen, { b: 1 })
  assert.equal(snap().toast.influencerId, 'b')
})

// ── Duplicates and bad input ─────────────────────────────────────────────────

test('the same entry announced twice counts once', () => {
  const { notices, snap } = board()
  notices.add({ influencerId: 'a', entry: image('1') })
  notices.add({ influencerId: 'a', entry: image('1') })
  assert.equal(snap().toast.count, 1)
  assert.deepEqual(snap().unseen, { a: 1 })
})

test('an entry old enough to be forgotten can be announced again; a number and its text are the same id', () => {
  const { notices, tick, snap } = board()
  notices.add({ influencerId: 'a', entry: image(7) })
  notices.add({ influencerId: 'a', entry: image('7') })
  assert.equal(snap().toast.count, 1)
  tick(61_000)
  notices.add({ influencerId: 'a', entry: image('7') })
  assert.deepEqual(snap().unseen, { a: 2 })
})

test('nonsense is ignored without a word', () => {
  const { notices, snap } = board()
  for (const bad of [undefined, null, {}, { influencerId: 'a' }, { entry: image('1') }, { influencerId: '', entry: image('1') }, { influencerId: 'a', entry: {} }, { influencerId: 'a', entry: null }]) {
    notices.add(bad ?? {})
  }
  assert.equal(snap().toast, null)
  assert.deepEqual(snap().unseen, {})
})

test('an entry of an unknown kind is treated as an image, and a missing picture as none', () => {
  const { notices, snap } = board()
  notices.add({ influencerId: 'a', entry: { id: 'x', type: 'audio', thumbUrl: '', url: 5 } })
  assert.equal(snap().toast.latest.type, 'image')
  assert.equal(snap().toast.latest.thumbUrl, null)
  assert.equal(snap().toast.latest.url, null)
})

// ── Signing out, and listeners ───────────────────────────────────────────────

test('a different person signing in starts with nothing: no toast, no badge, nothing viewed', () => {
  const { notices, snap } = board()
  notices.setViewing('a')
  notices.add({ influencerId: 'b', entry: image('1') })
  notices.reset()
  assert.equal(snap().toast, null)
  assert.deepEqual(snap().unseen, {})
  notices.add({ influencerId: 'a', entry: image('2') })
  assert.equal(snap().toast.influencerId, 'a', 'and nothing is "being viewed" any more')
})

test('listeners hear every change, the snapshot is the same object when nothing changed, and an unsubscribed one hears nothing', () => {
  const { notices, snap } = board()
  let heard = 0
  const stop = notices.subscribe(() => { heard++ })
  const before = snap()
  notices.markSeen('nobody')
  assert.equal(snap(), before, 'a no-op does not make a new snapshot')
  assert.equal(heard, 0)
  notices.add({ influencerId: 'a', entry: image('1') })
  assert.equal(heard, 1)
  assert.notEqual(snap(), before)
  stop()
  notices.add({ influencerId: 'a', entry: image('2') })
  assert.equal(heard, 1)
})

// ── Words ────────────────────────────────────────────────────────────────────

test('the headline says what was saved, once', () => {
  assert.equal(toastTitle({ count: 1, kinds: { image: 0, video: 1 } }), 'Video saved to Gallery')
  assert.equal(toastTitle({ count: 1, kinds: { image: 1, video: 0 } }), 'Image saved to Gallery')
  assert.equal(toastTitle({ count: 3, kinds: { image: 3, video: 0 } }), '3 images saved to Gallery')
  assert.equal(toastTitle({ count: 2, kinds: { image: 0, video: 2 } }), '2 videos saved to Gallery')
  assert.equal(toastTitle({ count: 4, kinds: { image: 3, video: 1 } }), '4 items saved to Gallery')
})

test('the badge shows 1 to 9 and then 9+', () => {
  assert.deepEqual([1, 5, 9, 10, 250].map(badgeText), ['1', '5', '9', '9+', '9+'])
})

// ── The store's announcement ─────────────────────────────────────────────────

test('the store\'s announcement reaches every listener, survives a listener that throws, and can be stopped', () => {
  const heard = []
  const stopA = onGalleryAdded(() => { throw new Error('boom') })
  const stopB = onGalleryAdded(a => heard.push(a.entry.id))
  const warn = console.warn
  console.warn = () => {}
  try {
    emitGalleryAdded({ influencerId: 'a', entry: { id: '1' } })
    stopB()
    emitGalleryAdded({ influencerId: 'a', entry: { id: '2' } })
  } finally { console.warn = warn; stopA() }
  assert.deepEqual(heard, ['1'])
})
