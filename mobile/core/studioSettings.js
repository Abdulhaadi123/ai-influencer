/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Video studio settings, persisted per influencer.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The studio remembers what you last set up for each influencer — script,
 * camera, duration, voice and so on — so reopening it does not start blank.
 *
 * Both platforms use this module, which means:
 *   • the stored SHAPE is identical, and
 *   • the writes go through the storage abstraction rather than localStorage,
 *     which is what makes it work on native at all.
 *
 * The key and field names match what the web studio already wrote, so existing
 * saved settings keep loading after this change.
 */

import * as storage from './platform/storage'
import { DEFAULT_VIDEO_MODEL } from './config/videoModels'

const KEY_PREFIX = 'cs_settings_'

/** Defaults mirror the web studio's useState initialisers. */
export const DEFAULT_STUDIO_SETTINGS = {
  vibe: '',
  duration: 15,
  aspect: '9:16',
  outputs: 1,
  shotMode: 'oner',
  camera: 'Handheld',
  envKey: '',
  envCustom: '',
  voicePreset: '',
  voiceCustom: '',
  dialogue: '',
  videoTimeOfDay: 'afternoon',
  productWorn: false,
  // Which video model to generate with; the default stays Kling 3.0.
  videoModel: DEFAULT_VIDEO_MODEL,
}

/**
 * Read the saved settings for one influencer, merged over the defaults so a
 * caller always gets every field.
 */
export function loadStudioSettings(influencerId) {
  try {
    const raw = storage.getItem(KEY_PREFIX + influencerId)
    if (!raw) return { ...DEFAULT_STUDIO_SETTINGS }
    return { ...DEFAULT_STUDIO_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_STUDIO_SETTINGS }
  }
}

/**
 * Persist settings for one influencer.
 *
 * Best-effort: losing remembered form state must never break generation, so a
 * quota failure is warned about rather than thrown.
 */
export function saveStudioSettings(influencerId, settings) {
  try {
    storage.setItem(KEY_PREFIX + influencerId, JSON.stringify(settings))
  } catch (e) {
    console.warn('saveStudioSettings failed (quota?), skipping:', e?.message ?? e)
  }
}

export function clearStudioSettings(influencerId) {
  try { storage.removeItem(KEY_PREFIX + influencerId) } catch {}
}
