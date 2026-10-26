// Paging the Queue and the Gallery: what is held after each page, refresh and change.
// Run with:  node --test core/data

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  olderCursor, appendPage, mergeHead, replaceRow,
  galleryEntries, galleryTotal, galleryHasMore, galleryRequest, applyGalleryPage, withoutGalleryEntry, findGalleryEntry,
} from './paging.js'

/** A cursor like the server's: fixed-width moment, then the id. Bigger n = newer. */
const cursorAt = (n, id) => `2026-10-01T10:00:${String(n).padStart(2, '0')}.000000Z|${id}`
const job = (n, extra = {}) => ({ id: `j${n}`, cursor: cursorAt(n, `j${n}`), state: 'success', ...extra })
/** Newest first, like every page. */
const jobs = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => job(from - i))
const idsOf = rows => rows.map(r => r.id)

test('cursors compare as text in row order, and a missing one never wins', () => {
  assert.equal(olderCursor(cursorAt(3, 'a'), cursorAt(5, 'a')), cursorAt(3, 'a'))
  assert.equal(olderCursor(cursorAt(3, 'b'), cursorAt(3, 'a')), cursorAt(3, 'a'), 'same moment: the smaller id is older')
  assert.equal(olderCursor(null, cursorAt(1, 'a')), cursorAt(1, 'a'))
  assert.equal(olderCursor(cursorAt(1, 'a'), undefined), cursorAt(1, 'a'))
  assert.equal(olderCursor(null, null), null)
})

test('queue: a page goes under what is held, and a row already held is not shown twice', () => {
  const held = jobs(10, 6)
  assert.deepEqual(idsOf(appendPage(held, jobs(5, 1))), idsOf(jobs(10, 1)))
  assert.deepEqual(idsOf(appendPage(held, [job(6), job(5)])), [...idsOf(held), 'j5'], 'j6 overlapped')
  assert.equal(appendPage(held, [job(7)]), held, 'nothing new: the same array, nothing re-renders')
})

test('queue: refreshing the top keeps every page scrolled to beyond it', () => {
  const held = jobs(20, 1)   // four pages of five, all loaded
  const head = { rows: [job(22), job(21), ...jobs(20, 18)], hasMore: true }   // two new jobs on top
  const { rows, hasMore } = mergeHead(held, false, head)
  assert.deepEqual(idsOf(rows), idsOf(jobs(22, 1)))
  assert.equal(hasMore, false, 'what was known about the end still holds')
})

test('queue: a job missing from the fresh top was removed, and goes', () => {
  const held = jobs(10, 1)
  const head = { rows: [job(10), job(8), job(7), job(6), job(5)], hasMore: true }   // j9 was removed
  const { rows } = mergeHead(held, false, head)
  assert.deepEqual(idsOf(rows), ['j10', 'j8', 'j7', 'j6', 'j5', 'j4', 'j3', 'j2', 'j1'])
})

test('queue: a job pushed off the first page by a new one stays, just under it', () => {
  const { rows, hasMore } = mergeHead(jobs(10, 6), true, { rows: jobs(11, 7), hasMore: true })
  assert.deepEqual(idsOf(rows), idsOf(jobs(11, 6)))
  assert.equal(hasMore, true)
})

test('queue: with nothing held beyond the first page, the fresh one replaces it and says whether more follows', () => {
  const held = jobs(10, 6)
  const fresh = { rows: [job(10, { state: 'fail' }), ...jobs(9, 6)], hasMore: false }
  assert.deepEqual(mergeHead(held, true, { ...fresh, hasMore: true }), { rows: fresh.rows, hasMore: true })
  assert.deepEqual(mergeHead(held, true, fresh), { rows: fresh.rows, hasMore: false })
})

test('queue: a fresh top that is the whole list replaces everything', () => {
  const { rows, hasMore } = mergeHead(jobs(10, 1), true, { rows: jobs(3, 1), hasMore: false })
  assert.deepEqual(idsOf(rows), ['j3', 'j2', 'j1'])
  assert.equal(hasMore, false)
  assert.deepEqual(mergeHead(jobs(3, 1), false, { rows: [], hasMore: false }), { rows: [], hasMore: false }, 'everything cleared')
})

test('queue: rows of the same moment are told apart by id at the boundary', () => {
  const same = id => ({ id, cursor: cursorAt(5, id) })
  const held = [same('d'), same('c'), same('b'), same('a')]
  const { rows } = mergeHead(held, false, { rows: [same('d'), same('c')], hasMore: true })
  assert.deepEqual(idsOf(rows), ['d', 'c', 'b', 'a'])
})

