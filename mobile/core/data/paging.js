/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Paging the Queue and the Gallery — the pure part.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Both lists come from the server newest first, a page at a time (backend
 * api/_lib/paging.js). Every row carries a `cursor` — its moment to the
 * microsecond and its id — and the next page is "older than this cursor".
 * Cursors compare as plain strings in row order: the smaller one is older.
 *
 * No imports and no state, so it is tested on its own (paging.test.js).
 */

/** The older of two cursors; a missing one loses. */
export function olderCursor(a, b) {
  if (!a) return b || null
  if (!b) return a
  return a < b ? a : b
}

// ── The Queue ────────────────────────────────────────────────────────────────

/**
 * Add the next page under what is held. A row already held stays where it is —
 * a page that overlaps a refresh of the top must not show a job twice.
 */
export function appendPage(rows, page) {
  const held = new Set(rows.map(r => r.id))
  const fresh = page.filter(r => !held.has(r.id))
  return fresh.length ? [...rows, ...fresh] : rows
}

/**
 * Put a fresh first page on top of what is held, keeping every page loaded
 * beyond it.
 *
 * The first page is the truth for its stretch of the list: a job in that
 * stretch that is not in it has been removed, so it goes. Rows older than its
 * last one were loaded by scrolling and stay, so refreshing the top never
 * throws away what someone has scrolled to. When the first page is the whole
 * list (`hasMore` false), it replaces everything.
 *
 * @param {object[]} rows      what is held, newest first
 * @param {boolean} hasMore    whether more was known to follow what is held
 * @param {{rows: object[], hasMore: boolean}} head  the first page, just fetched
 * @returns {{rows: object[], hasMore: boolean}}
 */
export function mergeHead(rows, hasMore, head) {
  if (!head.hasMore || !head.rows.length) return { rows: head.rows, hasMore: head.hasMore }
  const boundary = head.rows.at(-1).cursor
  const inHead = new Set(head.rows.map(r => r.id))
  const deeper = boundary ? rows.filter(r => r.cursor && r.cursor < boundary && !inHead.has(r.id)) : []
  return deeper.length
    ? { rows: [...head.rows, ...deeper], hasMore }
    : { rows: head.rows, hasMore: head.hasMore }
}

/**
 * A changed row, from the change feed, in place of the one held. Only rows
 * already held are touched: a new job is added by the next refresh of the top,
 * where it belongs. Keeps the held row's cursor — the feed does not carry one.
 */
export function replaceRow(rows, changed) {
  const at = rows.findIndex(r => r.id === changed.id)
  if (at === -1) return rows
  const next = [...rows]
  next[at] = { ...changed, cursor: rows[at].cursor }
  return next
}

// ── The Gallery ──────────────────────────────────────────────────────────────
//
// An influencer record holds its gallery as:
//
//   generationHistory   the newest entries, unbroken: the roster's few, then each
//                       page fetched for "All". New results go on top.
//   galleryExtra        entries fetched for one filter (Images or Videos) beyond
//                       where "All" has reached. Kept apart because "All" would
//                       otherwise show them after a gap of entries not loaded.
//   galleryPaging       per list ('all', 'image', 'video'): `cursor`, where its
//                       last page ended, and `done`, once the server said nothing
//                       older is left.
//
// "All" shows generationHistory. A filter shows that kind from both, which is
// unbroken too: all of that kind down to where "All" reached, and the filter's
// own pages continue from there.

export const GALLERY_FILTERS = ['all', 'image', 'video']

const COUNT_KEY = { all: 'total', image: 'images', video: 'videos' }

const kindOf = entry => ((entry?.type || 'video') === 'video' ? 'video' : 'image')

/** What the gallery shows for a filter, newest first. */
export function galleryEntries(record, filter = 'all') {
  const history = record?.generationHistory || []
  const pool = filter === 'all' ? history : [...history, ...(record?.galleryExtra || [])].filter(e => kindOf(e) === filter)
  const seen = new Set()
  const unique = pool.filter(e => (seen.has(e.id) ? false : (seen.add(e.id), true)))
  // Stable, so entries of the same millisecond keep the server's order.
  return unique.sort((a, b) => (b.date || 0) - (a.date || 0))
}

