/**
 * ─────────────────────────────────────────────────────────────────────────────
 * KIE's own content filter — the `nsfw_checker` flag.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Some KIE models take `input.nsfw_checker`. Its documented default is false,
 * and "when false, no additional content filtering is applied": left alone, the
 * app has been running those models with KIE's filter OFF.
 *
 * The server sets it, exactly as it sets `callBackUrl` — the app never sends it
 * and could not turn it off. It is a second layer behind our own check
 * (service.js), not a replacement for it: most models do not have the flag at
 * all, Kling (the default video model) and nano-banana-pro among them, and
 * Veo's filter is Google's own, always on.
 *
 * ── Which models ─────────────────────────────────────────────────────────────
 *
 * Taken from KIE's per-model documentation (docs.kie.ai/market/<provider>/
 * <model>), where the model id is the page's own path. Every page named below
 * lists `nsfw_checker` in its input schema; for the models this app uses, the
 * id was also checked against the page's example request. A model not named here
 * is left untouched — adding the flag to one that rejects unknown fields would
 * fail every one of its generations — so when a new model is added to the app,
 * check its documentation page and add it here if it has the flag.
 */

export const NSFW_CHECKER_MODELS = Object.freeze(new Set([
  // ByteDance Seedance
  'bytedance/seedance-2-5',
  'bytedance/seedance-2-5-draft',
  'bytedance/seedance-2-mini',
  'bytedance/seedance-2-fast',
  'bytedance/seedance-2',
  'bytedance/seedance-1-5-pro',
  // Hailuo
  'hailuo/2-3-image-to-video-pro',
  'hailuo/2-3-image-to-video-standard',
  // Wan
  'wan/2-2-animate-move',
  'wan/2-2-animate-replace',
  'wan/2-5-image-to-video',
  'wan/2-5-text-to-video',
  'wan/2-6-image-to-video',
  'wan/2-6-text-to-video',
  'wan/2-6-video-to-video',
  'wan/2-7-image-to-video',
  'wan/2-7-text-to-video',
  // Grok Imagine
  'grok-imagine/image-to-video',
  'grok-imagine/text-to-video',
]))

/** Off only by an explicit KIE_NSFW_CHECKER=false — it costs nothing and is the safer default. */
export function nsfwCheckerEnabled(env = process.env) {
  return String(env.KIE_NSFW_CHECKER ?? 'true').toLowerCase() !== 'false'
}

/**
 * The request with KIE's filter switched on, when the model has one.
 *
 * Returns the same object untouched when the model has no flag, `input` is not an
 * object (a malformed request is KIE's to reject), or the filter is turned off.
 * Overrides whatever the client sent: a client that sent `nsfw_checker: false`
 * must not get an unfiltered model.
 *
 * @template T
 * @param {T} payload  a createTask body
 * @returns {T}
 */
export function withProviderFilters(payload, env = process.env) {
  if (!nsfwCheckerEnabled(env)) return payload
  if (!payload || typeof payload !== 'object') return payload
  if (!NSFW_CHECKER_MODELS.has(payload.model)) return payload

  const input = payload.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return payload
  return { ...payload, input: { ...input, nsfw_checker: true } }
}
