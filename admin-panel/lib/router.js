/*
 * The address bar as the panel's state.
 *
 * Where you are, and what you filtered by, lives in the URL hash:
 *
 *   #/users?q=mia&status=suspended&sort=jobs&dir=desc&page=2
 *   #/users/<account id>                a person's detail panel
 *   #/moderation/<event id>
 *
 * so Back and Forward work, a link can be sent to a colleague, and a refresh lands
 * in the same place. Only these views exist; anything else is the overview.
 *
 * Pure functions, no DOM: the browser's own `location.hash` is passed in.
 */

export const VIEWS = Object.freeze(['overview', 'users', 'jobs', 'moderation', 'prices', 'audit', 'settings'])

/** Views whose second segment names a record. */
const WITH_ID = new Set(['users', 'moderation'])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * @param {string} hash  e.g. "#/users/abc?q=mia"
 * @returns {{view: string, id: string|null, query: Record<string, string>}}
 */
export function parseRoute(hash) {
  const text = String(hash ?? '').replace(/^#\/?/, '')
  const [path, search = ''] = splitOnce(text, '?')
  const [first, second] = path.split('/').filter(Boolean).map(safeDecode)

  const view = VIEWS.includes(first) ? first : 'overview'
  // An id that is not a UUID is no id: the list is shown rather than an error.
  const id = WITH_ID.has(view) && second && UUID.test(second) ? second.toLowerCase() : null

  const query = {}
  for (const [key, value] of new URLSearchParams(search)) {
    // Own-property only and never `__proto__`: the query becomes API parameters.
    if (key && key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && !(key in query)) query[key] = value
  }
  return { view, id, query }
}

/**
 * @param {string} view
 * @param {{id?: string|null, query?: Record<string, string|number|null|undefined>}} [opts]
 * @returns {string} a hash, e.g. "#/users?q=mia"
 */
export function buildRoute(view, { id = null, query = {} } = {}) {
  const safeView = VIEWS.includes(view) ? view : 'overview'
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue
    params.set(key, String(value))
  }
  const search = params.toString()
  const path = id && WITH_ID.has(safeView) ? `${safeView}/${encodeURIComponent(id)}` : safeView
  return `#/${path}${search ? `?${search}` : ''}`
}

/** The same route with some query values changed (null removes one). */
export function withQuery(route, changes) {
  const query = { ...route.query }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === '') delete query[key]
    else query[key] = String(value)
  }
  return buildRoute(route.view, { id: route.id, query })
}

/** A positive integer from a query value, or `fallback`. */
export function intParam(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** One of `allowed`, or `fallback`. */
export function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

function splitOnce(text, separator) {
  const at = text.indexOf(separator)
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)]
}

function safeDecode(value) {
  try { return decodeURIComponent(value) } catch { return value }
}
