/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Central configuration for the AI generation stack.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every "which model" decision lives HERE, so switching a model is a single,
 * reviewable edit — never a hunt across the codebase. UI and feature code must
 * NEVER hard-code a model id; they call the generation functions, which read
 * their ids from this file.
 *
 * Provider: KIE (api.kie.ai) — a single server-side key holds all models, which
 * keeps the app React-Native-safe (no per-user OAuth). To add another provider,
 * add a file under services/generation/providers with the same exports.
 *
 * Target model stack (product decision):
 *   • Influencer image             → Nano Banana Pro
 *   • Brand promo (talk + product)  → Kling 3.0 with sound on ("Omni")
 *   • Motion copy                  → Kling 3.0 Motion Control
 *
 * All three ids below were verified against the live KIE API: an unknown model
 * is rejected with 422 "model name not supported", while each id here is
 * accepted (only its input is validated). Re-run that check if you change one.
 *
 * NOTE on "Omni": there is no separate `kling-3.0/omni` model — KIE rejects
 * that id. Omni is `kling-3.0/video` with `sound: true`, which is what
 * generateVideo sends whenever the user supplies audio or picks a voice.
 */

// ── KIE model ids ────────────────────────────────────────────────────────────
export const IMAGE_MODEL_ID     = 'nano-banana-pro'          // Nano Banana Pro (image-to-image)
export const VIDEO_MODEL_KLING  = 'kling-3.0/video'          // Kling 3.0 — set input.sound for Omni
export const VIDEO_MODEL_VEO    = 'veo3_fast'                // alternate video path (unused by default)
export const MOTION_MODEL_KIE   = 'kling-3.0/motion-control' // Kling 3.0 Motion Control
