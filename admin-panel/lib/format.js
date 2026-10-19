/*
 * Turning numbers, times and codes into words — pure functions, no DOM.
 *
 * The panel is in English and formats for en-US everywhere, so two admins looking
 * at the same screen read the same thing. Every function that depends on "now" or
 * on a time zone takes it as an argument, which is also what lets the tests pin it.
 */

const LOCALE = 'en-US'

const number = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 })
const compact = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 })

/**
 * A number from a number or a numeric string, and NaN from anything else. Plain
 * Number() would turn [] into 0 and true into 1, and "no value" must never read as a figure.
 */
function numeric(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return Number.NaN
}

/** 1234.5 → "1,234.5"; nothing known → "—". */
export function formatNumber(value) {
  const n = numeric(value)
  return Number.isFinite(n) ? number.format(n) : '—'
}

/** 12400 → "12.4K". For tiles where the exact figure is in the tooltip. */
export function formatCompact(value) {
  const n = numeric(value)
  return Number.isFinite(n) ? compact.format(n) : '—'
}

/** 4_200_000 → "4.0 MB". */
export function formatBytes(value) {
  const n = numeric(value)
  if (!Number.isFinite(n) || n < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

/** 0.4 → "40%". `of` is the whole; a zero whole is "—", not NaN. */
export function formatPercent(part, of) {
  const p = numeric(part)
  const w = numeric(of)
  if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return '—'
  return `${Math.round((p / w) * 100)}%`
}

/**
 * A date as people read it: "Oct 11, 2026, 2:43 PM". `timeZone` defaults to the
 * viewer's own; the tests pass 'UTC'.
 */
export function formatDate(value, { timeZone, withTime = true } = {}) {
  const date = toDate(value)
  if (!date) return '—'
  return new Intl.DateTimeFormat(LOCALE, {
    year: 'numeric', month: 'short', day: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
    ...(timeZone ? { timeZone } : {}),
  }).format(date)
}

/**
 * "just now", "5 min ago", "3 h ago", "2 d ago", then the date. A time in the
 * future (a clock a little ahead of the server's) reads "in 5 min" rather than
 * a negative number.
 */
export function relativeTime(value, { now = Date.now(), timeZone } = {}) {
  const date = toDate(value)
  if (!date) return '—'
  const seconds = Math.round((now - date.getTime()) / 1000)
  const abs = Math.abs(seconds)
  const future = seconds < 0

  const span = (n, unit) => (future ? `in ${n} ${unit}` : `${n} ${unit} ago`)
  if (abs < 45) return future && abs >= 10 ? 'in a few seconds' : 'just now'
  if (abs < 3600) return span(Math.max(1, Math.round(abs / 60)), 'min')
  if (abs < 86_400) return span(Math.round(abs / 3600), 'h')
  if (abs < 7 * 86_400) return span(Math.round(abs / 86_400), 'd')
  return formatDate(date, { timeZone, withTime: false })
}

function toDate(value) {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "mia@test.example" → "MI"; "Mia Brown" → "MB"; nothing → "?". */
export function initials(value) {
  const text = String(value ?? '').trim()
  if (!text) return '?'
  const words = text.split(/[\s@._-]+/).filter(Boolean)
  // By code point, not UTF-16 unit: an emoji is one letter, and half of one is not.
  const first = word => Array.from(word)[0]
  const letters = words.length > 1 ? first(words[0]) + first(words[1]) : Array.from(text).slice(0, 2).join('')
  return letters.toUpperCase()
}

/** Cut to `max` characters with an ellipsis; never splits a surrogate pair. */
export function truncate(value, max) {
  const chars = Array.from(String(value ?? ''))
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : chars.join('')
}

/** plural(1, 'job') → "1 job"; plural(2, 'job') → "2 jobs"; plural(2, 'person', 'people'). */
export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${formatNumber(count)} ${numeric(count) === 1 ? singular : pluralForm}`
}

// ── What the server's codes mean ─────────────────────────────────────────────

export const SOURCE_LABELS = Object.freeze({
  prompt: 'Prompt',
  prompt_assist: 'Suggestion',
  image: 'Uploaded image',
  video: 'Uploaded video',
  output: 'Generated result',
  report: 'User report',
  provider: 'Refused by generator',
})

export const ACTION_LABELS = Object.freeze({ blocked: 'Refused', review: 'Held for review' })

export const CATEGORY_LABELS = Object.freeze({
  'sexual': 'Sexual content',
  'sexual/minors': 'Sexual content involving minors',
  'harassment': 'Harassment',
  'harassment/threatening': 'Threatening harassment',
  'hate': 'Hate',
  'hate/threatening': 'Threatening hate',
  'illicit': 'Illicit activity',
  'illicit/violent': 'Violent illicit activity',
  'self-harm': 'Self-harm',
  'self-harm/intent': 'Self-harm intent',
  'self-harm/instructions': 'Self-harm instructions',
  'violence': 'Violence',
  'violence/graphic': 'Graphic violence',
  'unverifiable': 'Could not be checked',
  'flagged-by-generator': 'Flagged as sensitive by the generator',
  'other': 'Something else',
})

export const STATE_LABELS = Object.freeze({
  waiting: 'Waiting', queuing: 'Queued', generating: 'Generating', success: 'Succeeded', fail: 'Failed',
})

export const UNIT_LABELS = Object.freeze({ per_second: 'second', per_video: 'video', per_image: 'image' })

/** What a row of the credit ledger is called on screen. */
export const CREDIT_KIND_LABELS = Object.freeze({
  purchase: 'Bought a pack',
  spend: 'Used for a generation',
  refund: 'Given back (generation failed)',
  grant: 'Given by an admin',
  adjust: 'Corrected by an admin',
  clawback: 'Taken back (purchase refunded)',
})

/** The kind of a store delivery's outcome, in words — see api/revenuecat-webhook.js. */
export const OUTCOME_LABELS = Object.freeze({
  credited: 'Credits added',
  clawed_back: 'Credits taken back',
  duplicate: 'Duplicate, ignored',
  ignored: 'Not ours to act on',
  unmatched: 'No matching account',
  sandbox_off: 'Test purchase refused',
  test: 'Test event',
})

const label = (table, key) => (Object.hasOwn(table, key) ? table[key] : String(key ?? '—'))
export const sourceLabel = key => label(SOURCE_LABELS, key)
export const actionLabel = key => label(ACTION_LABELS, key)
export const categoryLabel = key => label(CATEGORY_LABELS, key)
export const stateLabel = key => label(STATE_LABELS, key)
export const creditKindLabel = key => label(CREDIT_KIND_LABELS, key)

/** Store events that mean a subscription was paid for (we sell none). */
const SUBSCRIPTION_EVENTS = new Set(['INITIAL_PURCHASE', 'RENEWAL'])

/**
 * A store delivery's outcome. An `ignored` purchase is a problem, not a shrug, so it says what went wrong:
 * a product we do not sell, or a subscription (we sell none), which was paid for and delivered nothing.
 */
export function outcomeLabel(outcome, problem = false, type = null) {
  if (outcome === 'ignored' && problem) return SUBSCRIPTION_EVENTS.has(type) ? 'Subscription, not supported' : 'Product not recognised'
  return label(OUTCOME_LABELS, outcome)
}

/** RevenueCat's environment: SANDBOX is a test purchase, PRODUCTION is real money. */
export function environmentLabel(environment) {
  const e = String(environment ?? '').toUpperCase()
  return e === 'SANDBOX' ? 'Test' : e === 'PRODUCTION' ? 'Live' : (e ? e.charAt(0) + e.slice(1).toLowerCase() : '—')
}

/** +500 / −18 / 0 for a change of credits; the minus is a real minus sign, which lines up with the plus. */
export function signedNumber(value) {
  const n = numeric(value)
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  return `${n > 0 ? '+' : '−'}${number.format(Math.abs(n))}`
}

/**
 * A model as a person reads it: the name an admin gave it on the Pricing page, or else its id made
 * tidier ("nano-banana-pro" → "Nano Banana Pro", "kling-3.0/video" → "Kling 3.0 · video").
 * The id itself is always kept next to it, so nothing is hidden.
 */
export function modelName(id, labels = null) {
  const key = String(id ?? '')
  if (!key) return '—'
  if (labels && Object.hasOwn(labels, key) && labels[key]) return labels[key]
  // A price kept per mode is named "<model>:<mode>"; it reads as the model with its mode in brackets.
  const colon = key.indexOf(':')
  if (colon > 0) return `${modelName(key.slice(0, colon), labels)} (${key.slice(colon + 1)})`
  const [model, ...rest] = key.split('/')
  const words = value => value.split(/[-_]/).filter(Boolean).map(w => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ')
  return rest.length ? `${words(model)} · ${rest.join('/').replace(/[-_]/g, ' ')}` : words(model)
}

/** The admin audit log's action codes, in words: "user.set-role" → "Changed a role". */
const AUDIT_LABELS = {
  'user.suspend': 'Suspended an account',
  'user.unsuspend': 'Restored an account',
  'user.set-role': 'Changed a role',
  'user.delete': 'Deleted an account',
  'moderation.dismiss': 'Dismissed a moderation item',
  'moderation.confirm': 'Confirmed a moderation item',
  'moderation.view-media': 'Viewed a flagged file',
  'price.upsert': 'Set a model price',
  'price.delete': 'Removed a model price',
  'billing.grant': 'Changed an account’s credits',
}
export const auditLabel = key => label(AUDIT_LABELS, key)

// ── Chart data ───────────────────────────────────────────────────────────────

/**
 * The usage rows (one per day and model) as one dense series, a point per day for
 * the last `days` days ending today, with zeros where nothing ran. Days are UTC,
 * which is how the server groups them.
 *
 * @param {Array<{day: string, credits: number, succeeded: number, failed: number}>} rows
 * @param {number} days
 * @param {number} [now]
 * @returns {Array<{day: string, credits: number, succeeded: number, failed: number}>} oldest first
 */
export function dailySeries(rows, days, now = Date.now()) {
  const byDay = new Map()
  for (const row of rows || []) {
    const day = String(row.day).slice(0, 10)
    const point = byDay.get(day) || { credits: 0, succeeded: 0, failed: 0 }
    point.credits += Number(row.credits) || 0
    point.succeeded += Number(row.succeeded) || 0
    point.failed += Number(row.failed) || 0
    byDay.set(day, point)
  }

  const series = []
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate())
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(today - i * 86_400_000).toISOString().slice(0, 10)
    series.push({ day, ...(byDay.get(day) || { credits: 0, succeeded: 0, failed: 0 }) })
  }
  return series
}

/**
 * The credits-per-day rows as one dense series, like dailySeries: a point for each of the last `days`
 * days ending today (UTC), zeros where nothing was bought or spent.
 *
 * @param {Array<{day: string, purchased: number, spent: number}>} rows
 * @returns {Array<{day: string, purchased: number, spent: number}>} oldest first
 */
export function creditSeries(rows, days, now = Date.now()) {
  const byDay = new Map((rows || []).map(r => [String(r.day).slice(0, 10), r]))
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate())
  return Array.from({ length: days }, (_, k) => {
    const day = new Date(today - (days - 1 - k) * 86_400_000).toISOString().slice(0, 10)
    const row = byDay.get(day)
    return { day, purchased: Number(row?.purchased) || 0, spent: Number(row?.spent) || 0 }
  })
}

/** The usage rows folded to one entry per model, biggest spend first. */
export function byModel(rows) {
  const models = new Map()
  for (const row of rows || []) {
    const entry = models.get(row.model) || { model: row.model, credits: 0, succeeded: 0, failed: 0 }
    entry.credits += Number(row.credits) || 0
    entry.succeeded += Number(row.succeeded) || 0
    entry.failed += Number(row.failed) || 0
    models.set(row.model, entry)
  }
  return [...models.values()].sort((a, b) => b.credits - a.credits || (b.succeeded + b.failed) - (a.succeeded + a.failed) || a.model.localeCompare(b.model))
}

/** A round number at or above `value`, so a chart's top gridline is not 137.4. */
export function niceMax(value) {
  const v = Number(value)
  if (!Number.isFinite(v) || v <= 0) return 1
  const exponent = Math.floor(Math.log10(v))
  const base = 10 ** exponent
  for (const step of [1, 2, 2.5, 5]) if (v <= step * base) return step * base
  return 10 * base
}
