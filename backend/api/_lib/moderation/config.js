/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Moderation settings, read from the environment.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Read on every call rather than once at import: it costs nothing, and tests (and
 * a restart-free config change in a dev shell) see the current values.
 *
 *   MODERATION_ENABLED          true | false. Unset means "on when an OpenAI key
 *                               is configured" — so shipping this code to a
 *                               server with no key changes nothing.
 *   MODERATION_FAIL_MODE        closed (default) | open — what happens to a
 *                               request when the checker cannot be reached. See
 *                               the note below.
 *   MODERATION_THRESHOLDS       JSON overrides for policy.js
 *   MODERATION_MODEL            default omni-moderation-latest
 *   MODERATION_STRIKE_LIMIT     refusals (distinct minutes) before suspension; 5
 *   MODERATION_STRIKE_WINDOW_DAYS  how far back strikes count; 30
 *   MODERATION_SUSPEND_ON_MINORS   suspend at once on sexual/minors; default true
 *   MODERATION_VIDEO_FRAMES     frames sampled from a video; 4
 *   FFMPEG_PATH / FFPROBE_PATH  default: found on PATH
 *   OPENAI_API_KEY / OPENAI_BASE_URL   the checker (OPENAI_BASE_URL is only for tests)
 *
 * ── Why "closed" ─────────────────────────────────────────────────────────────
 *
 * Every generation costs real money and the app is responsible for what it makes.
 * When the checker is down, refusing a request ("try again shortly") costs the
 * user a minute; allowing it unchecked costs a policy violation nobody can undo.
 * This applies to requests BEFORE anything is paid for. A result that has already
 * been generated and paid for is never withheld because the checker is down — it
 * is stored, and checked again later (see moderateAsset / the worker).
 */

import { parseThresholdOverrides, DEFAULT_RULES } from './policy.js'

const MB = 1024 * 1024

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function moderationConfig(env = process.env) {
  const apiKey = env.OPENAI_API_KEY || ''
  const flag = String(env.MODERATION_ENABLED ?? '').toLowerCase()
  const enabled = flag === 'true' ? true : flag === 'false' ? false : Boolean(apiKey)

  let rules = DEFAULT_RULES
  let problem = null
  try {
    rules = parseThresholdOverrides(env.MODERATION_THRESHOLDS)
  } catch (e) {
    // A request path must not fail over a typo in an env var; startup reports it.
    problem = e.message
  }

  return Object.freeze({
    enabled,
    configured: Boolean(apiKey),
    apiKey,
    baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: env.MODERATION_MODEL || 'omni-moderation-latest',
    failClosed: String(env.MODERATION_FAIL_MODE ?? 'closed').toLowerCase() !== 'open',
    rules,
    thresholdsProblem: problem,
    strikeLimit: positiveInt(env.MODERATION_STRIKE_LIMIT, 5),
    strikeWindowDays: positiveInt(env.MODERATION_STRIKE_WINDOW_DAYS, 30),
    suspendOnMinors: String(env.MODERATION_SUSPEND_ON_MINORS ?? 'true').toLowerCase() !== 'false',
    videoFrames: Math.min(8, positiveInt(env.MODERATION_VIDEO_FRAMES, 4)),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    // OpenAI accepts images up to 20 MB; the file is sent base64-encoded, which
    // adds a third, so the file itself is held to 15.
    maxImageBytes: 15 * MB,
    // The longest a small request waits on the checker (openai.js adds a few
    // seconds per megabyte for a large image). Generation requests wait on it
    // too, so it is short; the retry in openai.js covers one blip.
    timeoutMs: positiveInt(env.MODERATION_TIMEOUT_MS, 15_000),
  })
}

/**
 * What the server says about moderation when it starts. Returns lines to log;
 * `error` lines mean it will not do what the operator expects.
 *
 * @returns {{level: 'info'|'warn'|'error', text: string}[]}
 */
export function describeModeration(env = process.env) {
  const cfg = moderationConfig(env)
  const lines = []

  if (cfg.thresholdsProblem) {
    lines.push({ level: 'error', text: `${cfg.thresholdsProblem} The default thresholds are in use.` })
  }
  if (!cfg.enabled) {
    lines.push({
      level: 'warn',
      text: cfg.configured
        ? 'MODERATION_ENABLED=false — content is NOT being checked.'
        : 'OPENAI_API_KEY is not set — content moderation is OFF. Prompts and images are not checked.',
    })
    return lines
  }
  if (!cfg.configured) {
    lines.push({
      level: 'error',
      text: cfg.failClosed
        ? 'MODERATION_ENABLED=true but OPENAI_API_KEY is not set — every generation will be refused.'
        : 'MODERATION_ENABLED=true but OPENAI_API_KEY is not set — content is NOT being checked (fail-open).',
    })
  } else {
    lines.push({ level: 'info', text: `content moderation on (${cfg.model}, fail-${cfg.failClosed ? 'closed' : 'open'}).` })
  }
  return lines
}
