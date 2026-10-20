/**
 * Input checks shared by the endpoints.
 *
 * Ids are checked before they reach SQL: Postgres rejects a malformed uuid with
 * an error, and letting that surface as a 500 would blame the server for a bad
 * request.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value)
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * Deliberately loose: the confirmation email is the real check. The one thing it is strict about is
 * control characters (a NUL, a line break inside the address): an address is later written into mail
 * headers and database rows, and nothing legitimate contains one.
 */
export function emailProblem(email) {
  if (!email) return 'Enter your email address.'
  if (email.length > 254 || /[\u0000-\u001f\u007f]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'That does not look like an email address.'
  return null
}

/**
 * A person's display name as it is stored: control characters (line breaks included) become spaces,
 * runs of whitespace collapse, at most `max` characters, and null when nothing is left. It is shown in
 * lists and panels as one line, and is never trusted as anything but text.
 */
export function displayNameOf(value, max = 80) {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim()
  return cleaned ? cleaned.toWellFormed() : null
}

/**
 * A whole number from a request, kept inside [min, max]. Anything that is not a number, and 0 (no list is ever
 * asked to hold none), is `fallback`. Only text and numbers are converted: Number() throws on an object whose
 * toString is not a function, and a fraction left in a SQL LIMIT is an error from the database.
 */
export function wholeNumber(value, { min, max, fallback }) {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
  if (!n) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

/**
 * A moment from a request as a Date, or null when it is not one. Parsed here and passed to the database as
 * a Date, never as the text that arrived: JavaScript reads a good many things as dates (a lone number, half a
 * sentence) that PostgreSQL does not, and the difference was a 500.
 */
export function momentOf(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}

/** A string trimmed to `max`, or null for anything that is not a string. */
export function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null
}

export const ASSET_KINDS = ['image', 'video', 'audio']
