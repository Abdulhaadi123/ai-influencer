/**
 * ─────────────────────────────────────────────────────────────────────────────
 * How long a prompt KIE accepts.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Read from each model's own docs page (docs.kie.ai, 25 October 2026) and checked against the live
 * API where it costs nothing: a prompt one character over the limit is refused before any work
 * starts ("prompt cannot exceed 2500 characters" for Kling 3.0, and Motion Control and Nano Banana
 * Pro refuse theirs too). The video models carry theirs as `maxPromptChars` in videoModels.js.
 *
 * The image limit used to be 3,000 (here and in a comment that said KIE enforces it). That was
 * wrong for the model the app uses: Nano Banana Pro takes 20,000, and a real image made on
 * 25 October 2026 from a 3,081-character prompt was accepted. The cut at 2,900 silently dropped
 * the end of the character-sheet prompts (2,000 characters of template, plus the description).
 */

/** Nano Banana Pro's own limit: exactly what its docs page says, and what KIE refuses one character past. */
export const IMAGE_PROMPT_MAX = 20_000

/**
 * Video models that state no limit of their own on their docs page (Veo) get this one: what the
 * strictest common model, Kling 3.0 (2,500), accepts, with a small margin.
 */
export const DEFAULT_VIDEO_PROMPT_MAX = 2_450
