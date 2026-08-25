/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The shape of a newly created influencer.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Both wizards — web and mobile — must produce byte-identical records, because
 * the same studio screens read them afterwards. Keeping the shape in one place
 * means adding a field can't silently apply to only one platform.
 */

import { generateId } from './store'

/**
 * @param {object} input
 * @param {object} input.data          wizard state: name, gender, age, description,
 *                                     referenceImage, copyAttributes
 * @param {string[]} input.variations  the generated image URLs
 * @param {number} input.selectedIdx   which variation the user picked
 * @param {string[]} input.prompts     the prompts used, parallel to `variations`
 * @param {string|null} input.replaceId  set when regenerating an existing influencer
 */
export function buildNewInfluencer({ data, variations, selectedIdx, prompts = [], replaceId = null }) {
  const now = Date.now()
  const promptList = Array.isArray(prompts) ? prompts : [prompts]

  return {
    id: replaceId || generateId(),
    name: (data.name || '').trim(),
    gender: data.gender,
    age: data.age,
    type: 'Influencer',
    createdAt: now,

    niche: '', niches: [], nicheCustom: '',
    backstory: '', introExtrovert: 50,
    physicalDesc: (data.description || '').trim(),
    vibeWords: [],

    mainImage: variations[selectedIdx] || null,
    prompt: promptList[selectedIdx] || '',
    referenceImage: data.referenceImage || null,
    copyAttributes: data.copyAttributes || [],

    characterSheetImage: null, closeUpImage1: null, closeUpImage2: null,
    audience: '', clothingStyle: '', hobbies: '', location: '',
    palette: [], voice: '', dreamBrands: '', contentPillars: [],
    videoUrls: [], scripts: [], homeImages: [],

    wardrobeSlots: [
      { id: generateId(), name: 'Wardrobe 1', image: null },
      { id: generateId(), name: 'Wardrobe 2', image: null },
      { id: generateId(), name: 'Wardrobe 3', image: null },
    ],
    brandDealImages: [],

    generationHistory: variations.map(url => ({
      id: generateId(), type: 'image', label: 'Generated Look', url, date: now,
    })),
  }
}

/**
 * The params saved alongside a new influencer so its main image can later be
 * regenerated from the same inputs. The model is deliberately absent — see
 * creationParams.js.
 */
export function buildCreationParams({ data, aspectRatio }) {
  return {
    faceRef: data.referenceImage || null,
    styleRef: null,
    faceRefNote: '',
    styleRefNote: '',
    aspectRatio: aspectRatio || '9:16',
    physicalDesc: (data.description || '').trim(),
    gender: data.gender,
    age: data.age,
    vibeWords: [],
    personality: 50,
    backstory: '',
    copyAttributes: data.copyAttributes || [],
  }
}
