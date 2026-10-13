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
 * Charging users is a separate piece of work (it needs the payment provider);
 * until it exists these prices are recorded, not applied.
 *
 * A model with no row is allowed. See migration 002.
 */

import { one } from './db.js'

export const MODEL_UNAVAILABLE_MESSAGE = 'This model is not available right now. Please choose a different one.'

/**
 * @param {unknown} model  the `model` of a createTask body
 * @returns {Promise<boolean>} false only when an admin has switched this model off
 */
export async function isModelEnabled(model) {
  // A malformed body is KIE's to reject. A NUL is not even a question the database
  // can be asked: it would answer with an error, and a request must not become a
  // server error because of what its model field contains.
  if (typeof model !== 'string' || !model || model.includes('\u0000')) return true
  const row = await one('select enabled from model_prices where model = $1', [model])
  return row ? row.enabled : true
}
