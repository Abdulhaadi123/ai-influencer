/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Selectable video and motion models.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The defaults stay what they always were — Kling 3.0 for video, Kling 3.0
 * Motion Control for motion. Everything else here is an alternative the user
 * can pick from a dropdown so other models can be tried and compared.
 *
 * Why each entry carries its own `buildInput`: the vendors do NOT share a
 * request shape. Some take `image_urls` (array), others `image_url` (single
 * string). Some take `mode`, others `resolution`, Pixverse takes `quality`.
 * Swapping only the model id would send Kling's shape to Wan and fail, so each
 * model maps the common request onto its own fields.
 *
 * Every id below was verified against the live KIE API: an unknown model is
 * rejected with 422 "model name not supported", and each of these was accepted.
 * The field lists come from each model's own docs page, not from guesswork.
 */

// ── Video ────────────────────────────────────────────────────────────────────
//
// buildInput receives:
//   { prompt, imageUrls[], duration, aspectRatio, hasVoice, audioUrl }
// and returns the `input` object for POST /api/v1/jobs/createTask.

export const VIDEO_MODELS = [
  {
    id: 'kling-3.0/video',
    label: 'Kling 3.0',
    note: 'Default. Native audio, multi-shot, up to 2 reference images.',
    supportsSound: true,
    maxImages: 2,
    buildInput: ({ prompt, imageUrls, duration, aspectRatio, hasVoice, audioUrl }) => {
      const input = {
        prompt,
        aspect_ratio: aspectRatio,
        duration,
        image_urls: imageUrls.slice(0, 2),
        mode: 'std',
        multi_shots: false,
        sound: !!(audioUrl || hasVoice),
      }
      if (audioUrl) input.audio_url = audioUrl
      return input
    },
  },
  {
    id: 'kling/v3-turbo-image-to-video',
    label: 'Kling 3.0 Turbo',
    note: 'Faster Kling 3. No audio track.',
    supportsSound: false,
    maxImages: 2,
    buildInput: ({ prompt, imageUrls, duration }) => ({
      prompt, duration, image_urls: imageUrls.slice(0, 2), resolution: '1080p',
    }),
  },
  {
    id: 'kling-2.6/image-to-video',
    label: 'Kling 2.6',
    note: 'Previous Kling generation. Supports audio.',
    supportsSound: true,
    maxImages: 2,
    buildInput: ({ prompt, imageUrls, duration, hasVoice, audioUrl }) => ({
      prompt, duration, image_urls: imageUrls.slice(0, 2), sound: !!(audioUrl || hasVoice),
    }),
  },
  {
    id: 'kling/v2-5-turbo-image-to-video-pro',
    label: 'Kling 2.5 Turbo Pro',
    note: 'Single reference image.',
    supportsSound: false,
    maxImages: 1,
    buildInput: ({ prompt, imageUrls, duration }) => ({
      prompt, duration, image_url: imageUrls[0],
    }),
  },
  {
    id: 'kling/v2-1-master-image-to-video',
    label: 'Kling 2.1 Master',
    note: 'Single reference image.',
    supportsSound: false,
    maxImages: 1,
    buildInput: ({ prompt, imageUrls, duration }) => ({
      prompt, duration, image_url: imageUrls[0],
    }),
  },
  {
    id: 'wan/2-6-image-to-video',
    label: 'Wan 2.6',
    note: 'Alibaba Wan, latest.',
    supportsSound: false,
    maxImages: 2,
    buildInput: ({ prompt, imageUrls, duration }) => ({
      prompt, duration, image_urls: imageUrls.slice(0, 2), resolution: '1080p',
    }),
  },
  {
    id: 'wan/2-5-image-to-video',
    label: 'Wan 2.5',
    note: 'Single reference image.',
    supportsSound: false,
    maxImages: 1,
    buildInput: ({ prompt, imageUrls, duration }) => ({
      prompt, duration, image_url: imageUrls[0], resolution: '1080p',
    }),
  },
  {
    id: 'hailuo/2-3-image-to-video-pro',
    label: 'Hailuo 2.3 Pro',
    note: 'MiniMax Hailuo. Single reference image.',
    supportsSound: false,
    maxImages: 1,
    buildInput: ({ prompt, imageUrls, duration }) => ({
      prompt, duration, image_url: imageUrls[0], resolution: '1080p',
    }),
  },
  {
    id: 'minimax-h3/image-to-video',
    label: 'MiniMax H3',
    note: 'Prompt-led; does not take a reference image.',
    supportsSound: false,
    maxImages: 0,
    buildInput: ({ prompt, duration }) => ({
      prompt, duration, resolution: '1080p',
    }),
  },
  {
    id: 'pixverse-v6/image-to-video',
    label: 'PixVerse v6',
    note: 'Stylised output.',
    supportsSound: false,
    maxImages: 1,
    buildInput: ({ prompt, imageUrls, duration }) => ({
      prompt, duration, image_urls: imageUrls.slice(0, 1), quality: '1080p',
    }),
  },
  {
    id: 'grok-imagine/image-to-video',
    label: 'Grok Imagine',
    note: 'xAI Grok.',
    supportsSound: false,
    maxImages: 1,
    buildInput: ({ prompt, imageUrls, duration, aspectRatio }) => ({
      prompt, duration, image_urls: imageUrls.slice(0, 1),
      aspect_ratio: aspectRatio, resolution: '1080p',
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
    buildInput: ({ prompt, imageUrl, videoUrl, mode }) => ({
      prompt,
      input_urls: [imageUrl],
      video_urls: [videoUrl],
      mode: mode === 'std' ? 'std' : 'pro',
      character_orientation: 'video',
    }),
  },
  {
    id: 'wan/2-2-animate-move',
    label: 'Wan 2.2 Animate',
    note: 'Alibaba motion transfer. Takes no prompt.',
    buildInput: ({ imageUrl, videoUrl }) => ({
      image_url: imageUrl,
      video_url: videoUrl,
      resolution: '1080p',
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
