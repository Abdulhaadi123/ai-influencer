/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Selectable video and motion models.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The defaults stay what they always were — Kling 3.0 for video, Kling 3.0
 * Motion Control for motion. Everything else is an alternative the user can
 * pick so other models can be tried and compared.
 *
 * Why each entry carries its own `buildInput`: the vendors do NOT share a
 * request shape. Some take `image_urls` (array), others `image_url` (string),
 * MiniMax takes `first_frame_url`. Some take `mode`, others `resolution`,
 * PixVerse takes `quality`. Sending Kling's shape to Wan just fails.
 *
 * Two things every entry must get right, both learned the hard way by reading
 * each model's own docs page rather than guessing:
 *
 *  1. `duration` is a STRING for most of these vendors, not a number, and each
 *     accepts only a small enum. The app offers 5/8/10/15s, so a model that
 *     only takes '5' or '10' would reject 8 outright. `durations` below lists
 *     what the model actually accepts and the request snaps to the nearest.
 *
 *  2. Resolution spelling is not consistent — Hailuo wants '1080P' with a
 *     capital P, Wan wants '1080p', MiniMax wants '768P' or '2K'.
 *
 * Every id here was verified against the live KIE API (an unknown model is
 * rejected with 422 "model name not supported"; each of these was accepted).
 */

/** Snap a requested duration to the nearest value this model accepts. */
function nearest(requested, allowed) {
  const n = Number(requested) || allowed[0]
  return allowed.reduce(
    (best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best),
    allowed[0],
  )
}

// ── Video ────────────────────────────────────────────────────────────────────
//
// buildInput receives:
//   { prompt, imageUrls[], duration, aspectRatio, hasVoice, audioUrl }
// and returns the `input` object for POST /api/v1/jobs/createTask.

