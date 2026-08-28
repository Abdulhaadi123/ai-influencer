/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Identity reference sheets — character sheet, close-up, feature sheet.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every influencer record has always carried `characterSheetImage`,
 * `closeUpImage1` and `closeUpImage2`, and the generation layer already reads
 * all three: buildVideoPrompt tags them as "@image for close-up facial
 * detail — eye color, skin texture, pores", VideosTab passes them as identity
 * references, and Motion Copy offers them as the character to animate.
 *
 * But only the old web studio could CREATE them. When it was removed the three
 * fields stayed pinned at null on every influencer the mobile app made, so
 * video generation ran on one reference image instead of four and the extra
 * prompt tags pointed at nothing. Identity consistency suffered silently.
 *
 * This is the missing producer. The slot table is here rather than in a screen
 * because the prompt and the aspect ratio belong together — a feature sheet
 * rendered at 4:5 crops its own labels off.
 */

import { buildInfluencerSheetPrompt, buildCloseUpPrompt, buildFeatureSheetPrompt } from './prompts/charSheetPrompt'
import { generateSingleImage } from './services/generation'

/**
 * The three reference slots, in the order the video prompt expects them.
 * `field` is the influencer property; `label` is what the gallery records.
 */
export const IDENTITY_SLOTS = [
  {
    key: 'sheet',
    field: 'characterSheetImage',
    label: 'Character Sheet',
    blurb: 'Four full-body views — front, side, back, three-quarter.',
    aspectRatio: '16:9',
    buildPrompt: buildInfluencerSheetPrompt,
  },
  {
    key: 'closeup',
    field: 'closeUpImage1',
    label: 'Close Up',
    blurb: 'Straight-on studio headshot. Fixes the face for every clip.',
    aspectRatio: '4:5',
    buildPrompt: buildCloseUpPrompt,
  },
  {
    key: 'feature',
    field: 'closeUpImage2',
    label: 'Feature Sheet',
    blurb: 'Macro detail — eyes, brow, lips, skin, hair, hands.',
    aspectRatio: '2:3',
    buildPrompt: buildFeatureSheetPrompt,
  },
]

export function getIdentitySlot(key) {
  return IDENTITY_SLOTS.find(s => s.key === key) || IDENTITY_SLOTS[0]
}

/** Thrown when there is no main image to work from. */
export const NO_MAIN_IMAGE = 'NO_MAIN_IMAGE'

/**
 * Generate one reference sheet from the influencer's main image.
 *
 * The main image is passed as the reference so the result is unmistakably the
 * same person — that is the entire point of these sheets, and generating one
 * without it would produce a stranger.
 *
 * @returns {Promise<string>} the generated image URL
 */
export async function generateIdentityRef(influencer, slotKey, { onProgress, isCancelled } = {}) {
  if (!influencer?.mainImage) throw new Error(NO_MAIN_IMAGE)

  const slot = getIdentitySlot(slotKey)
  const url = await generateSingleImage({
    prompt: slot.buildPrompt(influencer),
    aspectRatio: slot.aspectRatio,
    referenceImage: influencer.mainImage,
    onProgress: onProgress || (() => {}),
    isCancelled: isCancelled || (() => false),
  })

  if (!url) throw new Error('No image was returned — please try again.')
  return url
}
