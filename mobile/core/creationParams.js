/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Creation params — what an influencer was originally generated from.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Saved by the create wizard and read back when regenerating an influencer's
 * main image, so regeneration reuses the same reference image, description and
 * copy-attributes as the original.
 *
 * Written once by the wizard and read by the studio, on BOTH platforms, so it
 * lives in core and goes through the storage abstraction rather than touching
 * localStorage directly.
 *
 * NOTE: the model is deliberately NOT stored here. Which model runs is decided
 * by config/generation.js at call time — persisting it would pin influencers to
 * whatever model happened to be current when they were created.
 */

import * as storage from './platform/storage'

const CREATION_PARAMS_KEY = 'hf_creation_params'

function readAll() {
  try {
    return JSON.parse(storage.getItem(CREATION_PARAMS_KEY) || '{}')
  } catch {
    return {}
  }
}

export function getCreationParams(influencerId) {
  return readAll()[influencerId] || null
}

/**
 * Persist the params for one influencer.
 *
 * Storage is best-effort: these params only power regeneration, so hitting a
 * quota must not fail the creation the user just completed.
 */
export function saveCreationParams(influencerId, params) {
  try {
    const all = readAll()
    all[influencerId] = params
    storage.setItem(CREATION_PARAMS_KEY, JSON.stringify(all))
  } catch (e) {
    console.warn('saveCreationParams failed (quota?), skipping:', e?.message ?? e)
  }
}
