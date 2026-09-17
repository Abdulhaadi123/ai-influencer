/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Choosing which reference images a video request actually carries.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every video vendor caps the number of reference images, and the cap is small:
 * three of the ten selectable models take two, the other seven take exactly
 * one. There are almost always more images available than will fit — a main
 * image, up to three identity sheets, and up to three product photos — so
 * something is always being left behind. The only question is what.
 *
 * It used to be answered by array order: identity images were listed first and
 * products last, then the request layer truncated the tail. That meant an
 * influencer with reference sheets generated silently dropped the product photo
 * from every promo video. The clip still came back, the prompt still said "the
 * product", and the model invented one. Nothing surfaced the loss.
 *
 * So the order is a deliberate ranking now:
 *
 *   1. the main image      — without it the subject is not this influencer
 *   2. the first product   — a promo with no product is worthless
 *   3. character sheet     — outfit/body consistency
 *   4. close-up            — facial detail
 *   5. feature sheet       — macro detail
 *   6. extra products      — only reachable on models that take many images
 *
 * A softer face beats an absent product, which is why 2 outranks 3.
 *
 * This is the single source of truth for what gets sent: the studio screen
 * calls it to build the request AND to warn about what will not fit, so the
 * warning can never disagree with the payload.
 */

/**
 * @param {object}   influencer
 * @param {string[]} products     product image URIs, in the order the user added them
 * @param {number}   maxImages    the chosen model's declared limit
 * @returns {{
 *   images: string[],            what to send, already trimmed to maxImages
 *   roles: string[],             what each sent image is, in the same order —
 *                                buildVideoPrompt and generateVideo tag by these
 *   dropped: string[],           labels of the references that did not fit
 *   productsIncluded: number,    how many product photos survived
 *   productsDropped: number,     how many did not
 * }}
 */
export function selectVideoReferences(influencer, products = [], maxImages = 2) {
  const cleanProducts = (products || []).filter(Boolean)

  const ranked = [
    { label: 'Main image',      role: 'identity',  url: influencer?.mainImage,           isProduct: false },
    { label: 'Product',         role: 'product1',  url: cleanProducts[0],                isProduct: true  },
    { label: 'Character sheet', role: 'charsheet', url: influencer?.characterSheetImage, isProduct: false },
    { label: 'Close-up',        role: 'closeup1',  url: influencer?.closeUpImage1,       isProduct: false },
    { label: 'Feature sheet',   role: 'closeup2',  url: influencer?.closeUpImage2,       isProduct: false },
    ...cleanProducts.slice(1).map((url, i) => ({ label: 'Product', role: `product${i + 2}`, url, isProduct: true })),
  ].filter(r => !!r.url)

  const limit = Math.max(1, maxImages || 1)
  const kept = ranked.slice(0, limit)
  const lost = ranked.slice(limit)

  return {
    images: kept.map(r => r.url),
    roles: kept.map(r => r.role),
    dropped: lost.map(r => r.label),
    productsIncluded: kept.filter(r => r.isProduct).length,
    productsDropped: lost.filter(r => r.isProduct).length,
  }
}

/**
 * A one-line, user-facing account of what will not be sent — or null when
 * everything fits and there is nothing worth saying.
 *
 * Deliberately blunt about products: dropping an identity sheet costs some
 * likeness, dropping the product photo means the video cannot do its job, so
 * the two do not get the same wording.
 */
export function describeDroppedReferences(selection, modelLabel) {
  if (!selection || !selection.dropped.length) return null

  if (selection.productsDropped > 0) {
    const n = selection.productsDropped
    return `${modelLabel} accepts only ${selection.images.length} reference image${selection.images.length === 1 ? '' : 's'}, so ${n} product photo${n === 1 ? '' : 's'} will NOT be included — the video will not show ${n === 1 ? 'it' : 'them'}. Pick a model that takes two images, or remove a reference sheet.`
  }

  return `${modelLabel} accepts only ${selection.images.length} reference image${selection.images.length === 1 ? '' : 's'}, so ${selection.dropped.join(' and ')} will not be sent. Likeness may drift slightly.`
}
