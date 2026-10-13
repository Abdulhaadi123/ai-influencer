/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin plumbing — the role check, the audit log, paging.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything under /api/admin goes through adminRoute. It is userRoute plus one
 * rule: the caller's role, read from the users row on this very request (see
 * sessions.js), must be `admin`. Nothing about being an admin is stored in a
 * token, so removing the role takes effect on the next call.
 *
 * ── Who is the first admin ──────────────────────────────────────────────────
 *
 * Not anyone who asks. ADMIN_EMAILS (comma separated) promotes those accounts
 * when the server starts — only if they exist and have CONFIRMED their email,
 * and only while email confirmation is required. With confirmation off, anyone
 * can sign up with any address, so trusting an address would let a stranger
 * register the owner's email first and be made an admin; in that mode the list is
 * ignored and the role is granted with SQL:
 *
 *     update users set role = 'admin' where lower(email) = 'owner@example.com';
 *
 * After that an admin can promote others from the panel. Removing an address from
 * ADMIN_EMAILS does not demote anyone; demote from the panel.
 */

import { query } from './db.js'
import { userRoute, forbidden, badRequest } from './http.js'
import { normalizeEmail } from './validate.js'

/** @param {(req, res, admin) => Promise<void>} handler */
export function adminRoute(handler, opts) {
  return userRoute(async (req, res, user) => {
    if (user.role !== 'admin') throw forbidden('This area is for administrators.', 'NOT_ADMIN')
    await handler(req, res, user)
  }, opts)
}

/**
 * Record what an admin did. Written inside the same transaction as the action
 * when a client is given, so an action cannot happen without its record.
 *
 * @param {{id: string, email: string}} admin
 * @param {string} action  e.g. 'user.suspend'
 * @param {{targetType?: string, targetId?: string, details?: object}} [what]
 * @param {{query: Function}} [client]
 */
export async function audit(admin, action, { targetType = null, targetId = null, details = {} } = {}, client = null) {
  const run = client ? (text, params) => client.query(text, params) : query
  await run(
    `insert into admin_audit_log (admin_id, admin_email, action, target_type, target_id, details)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [admin.id, admin.email, action, targetType, targetId ? String(targetId) : null, JSON.stringify(details, safeJsonStrings)],
  )
}

/**
 * JSON.stringify replacer: strings PostgreSQL will accept in a jsonb value. It
 * refuses a NUL (\u0000) and a lone surrogate (\ud800), and both can arrive in
 * something an admin typed; a rejected audit entry would fail the action it records.
 */
const safeJsonStrings = (_key, value) => (typeof value === 'string' ? wellFormed(value) : value)

/** A string with NUL removed and lone surrogates replaced by U+FFFD. */
export const wellFormed = value => value.replace(/\u0000/g, '').toWellFormed()

const MAX_PAGE = 100_000

/**
 * `?page=` (from 1) and `?pageSize=`, bounded. Offset paging is deliberate here:
 * these are admin lists read by a handful of people, where an exact page count
 * matters more than the cost of a deep offset.
 */
export function pageOf(req, { defaultSize = 50, maxSize = 100 } = {}) {
  // Capped: `?page=1e308` is a number, and an OFFSET that large is a database
  // error rather than an empty page. No list here is anywhere near this deep.
  const page = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(req.query?.page)) || 1))
  const pageSize = Math.min(maxSize, Math.max(1, Math.floor(Number(req.query?.pageSize)) || defaultSize))
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize }
}

/** A search term made safe for `ilike '%' || $n || '%' escape '\'`: `%`, `_` and `\` are literal. */
export const likeTerm = value => String(value).replace(/[\\%_]/g, '\\$&')

/**
 * PostgreSQL cannot store a NUL character in text and answers with an error, which
 * would surface as a 500 for what is plainly a bad request. Text fields refuse it.
 */
const NUL = /\u0000/

/** A trimmed string of 1..max characters, or a 400 naming the field. */
export function requiredText(value, field, max) {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s) throw badRequest(`${field} is required.`)
  if (s.length > max) throw badRequest(`${field} must be at most ${max} characters.`)
  if (NUL.test(s)) throw badRequest(`${field} contains a character that is not allowed.`)
  return s.toWellFormed()
}

/** An optional trimmed string of at most `max` characters, or null. */
export function optionalText(value, field, max) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw badRequest(`${field} must be text.`)
  const s = value.trim()
  if (s.length > max) throw badRequest(`${field} must be at most ${max} characters.`)
  if (NUL.test(s)) throw badRequest(`${field} contains a character that is not allowed.`)
  return s ? s.toWellFormed() : null
}

/**
 * A search term from the query string: a trimmed string cut to `max`, or null.
 *
 * A search box is forgiving rather than strict, so nothing here is an error. A
 * repeated parameter (`?q=a&q=b` arrives as an array), an object, an empty string
 * and a NUL character all simply mean "no usable term" and the list is unfiltered.
 */
export function queryText(value, max) {
  if (typeof value !== 'string') return null
  const s = wellFormed(value).trim().slice(0, max)
  return s || null
}

/**
 * Promote the accounts named in ADMIN_EMAILS. Called when the server starts.
 *
 * @returns {Promise<number>} how many accounts were promoted
 */
export async function promoteConfiguredAdmins({ env = process.env, warn = console.warn } = {}) {
  const emails = String(env.ADMIN_EMAILS || '').split(',').map(normalizeEmail).filter(Boolean)
  if (!emails.length) return 0

  if (env.REQUIRE_EMAIL_CONFIRMATION === 'false') {
    warn('[admin] ADMIN_EMAILS is ignored while REQUIRE_EMAIL_CONFIRMATION=false — an address is not proof of who owns it. Grant the role with SQL instead (see api/_lib/admin.js).')
    return 0
  }

  const { rowCount } = await query(
    `update users set role = 'admin'
      where lower(email) = any($1::text[]) and email_confirmed_at is not null and role <> 'admin'`,
    [emails],
  )
  return rowCount
}
