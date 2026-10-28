/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Wardrobe — an influencer's saved outfit photos, and changing what they wear.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every influencer record has always carried `wardrobeSlots`: a list of `{ id, name, asset_id }`
 * (the server keeps it as JSON, up to 20 of them). The old web studio filled it and offered the
 * slots as an outfit reference for video; the mobile app kept reading and writing the field
 * (data/influencers.js) but had nowhere to fill it. This is the pure half of that: which slots
 * count, adding, renaming and removing one, and the request an outfit change sends. The screens
 * are components/WardrobeSection.js and components/OutfitSheet.js.
 *
 * ── Two shapes of a slot ─────────────────────────────────────────────────────
 *
 * Read from the server, a slot also carries `image`: the signed link its photo is shown from,
 * which stops working ten minutes after it was made. That is for the screen. What is SAVED is
 * the slot without it (`storedSlots`) — the server keeps whatever it is given, and an expired
 * link in a saved list is worse than none. data/influencers.js applies it to every write, so a
 * caller can hand over the slots it is showing.
 *
 * ── Only filled slots count ──────────────────────────────────────────────────
 *
 * A new influencer is made with three empty slots ("Wardrobe 1".."3", buildNewInfluencer).
 * Nothing reads an empty one, so the list shown, counted and saved here is the filled ones: the
 * first outfit added replaces the placeholders, and removing one removes the slot.
 */

import { INPUT_LIMITS } from './config/inputLimits.js'
import { buildOutfitPrompt } from './prompts/outfitPrompt.js'

/** How many outfits one influencer may hold. The server accepts 20 (backend/api/influencers/index.js). */
export const MAX_WARDROBE_SLOTS = 8

/** Thrown when there is nothing to dress: no main image. */
export const NO_MAIN_IMAGE = 'NO_MAIN_IMAGE'
/** Thrown when the chosen outfit has no photo to send. */
export const NO_OUTFIT_IMAGE = 'NO_OUTFIT_IMAGE'
/** Thrown when an outfit is added to a full wardrobe. */
export const WARDROBE_FULL = 'WARDROBE_FULL'

/** What an outfit change is filed as in the gallery and the queue. */
export const OUTFIT_LABEL = 'Outfit change'

const isSlot = slot => slot !== null && typeof slot === 'object' && !Array.isArray(slot)

/** A slot as it is saved: everything but the display link. */
export function storedSlot(slot) {
  const { image: _link, ...rest } = slot
  return rest
}

/** @returns {object[]} what to write to the server for `slots` — objects only, display links removed */
export function storedSlots(slots) {
  return (Array.isArray(slots) ? slots : []).filter(isSlot).map(storedSlot)
}

/** The slots that hold a photo, in order. */
export function outfitsOf(influencerOrSlots) {
  const slots = Array.isArray(influencerOrSlots) ? influencerOrSlots : influencerOrSlots?.wardrobeSlots
  return (Array.isArray(slots) ? slots : []).filter(slot => isSlot(slot) && slot.asset_id)
}

export function canAddOutfit(influencerOrSlots) {
  return outfitsOf(influencerOrSlots).length < MAX_WARDROBE_SLOTS
}

/** A name as one line within the limit; '' when there is nothing in it. */
export function cleanOutfitName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, INPUT_LIMITS.wardrobeName).trim()
}

/** "Outfit 3": the first number not already a name in `slots`. */
export function nextOutfitName(slots) {
  const taken = new Set(outfitsOf(slots).map(s => String(s.name ?? '').toLowerCase()))
  for (let n = 1; ; n++) {
    const name = `Outfit ${n}`
    if (!taken.has(name.toLowerCase())) return name
  }
}

const newSlotId = () => `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/**
 * The wardrobe with one more outfit at the end.
 *
 * @param {object[]|object} slots  the slots shown, or the influencer
 * @param {{assetId: string, image?: string|null, name?: string, id?: string}} outfit
 * @returns {{slots: object[], slot: object}}  the new list (filled slots only) and the slot added
 * @throws {Error} WARDROBE_FULL
 */
export function addOutfit(slots, { assetId, image = null, name = '', id = newSlotId() }) {
  const current = outfitsOf(slots)
  if (current.length >= MAX_WARDROBE_SLOTS) throw new Error(WARDROBE_FULL)
  if (!assetId) throw new Error('addOutfit needs the photo\'s asset id')

  const slot = { id, name: cleanOutfitName(name) || nextOutfitName(current), asset_id: assetId, image }
  return { slots: [...current, slot], slot }
}

/** The wardrobe with one outfit renamed. A name with nothing in it changes nothing. */
export function renameOutfit(slots, id, name) {
  const clean = cleanOutfitName(name)
  const current = outfitsOf(slots)
  if (!clean) return current
  return current.map(slot => (slot.id === id ? { ...slot, name: clean } : slot))
}

/** The wardrobe without one outfit. */
export function removeOutfit(slots, id) {
  return outfitsOf(slots).filter(slot => slot.id !== id)
}

/** The wardrobe with one outfit's photo swapped. */
export function replaceOutfitPhoto(slots, id, { assetId, image = null }) {
  return outfitsOf(slots).map(slot => (slot.id === id ? { ...slot, asset_id: assetId, image } : slot))
}

/** How an outfit change is filed: "Outfit change · Summer fit". */
export function outfitLabel(outfitName) {
  const name = cleanOutfitName(outfitName)
  return name ? `${OUTFIT_LABEL} · ${name}` : OUTFIT_LABEL
}

/**
 * Everything generateSingleImage needs for one outfit change — or the reason there is none.
 *
 * `aspectRatio: 'auto'` makes the picture come out in the shape of image 1, the first one sent, so
 * it works the same for a main image of any shape. Pure, so what is sent can be tested.
 *
 * @param {object} influencer
 * @param {{name?: string, image?: string|null}} outfit  a wardrobe slot as shown
 * @param {{note?: string}} [options]
 * @throws {Error} NO_MAIN_IMAGE | NO_OUTFIT_IMAGE
 */
export function prepareOutfitChange(influencer, outfit, { note } = {}) {
  if (!influencer?.mainImage) throw new Error(NO_MAIN_IMAGE)
  if (!outfit?.image) throw new Error(NO_OUTFIT_IMAGE)
  return {
    prompt: buildOutfitPrompt({ note }),
    referenceImage: influencer.mainImage,
    outfitImage: outfit.image,
    aspectRatio: 'auto',
    label: outfitLabel(outfit.name),
  }
}
