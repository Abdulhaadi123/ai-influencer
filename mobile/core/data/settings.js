/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-influencer settings and creation params.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   • studio settings — what the video studio was last set to. Convenience
 *     state; losing it costs the user a few taps.
 *   • creation params — what an influencer was originally generated from.
 *     Saved with the influencer (data/influencers.js create), read here so
 *     "Regenerate" produces the same person.
 *
 * Both are JSON documents whose shape belongs to the app.
 */

import { apiFetch } from '../api/client'
import { DEFAULT_VIDEO_MODEL } from '../config/videoModels'

/**
 * What the video studio starts as. `loadStudioSettings` merges stored values
 * over this, so a document saved by an older version never leaves a setting
 * undefined halfway through building a prompt.
 */
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
  videoModel: DEFAULT_VIDEO_MODEL,
}

export async function loadStudioSettings(influencerId, defaults = DEFAULT_STUDIO_SETTINGS) {
  if (!influencerId) return { ...defaults }
  try {
    const { settings } = await apiFetch(`/api/studio-settings?influencerId=${encodeURIComponent(influencerId)}`)
    return { ...defaults, ...(settings || {}) }
  } catch (e) {
    // Defaults keep the studio usable; the alternative is a blank screen
    // because a remembered dropdown could not be fetched.
    console.warn('[settings] load failed:', e?.message ?? e)
    return { ...defaults }
  }
}

/**
 * Persist studio settings. Best-effort by design: losing remembered form state
 * must never block a generation the user is trying to start.
 */
export async function saveStudioSettings(influencerId, settings) {
  if (!influencerId) return
  try {
    await apiFetch('/api/studio-settings', { method: 'POST', body: { influencerId, settings } })
  } catch (e) {
    console.warn('[settings] save failed:', e?.message ?? e)
  }
}

/** What an influencer was generated from, or null. */
export async function getCreationParams(influencerId) {
  if (!influencerId) return null
  try {
    const { params } = await apiFetch(`/api/creation-params?influencerId=${encodeURIComponent(influencerId)}`)
    return params ?? null
  } catch (e) {
    console.warn('[settings] creation params load failed:', e?.message ?? e)
    return null
  }
}
