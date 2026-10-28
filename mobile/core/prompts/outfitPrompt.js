/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The prompt for changing what an influencer is wearing.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two pictures go to the image model, in this order (generateSingleImage sends
 * `[referenceImage, outfitImage]`): image 1 is the influencer, image 2 is the outfit.
 * The prompt says which is which by number, says what must NOT change, and says what
 * to take from image 2 — and what not to: an outfit photo is often someone wearing it,
 * and their face must not come across with it.
 *
 * It says nothing about the influencer's looks. The picture is the reference; a
 * description typed on the profile would only give the model something to disagree
 * with. What the person adds ("sleeves rolled up") goes last, under the rules, and
 * is marked as the weaker instruction.
 */

import { INPUT_LIMITS } from '../config/inputLimits.js'

/** What a person typed, as one line within the limit; '' when there is nothing. */
export function cleanOutfitNote(note) {
  return String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, INPUT_LIMITS.outfitNote).trim()
}

/** @param {{note?: string}} [options] */
export function buildOutfitPrompt({ note } = {}) {
  const extra = cleanOutfitNote(note)
  const direction = extra
    ? `\n\nExtra direction from the user, to follow only where it does not conflict with the rules above: ${extra}`
    : ''

  return `Edit image 1: dress the person in image 1 in the outfit shown in image 2.

Image 1 is the person. Keep everything about image 1 exactly as it is except the clothing: the same face and facial features, skin tone and texture, hair, body shape and proportions, pose, expression, hands, background, lighting, camera angle and framing. It is the same photograph; only the clothes change.

Image 2 shows the outfit, either laid out on its own or worn by someone else. Put that outfit on the person in image 1: the same garments, colours, fabric, pattern, cut, length, fit, layering and accessories (shoes, bag, jewellery, hat, belt), fitted naturally to the person's body and pose, with realistic folds, shadows and drape. If someone is wearing the outfit in image 2, take only the clothes: ignore their face, hair, skin, body and the background. Where the new outfit covers something the old clothes showed, cover it, and leave no part of the old clothing visible.

Do not add logos, brand names or text that are not clearly visible in image 2, and do not invent items that are not in it. The person stays fully and appropriately dressed.${direction}

Photorealistic, natural lighting, sharp real detail. No beauty retouching, no stylization, no CGI or 3D-render look.`
}
