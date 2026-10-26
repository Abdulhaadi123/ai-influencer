/**
 * Keyset paging for the app's lists: the gallery and the queue.
 *
 * Both are newest first, ordered by (created_at, id), and fetched a page at a
 * time from where the last page ended — never by OFFSET, which skips or repeats
 * an entry whenever one is added while someone scrolls.
 *
 * ── The cursor ───────────────────────────────────────────────────────────────
 *
 * Every row carries `cursor`: its created_at to the microsecond and its id, as
 * "2026-10-01T10:00:00.123456Z|<uuid>". To continue after a row, pass back its
 * cursor; each page also says `nextCursor` (null on the last one).
 *
 * Not the `created_at` the JSON carries: that is a JavaScript Date, so
 * milliseconds only, and rows written by one statement share a timestamp to the
 * microsecond (a job batch, a backfill). A cursor cut to the millisecond lies
 * just before all of them, and paging from it skipped every one but the first.
 *
 * The time part has a fixed width, so two cursors compare as plain strings in
 * the same order as their rows. The app relies on that.
 */

import { isUuid } from './validate.js'

/** The SQL for a row's cursor. `alias` qualifies the columns ("g." for `from generations g`). */
export function cursorSql(alias = '') {
  return `to_char(${alias}created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || ${alias}id::text`
}

const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|(.+)$/

/**
 * A cursor from a request as `{ at, id }`, or null when it is not one.
 *
 * `at` stays text, so the database gets every microsecond of it. It must still be
 * a moment that exists: JavaScript turns 31 February into 3 March where
 * PostgreSQL refuses it outright, and that refusal would be a 500.
 */
export function cursorOf(value) {
  if (typeof value !== 'string' || value.length > 80) return null
  const match = CURSOR.exec(value)
  if (!match || !isUuid(match[2])) return null
  const at = new Date(match[1])
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 19) !== match[1].slice(0, 19)) return null
  return { at: match[1], id: match[2].toLowerCase() }
}

/**
 * "Older than the cursor", for a list ordered by created_at desc, id desc, with the
 * cursor's two halves as parameters `$at` and `$id`.
 *
 * Spelled out rather than as `(created_at, id) < (…)`: the leading bound on
 * created_at alone is what lets an index on (…, created_at desc) start the scan at
 * the cursor instead of walking every newer row to reach it.
 */
export function olderThan(at, id, alias = '') {
  return `(${alias}created_at <= ${at}::timestamptz and (${alias}created_at < ${at}::timestamptz or ${alias}id < ${id}::uuid))`
}

/**
 * A page from rows fetched with one more than `limit` — the extra row answers
 * "is there more" without a second count.
 */
export function pageFrom(rows, limit) {
  const items = rows.slice(0, limit)
  const hasMore = rows.length > limit
  return { items, hasMore, nextCursor: hasMore ? items.at(-1).cursor : null }
}
