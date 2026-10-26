/**
 * ─────────────────────────────────────────────────────────────────────────────
 * What a generation should cost in our credits — the costing document's formula.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * KIE sells its credits at $0.005 each. We sell ours for less — $0.0035 in the two big
 * packs, $0.004 in the smallest — so charging one of ours for each KIE credit (1:1) loses
 * money on every generation. The costing document (owner, October 2026) works out what to
 * charge instead, and this file is that arithmetic and nothing else:
 *
 *   our revenue per credit, in the worst pack      $70 / 20,000  = $0.0035
 *   after the store's commission (20%)             $0.0035 × 0.8 = $0.0028
 *   KIE credits → ours, to break even              $0.005 / $0.0028 = × 1.7857
 *   credits for a profit margin m                  break even / (1 − m)
 *
 * The worst pack is the base on purpose: someone who buys the 5,000 pack pays $0.004 a
 * credit, so every price that covers the big packs earns more than its target on that one.
 *
 * The margin is a share of REVENUE (a 30% margin keeps 30 cents of every dollar paid), which
 * is what "Credits = Break-Even / (1 − Target Profit %)" means.
 *
 * Prices are whole credits, rounded UP: a price may beat its target by a fraction of a credit,
 * never fall short of it. (Rounding to nearest would price some items under their target.)
 *
 * Where this is used: db/reprice.js, which rewrites `model_prices` from KIE's own prices. The
 * charging code (billing.js) knows nothing of this file — it charges the row it finds.
 */

/** What KIE charges us for one of its credits. */
export const KIE_USD_PER_CREDIT = 0.005

/**
 * The packs on sale: credits and the US price (migration 010; the prices themselves live in
 * Google Play). A pack's price per credit is what a credit earns when it is bought in that pack.
 */
export const PACKS = Object.freeze([
  { credits: 5000, usd: 20 },
  { credits: 10000, usd: 35 },
  { credits: 20000, usd: 70 },
])

/** What a credit earns in the cheapest pack — the base the document prices from. */
export const WORST_USD_PER_CREDIT = Math.min(...PACKS.map(p => p.usd / p.credits))

/** The store's share of every sale (the document assumes 20%). */
export const DEFAULT_COMMISSION = 0.20

/** The share of revenue we keep (the owner picks; 30% is the default). */
export const DEFAULT_MARGIN = 0.30

/** Compare floats that were computed, not typed: 25 that arrives as 25.000000000000004 is 25. */
const EPSILON = 1e-9

function share(value, name, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be a number from 0 to ${max} (a share, so 0.3 is 30%).`)
  }
  return value
}

/**
 * How many of our credits cover one KIE credit with nothing left over — the document's ×1.79.
 * @param {{commission?: number}} [opts]
 */
export function breakEvenMultiplier({ commission = DEFAULT_COMMISSION } = {}) {
  share(commission, 'commission', 0.6)
  return KIE_USD_PER_CREDIT / (WORST_USD_PER_CREDIT * (1 - commission))
}

/**
 * How many of our credits to charge per KIE credit for a margin — ×1.79 at break even, ×2.55 at 30%.
 * @param {{margin?: number, commission?: number}} [opts]
 */
export function priceMultiplier({ margin = DEFAULT_MARGIN, commission = DEFAULT_COMMISSION } = {}) {
  share(margin, 'margin', 0.9)
  return breakEvenMultiplier({ commission }) / (1 - margin)
}

/**
 * The credits to charge for something KIE charges `kieCredits` for: whole credits, rounded up, so the
 * margin is at least the target. Nothing is free by accident: any positive cost is at least 1 credit.
 *
 * @param {number} kieCredits  what KIE charges (per image, per video or per second)
 * @param {{margin?: number, commission?: number}} [opts]
 * @returns {number}
 */
export function userCredits(kieCredits, opts = {}) {
  if (typeof kieCredits !== 'number' || !Number.isFinite(kieCredits) || kieCredits < 0) {
    throw new RangeError('kieCredits must be a number of credits, zero or more.')
  }
  if (kieCredits === 0) return 0
  return Math.max(1, Math.ceil(kieCredits * priceMultiplier(opts) - EPSILON))
}

/**
 * The margin a price actually earns — a share of revenue — at the worst pack, after the commission.
 * Negative when the price loses money.
 *
 * @param {number} kieCredits  what KIE charges
 * @param {number} charged     what we charge, in our credits
 * @param {{commission?: number}} [opts]
 */
export function marginOf(kieCredits, charged, { commission = DEFAULT_COMMISSION } = {}) {
  share(commission, 'commission', 0.6)
  const revenue = charged * WORST_USD_PER_CREDIT * (1 - commission)
  if (revenue === 0) return kieCredits === 0 ? 0 : -Infinity
  return 1 - (kieCredits * KIE_USD_PER_CREDIT) / revenue
}

/**
 * What KIE charges for the models we sell, in KIE credits — the cost the prices are worked from.
 * Kept here, with where each number comes from, because a price row only holds what we CHARGE:
 * once a row has been marked up there is no way to read KIE's number back from it, and working
 * from the charged price would mark it up again on the next run.
 *
 * Add a model here (with its source) before it can be repriced. Rows that are not listed are
 * never touched.
 */
export const KIE_COST = Object.freeze([
  // KIE: 1K/2K image (the app asks for 2K); two real jobs in KIE's logs cost 18.
  { model: 'nano-banana-pro', unit: 'per_image', kieCredits: 18 },
  // KIE Kling 3.0: Standard mode with sound, 20 a second (14 without sound — one price per model, so the higher).
  { model: 'kling-3.0/video', unit: 'per_second', kieCredits: 20 },
  // KIE Kling 3.0 Motion Control, billed per second of the clip; tested with a real 4 s job: 80 credits.
  { model: 'kling-3.0/motion-control:720p', unit: 'per_second', kieCredits: 20 },
  { model: 'kling-3.0/motion-control:1080p', unit: 'per_second', kieCredits: 27 },
  // The row a request with no mode is priced by: the higher rate, so it never undercharges.
  { model: 'kling-3.0/motion-control', unit: 'per_second', kieCredits: 27 },
])
