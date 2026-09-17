/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The shape of a newly created influencer.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Both wizards — web and mobile — produce this, so adding a field cannot
 * silently apply to only one platform.
 *
 * ── What changed with the backend ────────────────────────────────────────────
 *
 * There is no `id` here any more, and no `createdAt`. Postgres generates both;
 * a client-generated primary key would either collide or, worse, let a caller
 * choose one. The image fields are asset ids rather than URLs, because a URL is
 * now a short-lived signed link — storing one would leave a dead reference
 * within the hour.
 *
 * `generationHistory` is gone too: it is its own table now, written through
 * addGeneration, so creating an influencer no longer means writing its gallery
 * in the same breath.
 */

/**
 * @param {object} input
 * @param {object} input.data        wizard state: name, gender, age, description,
 *                                   copyAttributes
 * @param {string} input.mainAssetId the chosen generated image
 * @param {string} [input.referenceAssetId] the uploaded reference, if any
 * @param {string} [input.prompt]    the prompt that produced the main image
 */
export function buildNewInfluencer({ data, mainAssetId, referenceAssetId = null, prompt = '' }) {
  return {
    name: (data.name || '').trim(),
    gender: data.gender,
    age: data.age ? String(data.age) : null,
    type: 'Influencer',

    niche: '',
    niches: [],
    nicheCustom: '',
    backstory: '',
    introExtrovert: 50,
    physicalDesc: (data.description || '').trim(),
    vibeWords: [],

    mainAssetId,
    referenceAssetId,
    prompt,
    copyAttributes: data.copyAttributes || [],

    audience: '',
    clothingStyle: '',
    hobbies: '',
    location: '',
    palette: [],
    voice: '',
    dreamBrands: '',
    contentPillars: [],

    // Slot ids are local and cosmetic — they key a list, they are not rows.
    wardrobeSlots: [
      { id: 'w1', name: 'Wardrobe 1', asset_id: null },
      { id: 'w2', name: 'Wardrobe 2', asset_id: null },
      { id: 'w3', name: 'Wardrobe 3', asset_id: null },
    ],
  }
}

/**
 * The params saved alongside a new influencer so its main image can later be
 * regenerated from the same inputs.
 *
 * The model is deliberately absent — which model runs is decided at call time,
 * so persisting it would pin an influencer to whatever happened to be current
 * the day it was made.
 *
 * `faceRef` is an ASSET ID, not a data URL. The old version stored the whole
 * base64 image inside this blob, which meant every regeneration carried a
 * multi-megabyte payload through storage that already held the same bytes.
 */
export function buildCreationParams({ data, aspectRatio, referenceAssetId = null }) {
  return {
    faceAssetId: referenceAssetId,
    styleAssetId: null,
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
