/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Regenerating an influencer's main image.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Reuses the params captured when the influencer was created (reference image,
 * description, aspect ratio) so a regenerated image still looks like the same
 * person. Shared by the web studio and the mobile one.
 *
 * Throws NO_CREATION_PARAMS when the influencer predates creation-param
 * tracking, so each platform can present that in its own way — an alert on the
 * web, a native dialog on mobile — instead of core deciding for them.
 */

import { getCreationParams } from './creationParams'
import { buildThreeVariationPrompts } from './prompts/systemPrompt'
import { generateThreeImages } from './services/generation'

export const NO_CREATION_PARAMS = 'NO_CREATION_PARAMS'

/**
 * @param {object} influencer
 * @param {(pct:number)=>void} [onProgress]
 * @returns {Promise<string>} the new image URL
 */
export async function regenerateMainImage(influencer, onProgress) {
  const params = getCreationParams(influencer.id)
  if (!params) throw new Error(NO_CREATION_PARAMS)

  const aspectRatio = params.aspectRatio || '9:16'

  // Three variation prompts are built, then one is picked at random, so
  // repeated regenerations don't all come back with the same pose.
  const prompts = buildThreeVariationPrompts(
    { ...params, name: influencer.name },
    aspectRatio
  )
  const prompt = prompts[Math.floor(Math.random() * prompts.length)]

  const urls = await generateThreeImages({
    prompts: [prompt],
    aspectRatio,
    faceRef: params.faceRef || null,
    styleRef: params.styleRef || null,
    physicalDesc: params.physicalDesc || '',
    faceRefNote: params.faceRefNote || '',
    styleRefNote: params.styleRefNote || '',
    onProgress: onProgress || (() => {}),
  })

  if (!urls[0]) throw new Error('No image was returned — please try again.')
  return urls[0]
}