export const VIDEO_MODELS = [
  {
    id: 'kling-3.0/video',
    label: 'Kling 3.0',
    note: 'Default. Sound effects, up to 2 reference images. 3–15s.',
    supportsSound: true,
    maxImages: 2,
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    buildInput: ({ prompt, imageUrls, duration, aspectRatio, hasVoice, audioUrl }) => ({
      prompt,
      aspect_ratio: aspectRatio,
      duration: String(nearest(duration, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])),
      image_urls: imageUrls.slice(0, 2),
      mode: 'std',
      multi_shots: false,
      sound: !!(audioUrl || hasVoice),
    }),
  },
  {
    id: 'kling/v3-turbo-image-to-video',
    label: 'Kling 3.0 Turbo',
    note: 'Faster Kling 3. No audio track. 3–15s.',
    supportsSound: false,
    maxImages: 2,
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    buildInput: ({ prompt, imageUrls, duration }) => ({
      prompt,
      duration: String(nearest(duration, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])),
      image_urls: imageUrls.slice(0, 2),
      resolution: '1080p',
    }),
  },
  {
    id: 'kling/v2-5-turbo-image-to-video-pro',
    label: 'Kling 2.5 Turbo Pro',
    note: 'Single reference image. 5 or 10s only.',
    supportsSound: false,
    maxImages: 1,
    durations: [5, 10],
    buildInput: ({ prompt, imageUrls, duration }) => ({
      prompt,
      duration: String(nearest(duration, [5, 10])),
      image_url: imageUrls[0],
    }),
  },
  {
    id: 'kling/v2-1-master-image-to-video',
    label: 'Kling 2.1 Master',
    note: 'Single reference image. 5 or 10s only.',
    supportsSound: false,
    maxImages: 1,
    durations: [5, 10],
    buildInput: ({ prompt, imageUrls, duration }) => ({
      prompt,
      duration: String(nearest(duration, [5, 10])),
      image_url: imageUrls[0],
    }),
  },
  {
    id: 'wan/2-6-image-to-video',
    label: 'Wan 2.6',
    // image_urls is an array but the docs cap it at one image per request.
    note: 'Alibaba Wan, latest. One reference image. 5, 10 or 15s.',
    supportsSound: false,
    maxImages: 1,
    durations: [5, 10, 15],
    buildInput: ({ prompt, imageUrls, duration }) => ({
      prompt,
      duration: String(nearest(duration, [5, 10, 15])),
      image_urls: imageUrls.slice(0, 1),
      resolution: '1080p',
    }),
  },
  {
    id: 'wan/2-5-image-to-video',
    label: 'Wan 2.5',
    note: 'Single reference image. 5 or 10s only.',
    supportsSound: false,
    maxImages: 1,
    durations: [5, 10],
    buildInput: ({ prompt, imageUrls, duration }) => ({
      prompt,
      duration: String(nearest(duration, [5, 10])),
      image_url: imageUrls[0],
      resolution: '1080p',
    }),
  },
  {
    id: 'hailuo/2-3-image-to-video-pro',
    label: 'Hailuo 2.3 Pro',
    // Capital P in the resolution is not a typo — this vendor rejects '1080p'.
    // 10s is documented as unsupported at 1080P, so 768P is used for it.
    note: 'MiniMax Hailuo. Single image. 6 or 10s only.',
    supportsSound: false,
    maxImages: 1,
    durations: [6, 10],
    buildInput: ({ prompt, imageUrls, duration }) => {
      const d = nearest(duration, [6, 10])
      return {
        prompt,
        duration: String(d),
        image_url: imageUrls[0],
        resolution: d === 10 ? '768P' : '1080P',
      }
    },
  },
  {
    id: 'minimax-h3/image-to-video',
    label: 'MiniMax H3',
    // The image field is first_frame_url, NOT image_url/image_urls, and at
    // least one of first_frame_url / last_frame_url is required.
    note: 'Uses your image as the first frame. 4–15s.',
    supportsSound: false,
    maxImages: 1,
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    buildInput: ({ prompt, imageUrls, duration }) => {
      const input = {
        prompt,
        duration: nearest(duration, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
        resolution: '768P',
      }
      if (imageUrls[0]) input.first_frame_url = imageUrls[0]
      return input
    },
  },
  {
    id: 'pixverse-v6/image-to-video',
    label: 'PixVerse v6',
    // Audio is a switch here, not a `sound` boolean like Kling.
    note: 'Stylised output. Can generate audio. Up to 2 images, 1–15s.',
    supportsSound: true,
    maxImages: 2,
    durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    buildInput: ({ prompt, imageUrls, duration, hasVoice, audioUrl }) => ({
      prompt,
      duration: nearest(duration, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
      image_urls: imageUrls.slice(0, 2),
      quality: '1080p',
      generate_audio_switch: !!(audioUrl || hasVoice),
    }),
  },
  {
    id: 'grok-imagine/image-to-video',
    label: 'Grok Imagine',
    // Minimum is 6s — a 5s request would be rejected, so it snaps up.
    // Only one image is allowed at 1080p.
    note: 'xAI Grok. Single image at 1080p. 6s minimum.',
    supportsSound: false,
    maxImages: 1,
    durations: [6, 8, 10, 15],
    buildInput: ({ prompt, imageUrls, duration, aspectRatio }) => ({
      prompt,
      duration: String(nearest(duration, [6, 8, 10, 15])),
      image_urls: imageUrls.slice(0, 1),
      aspect_ratio: aspectRatio,
      resolution: '1080p',
    }),
  },
]

// ── Motion copy ──────────────────────────────────────────────────────────────
//
// buildInput receives: { prompt, imageUrl, videoUrl, mode }

export const MOTION_MODELS = [
  {
    id: 'kling-3.0/motion-control',
    label: 'Kling 3.0 Motion Control',
    note: 'Default. Best identity retention.',
    buildInput: ({ prompt, imageUrl, videoUrl, mode }) => ({
      prompt,
      input_urls: [imageUrl],
      video_urls: [videoUrl],
      mode: mode === 'std' ? 'std' : 'pro',
      character_orientation: 'video',
      background_source: 'input_video',
    }),
  },
  {
    id: 'kling-2.6/motion-control',
    label: 'Kling 2.6 Motion Control',
    note: 'Previous generation.',
    // This generation names its modes by resolution, not std/pro. Confirmed
    // against the live API: mode:'std' is rejected outright with "mode is not
    // within the range of allowed options"; '720p' is accepted.
    buildInput: ({ prompt, imageUrl, videoUrl, mode }) => ({
      prompt,
      input_urls: [imageUrl],
      video_urls: [videoUrl],
      mode: mode === 'std' ? '720p' : '1080p',
      character_orientation: 'video',
    }),
  },
  {
    id: 'wan/2-2-animate-move',
    label: 'Wan 2.2 Animate',
    note: 'Alibaba motion transfer. Takes no prompt. Caps at 720p.',
    // Tops out at 720p — 480p/580p/720p are the only options. Confirmed
    // against the live API: '1080p' is rejected as out of range.
    buildInput: ({ imageUrl, videoUrl }) => ({
      image_url: imageUrl,
      video_url: videoUrl,
      resolution: '720p',
    }),
  },
]

// ── Lookup helpers ───────────────────────────────────────────────────────────

export const DEFAULT_VIDEO_MODEL = VIDEO_MODELS[0].id
export const DEFAULT_MOTION_MODEL = MOTION_MODELS[0].id

/** Falls back to the default when an id is unknown, so a stale saved
 *  selection can never leave the studio unable to generate. */
export function getVideoModel(id) {
  return VIDEO_MODELS.find(m => m.id === id) || VIDEO_MODELS[0]
}

export function getMotionModel(id) {
  return MOTION_MODELS.find(m => m.id === id) || MOTION_MODELS[0]
}
