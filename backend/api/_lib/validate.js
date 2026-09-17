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

/** Deliberately loose: the confirmation email is the real check. */
export function emailProblem(email) {
  if (!email) return 'Enter your email address.'
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'That does not look like an email address.'
  return null
}

/** A string trimmed to `max`, or null for anything that is not a string. */
export function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null
}

export const ASSET_KINDS = ['image', 'video', 'audio']
