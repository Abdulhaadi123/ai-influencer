/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Change what an influencer is wearing, from an outfit photo.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The same shape as identityRefs.generateIdentityRef: one image job, with the influencer's main
 * image as the reference so the result is unmistakably the same person, and a second picture —
 * here the outfit — alongside it. KIE's Nano Banana Pro takes up to eight reference images
 * (docs.kie.ai/market/google/pro-image-to-image); the order is what the prompt relies on
 * (core/prompts/outfitPrompt.js), and generateSingleImage keeps it: face first, outfit second.
 *
 * What is sent is decided by wardrobe.prepareOutfitChange, which has no network in it and is
 * tested. This only sends it, and hands the job's progress and ids back to the screen so a
 * picture that outlives the foreground poll can be watched until it lands (usePendingResult).
 */

import { generateSingleImage } from './services/generation'
import { prepareOutfitChange } from './wardrobe'

/**
 * @param {object} influencer  needs `mainImage`
 * @param {{name?: string, image?: string|null}} outfit  a wardrobe slot as shown
 * @param {object} [options]
 * @param {string} [options.note]  a line from the person, e.g. "sleeves rolled up"
 * @param {(pct: number) => void} [options.onProgress]
 * @param {() => boolean} [options.isCancelled]
 * @param {object} [options.queueMeta]
 * @param {(ids: string[]) => void} [options.onJobIds]
 * @returns {Promise<string>} the generated image's URL
 */
export async function changeOutfit(influencer, outfit, { note, onProgress, isCancelled, queueMeta, onJobIds } = {}) {
  const request = prepareOutfitChange(influencer, outfit, { note })

  const url = await generateSingleImage({
    prompt: request.prompt,
    aspectRatio: request.aspectRatio,
    referenceImage: request.referenceImage,
    outfitImage: request.outfitImage,
    onProgress: onProgress || (() => {}),
    isCancelled: isCancelled || (() => false),
    queueMeta: { ...(queueMeta || {}), label: request.label },
    onJobIds,
  })

  if (!url) throw new Error('No image was returned — please try again.')
  return url
}
