/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The model price list — and the switch it carries.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `model_prices` is edited from the admin panel (api/admin). Two things read it:
 *
 *   • the generation proxy refuses a model whose row says `enabled = false`, so
 *     an admin can take a model out of service without a release;
 *   • the admin panel shows what each model costs a user.
 *
 * A model with no row is allowed. See migration 002.
 *
 * ── One model, several prices ────────────────────────────────────────────────
 *
 * KIE bills some models differently per `mode` (Kling Motion Control: 720p and 1080p
 * are different rates per second). The list mirrors that with an optional row per
 * mode, keyed `<model>:<mode>` — `kling-3.0/motion-control:720p`. A request is priced
 * by the row for its mode when there is one, and by the plain model row otherwise; it
 * is refused when ANY row that applies to it is switched off.
 */

import { many } from './db.js'

export const MODEL_UNAVAILABLE_MESSAGE = 'This model is not available right now. Please choose a different one.'

/** A mode is a short option word ("720p", "1080p", "pro"), never free text. */
const MODE = /^[A-Za-z0-9_.-]{1,20}$/

/** The `mode` a createTask body asks for, or null. */
export function modeOf(payload) {
  const raw = payload?.input?.mode ?? payload?.mode
  return typeof raw === 'string' && MODE.test(raw) ? raw : null
}

/**
 * The price-list keys that apply to a request, most specific first.
 *
 * @param {unknown} model  the `model` of a createTask body
 * @param {string|null} [mode]
 * @returns {string[]}  empty when `model` is not something the list can be asked about
 */
export function priceKeys(model, mode = null) {
  // A malformed body is KIE's to reject. A NUL is not even a question the database
  // can be asked: it would answer with an error, and a request must not become a
  // server error because of what its model field contains.
  if (typeof model !== 'string' || !model || model.includes('\u0000')) return []
  return mode && MODE.test(mode) ? [`${model}:${mode}`, model] : [model]
}

/**
 * @param {unknown} model  the `model` of a createTask body
 * @param {string|null} [mode]  its `mode`, if it has one
 * @returns {Promise<boolean>} false only when an admin has switched this model (or this mode of it) off
 */
export async function isModelEnabled(model, mode = null) {
  const keys = priceKeys(model, mode)
  if (!keys.length) return true
  const rows = await many('select enabled from model_prices where model = any($1::text[])', [keys])
  return rows.every(row => row.enabled)
}
