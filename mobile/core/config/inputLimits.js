/**
 * ─────────────────────────────────────────────────────────────────────────────
 * How much a person may type into each field.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Without a limit a field took whatever was pasted into it, and the text was then cut without a
 * word — by the server at its own ceiling, or by the app when it fitted a prompt to a model. So the
 * person saw one thing and the app used another. These are the limits the fields enforce while
 * typing, and each one comes from where the text actually goes:
 *
 *   Appearance    into the Nano Banana Pro image prompts. KIE takes 20,000 characters there, so it
 *                 is not KIE that limits it: it is the prompt assistant, which refuses text over
 *                 ASSIST_MAX, and a field that feeds it must not offer more to rewrite.
 *   Script/Scene  into the video prompt, which is ~1,200 characters of the app's own brief plus the
 *                 two of them, and must fit the model: Kling 3.0 (the default) takes 2,500. The app
 *                 drops its own boilerplate first, and 900 + 900 is the most that keeps both whole
 *                 for Kling (inputLimits.test.js measures it). Models that take more (5,000 and up)
 *                 have room to spare; Wan 2.5 takes only 800 and cuts the end of a long text.
 *   Scene direction  Motion Copy's text goes to KIE as it is typed, with nothing added, so it is
 *                 exactly KIE's number: Kling 3.0 and 2.6 Motion Control take 2,500.
 *   Backstory     never sent to KIE as a whole: its words pick a wardrobe and a scene, and the first
 *                 300 characters go into the character-sheet prompt.
 *   Prompt        stored on the influencer as a record of what made the image; nothing sends it.
 *   Name, Age     one line in a list; and three digits.
 *
 * The server keeps its own, larger ceilings (backend/api/influencers/index.js) for anything else that
 * calls it. What KIE accepts per model is in core/config/promptLimits.js and videoModels.js.
 */

export const INPUT_LIMITS = Object.freeze({
  /** An influencer's name: one line in a list, a heading, a sentence in the prompts. */
  name: 60,
  /** Digits only, so three covers any age and nothing else. */
  age: 3,
  /** How the influencer looks — also the text the assistant rewrites. */
  appearance: 2000,
  backstory: 2000,
  /** The full prompt an image was made from (it is generated long, and can be edited). */
  prompt: 8000,
  /** What the influencer says in a video. Shares the video prompt with the scene. */
  script: 900,
  /** What happens in a video. Shares the video prompt with the script. */
  scene: 900,
  /** Motion Copy's scene direction, sent to KIE as typed: exactly what Kling Motion Control takes. */
  sceneDirection: 2500,
})

/**
 * How many influencers one account may hold — the server's default (backend MAX_INFLUENCERS_PER_USER). The
 * server refuses the 101st on save; the create screen checks first, so nobody pays for an image to be told
 * at the end that it cannot be kept.
 */
export const MAX_INFLUENCERS = 100

/** The longest text the prompt assistant will rewrite (backend/api/prompt-assist.js, MAX_INPUT_CHARS). */
export const ASSIST_MAX = 2000

/** Digits only, at most `INPUT_LIMITS.age` of them, with no leading zeros ("007" is 7, and "0" is nothing). */
export function cleanAge(value) {
  return String(value ?? '').replace(/[^0-9]/g, '').replace(/^0+/, '').slice(0, INPUT_LIMITS.age)
}
