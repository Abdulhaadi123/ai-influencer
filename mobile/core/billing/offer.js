/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The pack offer: when the "Get credits" screens are shown, and what a pack is said to give.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The design has two payment screens after sign-up — a plan, a price, a Continue. Here the thing
 * for sale is a pack of credits (one payment, no subscription), so they are the "Get credits" and
 * "Choose a pack" screens (src/screens/GetCreditsScreen.js, ChoosePackScreen.js).
 *
 * They are an offer, not a gate: shown ONCE, to someone who has no credits and for whom credits
 * matter (see creditsVisible), in a build that can sell them, and always skippable. Everything
 * here is plain logic with tests.
 */

import { formatCredits } from './packs.js'

/** The one device preference this adds: the offer has been shown on this install. */
export const OFFER_SEEN_KEY = 'pack_offer_seen'

/**
 * @param {{loaded: boolean, visible: boolean, available: boolean, balance: number|null, seen: boolean}} s
 *   loaded     the server has told us the balance (0 may just mean "not yet")
 *   visible    credits matter here (creditsVisible)
 *   available  this build can sell packs (a store key was provided)
 *   balance    what the account holds
 *   seen       the offer has already been shown on this install
 * @returns {boolean} whether to open the offer now
 */
export function shouldOfferPacks({ loaded, visible, available, balance, seen }) {
  return loaded === true && visible === true && available === true && seen !== true && balance === 0
}

/**
 * The plain-words list under a pack: what it is for, what it gives, from what the server says things
 * cost. Nothing is promised that the numbers do not back: the image count is only said when there is a
 * per-image price to divide by. (The pack's own size is not a line here: the screen already shows it
 * in big letters above the list.)
 *
 * @param {{credits: number}} pack
 * @param {Array<{unit: string, credits: number}>} [prices]  the server's price list
 * @returns {Array<{id: string, text: string}>}
 */
export function packBenefits(pack, prices = []) {
  const credits = Number(pack?.credits)
  if (!(credits > 0)) return []

  const items = [{ id: 'spend', text: 'For images, videos and motion copy' }]

  const perImage = (prices || [])
    .filter(p => p?.unit === 'per_image' && Number(p.credits) > 0)
    .map(p => Number(p.credits))
  if (perImage.length) {
    const images = Math.floor(credits / Math.min(...perImage))
    if (images >= 1) items.push({ id: 'images', text: `About ${formatCredits(images)} ${images === 1 ? 'image' : 'images'}` })
  }

  items.push(
    { id: 'never-expire', text: 'Credits never expire' },
    { id: 'refund', text: 'Credits come back if a generation fails' },
    { id: 'one-payment', text: 'One payment, no subscription' },
  )
  return items
}