test('queue: a change from the feed replaces the held row and keeps its cursor; an unknown one is left for the refresh', () => {
  const held = jobs(3, 1)
  const changed = replaceRow(held, { id: 'j2', state: 'fail' })
  assert.equal(changed[1].state, 'fail')
  assert.equal(changed[1].cursor, held[1].cursor)
  assert.equal(replaceRow(held, { id: 'j99', state: 'fail' }), held)
})

// ── Gallery ──────────────────────────────────────────────────────────────────

let n = 1000
/** A gallery entry; bigger `t` = newer. */
const entry = (t, type = 'video', id = `g${n++}`) => ({ id, type, date: t * 1000, cursor: cursorAt(t, id) })
/** A record as the roster gives it: the newest few, and the real totals. */
function record(history, counts) {
  return { id: 'inf', generationHistory: history, galleryExtra: [], galleryPaging: {}, galleryCounts: counts }
}

test('gallery: All continues from the oldest of the roster\'s few, then from where each page ended', () => {
  const r = record([entry(50), entry(49), entry(48)], { total: 10, videos: 10, images: 0 })
  const first = galleryRequest(r, 'all')
  assert.equal(first.cursor, r.generationHistory[2].cursor)
  assert.equal(first.kind, null)

  const page = [entry(47), entry(46)]
  const { record: next, added } = applyGalleryPage(r, first, { entries: page, hasMore: true, nextCursor: page[1].cursor })
  assert.equal(added, 2)
  assert.equal(galleryRequest(next, 'all').cursor, page[1].cursor)
  assert.equal(galleryEntries(next, 'all').length, 5)
})

test('gallery: a page whose entries were all held still moves on — it never asks the same thing twice', () => {
  const held = [entry(50), entry(49)]
  const r = record(held, { total: 5, videos: 5, images: 0 })
  const req = galleryRequest(r, 'all')
  const overlap = [held[1], entry(48)]
  const { record: next } = applyGalleryPage(r, req, { entries: [held[1]], hasMore: true, nextCursor: overlap[0].cursor })
  assert.notEqual(galleryRequest(next, 'all').cursor, undefined)
  const again = applyGalleryPage(next, galleryRequest(next, 'all'), { entries: [entry(48)], hasMore: true, nextCursor: cursorAt(48, 'x') })
  assert.equal(again.added, 1)
})

test('gallery: when the server says nothing is left, nothing more is asked for — even if the totals disagree', () => {
  const r = record([entry(50)], { total: 9, videos: 9, images: 0 })   // the other eight were deleted elsewhere
  const req = galleryRequest(r, 'all')
  const { record: next } = applyGalleryPage(r, req, { entries: [], hasMore: false, nextCursor: null })
  assert.equal(galleryHasMore(next, 'all'), false)
  assert.equal(galleryRequest(next, 'all'), null)
  assert.equal(galleryHasMore(next, 'image'), false, 'All reached the end, so every filter has')
})

test('gallery: a filter pages its own kind from where All reached, and All does not show what it fetched', () => {
  // Newest few are videos; the two images are further back.
  const r = record([entry(50), entry(49), entry(48)], { total: 12, videos: 10, images: 2 })
  assert.deepEqual(galleryEntries(r, 'image'), [])
  assert.equal(galleryHasMore(r, 'image'), true)

  const req = galleryRequest(r, 'image')
  assert.equal(req.kind, 'image')
  assert.equal(req.cursor, r.generationHistory[2].cursor, 'from where All reached: no image is newer than that')

  const images = [entry(30, 'image'), entry(10, 'image')]
  const { record: next } = applyGalleryPage(r, req, { entries: images, hasMore: false, nextCursor: null })
  assert.deepEqual(idsOf(galleryEntries(next, 'image')), idsOf(images))
  assert.equal(galleryHasMore(next, 'image'), false)
  assert.equal(galleryEntries(next, 'all').length, 3, 'All still shows only its unbroken stretch')
  assert.equal(galleryHasMore(next, 'all'), true)
  assert.equal(galleryTotal(next, 'image'), 2)
})

