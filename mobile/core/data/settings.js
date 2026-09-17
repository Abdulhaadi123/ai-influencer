/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-influencer settings and creation params.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two small key/value tables, both keyed on (user_id, influencer_id):
 *
 *   • studio_settings — what the video studio was last set to. Convenience
 *     state; losing it costs the user a few taps.
 *   • creation_params — what an influencer was originally generated from.
 *     NOT convenience state: without it "Regenerate" cannot produce the same
 *     person, so it is the difference between a working feature and an error.
 *
 * Both are stored as jsonb rather than columns. The shapes are owned entirely
 * by the client, change with the UI, and are never queried by field — exactly
 * the case jsonb is for. Promoting them to columns would mean a migration every
 * time a control is added to the studio.
 */

import { supabase, requireUserId } from '../supabase'
import { dbError } from '../errors'
import { DEFAULT_VIDEO_MODEL } from '../config/videoModels'

/**
 * What the video studio starts as.
 *
 * Lives here rather than in the screen because both platforms read it and
 * because `loadStudioSettings` merges over it — a stored row from an older
 * version is missing whatever has been added since, and merging is what stops
 * that turning into an undefined halfway through prompt building.
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

// ── Studio settings ──────────────────────────────────────────────────────────

export async function loadStudioSettings(influencerId, defaults = DEFAULT_STUDIO_SETTINGS) {
  if (!influencerId) return { ...defaults }

  const { data, error } = await supabase
    .from('studio_settings')
    .select('settings')
    .eq('influencer_id', influencerId)
    .maybeSingle()

  if (error) {
    // Falling back to defaults keeps the studio usable; the alternative is a
    // blank screen because a remembered dropdown could not be fetched.
    console.warn('[settings] load failed:', error.message)
    return { ...defaults }
  }

  return { ...defaults, ...(data?.settings || {}) }
}

/**
 * Persist studio settings.
 *
 * Best-effort by design: losing remembered form state must never block a
 * generation the user is trying to start.
 */
export async function saveStudioSettings(influencerId, settings) {
  if (!influencerId) return
  try {
    const userId = await requireUserId()
    const { error } = await supabase
      .from('studio_settings')
      .upsert(
        { user_id: userId, influencer_id: influencerId, settings },
        { onConflict: 'user_id,influencer_id' },
      )
    if (error) console.warn('[settings] save failed:', error.message)
  } catch (e) {
    console.warn('[settings] save skipped:', e?.message ?? e)
  }
}

export async function clearStudioSettings(influencerId) {
  if (!influencerId) return
  await supabase.from('studio_settings').delete().eq('influencer_id', influencerId)
}


// ── Creation params ──────────────────────────────────────────────────────────

export async function getCreationParams(influencerId) {
  if (!influencerId) return null

  const { data, error } = await supabase
    .from('creation_params')
    .select('params')
    .eq('influencer_id', influencerId)
    .maybeSingle()

  if (error) { console.warn('[settings] creation params load:', error.message); return null }
  return data?.params ?? null
}

/**
 * Save the params an influencer was generated from.
 *
 * Unlike studio settings this one throws. Silently losing it means "Regenerate"
 * fails later with "nothing to regenerate from", at a point where the user has
 * no idea what went wrong or when.
 */
export async function saveCreationParams(influencerId, params) {
  if (!influencerId) throw new Error('saveCreationParams needs an influencer id')

  const userId = await requireUserId()
  const { error } = await supabase
    .from('creation_params')
    .upsert(
      { user_id: userId, influencer_id: influencerId, params },
      { onConflict: 'user_id,influencer_id' },
    )

  if (error) throw dbError('save how this influencer was made', error)
}
