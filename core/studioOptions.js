/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The choices the video studio offers.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Plain data driving the studio's controls. Kept in core so the web and mobile
 * studios can never offer different options — and so the values stay in step
 * with prompts/videoPrompt.js, which keys its ENVIRONMENT, COLOR LOGIC and
 * MOOD sections off exactly these strings.
 */

/** Location chips → the phrase dropped into the ENVIRONMENT section. */
export const ENV_PRESETS = {
  'Bedroom':      'in the bedroom',
  'Bathroom':     'in the bathroom',
  'Kitchen':      'in the kitchen',
  'Coffee Shop':  'in a coffee shop',
  'Mall / Store': 'in a mall or store',
  'Street':       'on the street outside',
  'Gym':          'in the gym',
  'Studio':       'in a studio',
}

export const ENV_KEYS = Object.keys(ENV_PRESETS)

/**
 * Mood presets. videoPrompt.js maps each of these to a paragraph of delivery
 * direction, so the strings must match its moodMap keys exactly.
 */
export const VIBES = [
  'Natural', 'Energetic', 'Luxury', 'Playful', 'Tutorial', 'Dramatic', 'Cozy', 'Confident',
]

/**
 * Camera styles. videoPrompt.js has styles for all five; the web studio's
 * chip row shows the three most used, and mobile shows the same three so the
 * two stay consistent.
 */
export const CAMERAS = ['Handheld', 'Tripod', 'Talking Head']

/** Every camera videoPrompt.js knows how to render. */
export const ALL_CAMERAS = ['Handheld', 'Tripod', 'Talking Head', 'Wide', 'Overhead']

/** Time of day → appended to the environment line as a lighting cue. */
export const TIMES_OF_DAY = ['morning', 'afternoon', 'golden hour', 'night']

/** Clip lengths offered by the studio. */
export const DURATIONS = [5, 8, 10, 15]