test('gallery: after All scrolls past a filter\'s pages, the filter continues from where All reached', () => {
  const r = record([entry(50, 'image'), entry(49)], { total: 20, videos: 10, images: 10 })
  const imgReq = galleryRequest(r, 'image')
  const shallow = applyGalleryPage(r, imgReq, { entries: [entry(45, 'image')], hasMore: true, nextCursor: cursorAt(45, 'i45') }).record

  // All now reaches much further back than the image pages did.
  const deepPage = [entry(44), entry(40, 'image'), entry(30)]
  const deep = applyGalleryPage(shallow, galleryRequest(shallow, 'all'), { entries: deepPage, hasMore: true, nextCursor: deepPage[2].cursor }).record

  assert.equal(galleryRequest(deep, 'image').cursor, deepPage[2].cursor, 'the older of the two')
  const shown = galleryEntries(deep, 'image')
  assert.equal(shown.length, 3, 'the image All fetched is shown once, not twice')
})

test('gallery: an image fetched by its filter and later by All is shown once in each', () => {
  const shared = entry(40, 'image')
  const r = record([entry(50)], { total: 3, videos: 2, images: 1 })
  const a = applyGalleryPage(r, galleryRequest(r, 'image'), { entries: [shared], hasMore: false, nextCursor: null }).record
  const b = applyGalleryPage(a, galleryRequest(a, 'all'), { entries: [shared, entry(30)], hasMore: false, nextCursor: null }).record
  assert.equal(galleryEntries(b, 'image').length, 1)
  assert.equal(galleryEntries(b, 'all').length, 3)
})

test('gallery: a page that answers an older state of the record is dropped, not added after a gap', () => {
  const r = record([entry(50), entry(49), entry(48)], { total: 10, videos: 10, images: 0 })
  const req = galleryRequest(r, 'all')
  // The roster reloads while the page is on its way: a new record, at its first few again.
  const reloaded = record([entry(60), entry(50)], { total: 11, videos: 11, images: 0 })
  const { record: after, added, stale } = applyGalleryPage(reloaded, req, { entries: [entry(47)], hasMore: true, nextCursor: cursorAt(47, 'x') })
  assert.equal(stale, true)
  assert.equal(added, 0)
  assert.equal(after, reloaded)
})

test('gallery: an entry deleted while a page was on its way is not brought back', () => {
  const gone = entry(47)
  const r = record([entry(50)], { total: 3, videos: 3, images: 0 })
  const { record: next } = applyGalleryPage(r, galleryRequest(r, 'all'), { entries: [gone, entry(46)], hasMore: false }, e => e.id === gone.id)
  assert.ok(!galleryEntries(next, 'all').some(e => e.id === gone.id))
})

test('gallery: a filter page that brings the wrong kind (an older server) shows only its own kind', () => {
  const r = record([entry(50)], { total: 3, videos: 2, images: 1 })
  const { record: next } = applyGalleryPage(r, galleryRequest(r, 'image'), { entries: [entry(40), entry(39, 'image')], hasMore: false })
  assert.deepEqual(galleryEntries(next, 'image').map(e => e.type), ['image'])
})

test('gallery: an empty gallery with more on the server starts from the top', () => {
  const r = record([], { total: 4, videos: 4, images: 0 })
  assert.deepEqual(galleryRequest(r, 'all'), { filter: 'all', kind: null, cursor: null, before: null })
})

test('gallery: entries from a server without cursors continue from the oldest one held', () => {
  const old = { id: 'g-old', type: 'video', date: 1, createdAt: '2026-10-01T00:00:00.000Z' }
  const r = record([old], { total: 4, videos: 4, images: 0 })
  assert.equal(galleryRequest(r, 'all').before, old)
})

test('gallery: deleting finds and removes an entry wherever it is held', () => {
  const extra = entry(10, 'image')
  const r = { ...record([entry(50)], { total: 2, videos: 1, images: 1 }), galleryExtra: [extra] }
  assert.equal(findGalleryEntry(r, extra.id), extra)
  const next = withoutGalleryEntry(r, extra.id)
  assert.equal(findGalleryEntry(next, extra.id), null)
  assert.equal(next.generationHistory.length, 1)
})

test('gallery: no request for an unknown filter, and none once everything is held', () => {
  const r = record([entry(50), entry(49)], { total: 2, videos: 2, images: 0 })
  assert.equal(galleryRequest(r, 'audio'), null)
  assert.equal(galleryRequest(r, 'all'), null)
  assert.equal(galleryHasMore(r, 'image'), false, 'no images exist')
})