/** How many the filter has on the server, falling back to what is held. */
export function galleryTotal(record, filter = 'all') {
  const n = record?.galleryCounts?.[COUNT_KEY[filter]]
  return typeof n === 'number' ? n : galleryEntries(record, filter).length
}

/** Where "All" continues from: its last page's end, or the oldest of the roster's few. */
function allCursor(record) {
  const paging = record?.galleryPaging?.all
  if (paging?.cursor) return paging.cursor
  const history = record?.generationHistory || []
  return history.length ? history[history.length - 1].cursor || null : null
}

/** Whether there is more to fetch for this filter. */
export function galleryHasMore(record, filter = 'all') {
  const paging = record?.galleryPaging || {}
  if (paging.all?.done) return false
  if (filter !== 'all' && paging[filter]?.done) return false
  return galleryEntries(record, filter).length < galleryTotal(record, filter)
}

/**
 * The next page to ask for, or null when there is none.
 *
 * A filter continues from the older of where "All" reached and where its own
 * pages ended: nothing of its kind between the two is missing.
 *
 * @returns {{filter: string, kind: string|null, cursor: string|null, before: object|null} | null}
 *   `before` is the oldest entry held, for a server that does not know cursors yet
 */
export function galleryRequest(record, filter = 'all') {
  if (!GALLERY_FILTERS.includes(filter) || !galleryHasMore(record, filter)) return null
  const fromAll = allCursor(record)
  const cursor = filter === 'all' ? fromAll : olderCursor(fromAll, record?.galleryPaging?.[filter]?.cursor)
  const history = record?.generationHistory || []
  const before = filter === 'all' && !cursor && history.length ? history[history.length - 1] : null
  return { filter, kind: filter === 'all' ? null : filter, cursor, before }
}

const sameRequest = (a, b) => !!a && !!b && a.filter === b.filter && a.cursor === b.cursor && a.before?.id === b.before?.id

/**
 * The record with a fetched page added.
 *
 * A page answers the request it was sent for. If the record has moved on since —
 * the roster reloaded, another page landed first — the page is dropped: added
 * where the list now ends, it would leave a gap or show entries twice.
 *
 * @param {object} record
 * @param {object} request     what galleryRequest returned when the page was asked for
 * @param {{entries: object[], hasMore: boolean, nextCursor?: string|null}} page
 * @param {(entry) => boolean} [skip]  entries deleted while the page was on its way
 * @returns {{record: object, added: number, stale: boolean}}
 */
export function applyGalleryPage(record, request, page, skip = () => false) {
  if (!sameRequest(galleryRequest(record, request.filter), request)) return { record, added: 0, stale: true }

  const entries = page.entries || []
  const ended = !page.hasMore
  const cursor = page.nextCursor || entries.at(-1)?.cursor || request.cursor
  const paging = { ...(record.galleryPaging || {}), [request.filter]: { cursor, done: ended } }

  const history = record.generationHistory || []
  const extra = record.galleryExtra || []
  const held = new Set([...history, ...(request.filter === 'all' ? [] : extra)].map(e => e.id))
  const fresh = entries.filter(e => !held.has(e.id) && !skip(e) && (request.kind === null || kindOf(e) === request.kind))

  const next = request.filter === 'all'
    ? { ...record, galleryPaging: paging, generationHistory: fresh.length ? [...history, ...fresh] : history }
    : { ...record, galleryPaging: paging, galleryExtra: fresh.length ? [...extra, ...fresh] : extra }
  return { record: next, added: fresh.length, stale: false }
}

/** The record without one gallery entry, wherever it is held. */
export function withoutGalleryEntry(record, entryId) {
  return {
    ...record,
    generationHistory: (record.generationHistory || []).filter(g => g.id !== entryId),
    galleryExtra: (record.galleryExtra || []).filter(g => g.id !== entryId),
  }
}

/** The gallery entry with this id, wherever it is held. */
export function findGalleryEntry(record, entryId) {
  return (record?.generationHistory || []).find(g => g.id === entryId)
    || (record?.galleryExtra || []).find(g => g.id === entryId)
    || null
}
