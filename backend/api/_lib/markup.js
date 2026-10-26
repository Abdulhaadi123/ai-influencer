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
 * never touched, and the repricing command names them so none is forgotten.
 */
export const KIE_COST = Object.freeze([
  // KIE: 1K/2K image (the app asks for 2K); two real jobs in KIE's logs cost 18.
  { model: 'nano-banana-pro', unit: 'per_image', kieCredits: 18 },
  // KIE Kling 3.0: Standard mode with sound, 20 a second (14 without sound — one price per model, so the higher).
  // Real jobs on 26 October 2026: 3 s with sound cost 60 (20 a second); on 23 October 5 s without sound cost 70.
  { model: 'kling-3.0/video', unit: 'per_second', kieCredits: 20 },
  // KIE Kling 3.0 Motion Control, billed per second of the clip; real jobs: a 4 s clip cost 80 at 720p (16 October)
  // and 108 at 1080p (26 October).
  { model: 'kling-3.0/motion-control:720p', unit: 'per_second', kieCredits: 20 },
  { model: 'kling-3.0/motion-control:1080p', unit: 'per_second', kieCredits: 27 },
  // The row a request with no mode is priced by: the higher rate, so it never undercharges.
  { model: 'kling-3.0/motion-control', unit: 'per_second', kieCredits: 27 },

  // ── The other models the app offers (mobile/core/config/videoModels.js) ──────────────────────────
  // Each has one price whatever its resolution or length, so the row holds the higher rate and a price
  // built on it never undercharges. Where KIE prices a whole video, the row is that price per second.
  // These were set in the price list at KIE's own number (1:1) and are listed here with KIE's price
  // page (kie.ai/pricing, read October 2026) as the source. Each was also run for real at its shortest
  // length on 23 October 2026 and KIE charged exactly that rate, except where a note says otherwise;
  // Kling 2.6 Motion Control at 1080p and Seedance 2.5 were run on 26 October 2026.

  // Kling
  { model: 'kling/v3-turbo-image-to-video', unit: 'per_second', kieCredits: 22.5 },           // Kling 3.0 Turbo, 1080P: 22.5 a second (720P is 18)
  { model: 'kling/v2-5-turbo-image-to-video-pro', unit: 'per_second', kieCredits: 8.4 },        // Turbo Pro: 42 for 5 s, 84 for 10 s
  { model: 'kling/v2-1-master-image-to-video', unit: 'per_second', kieCredits: 32 },            // Master: 160 for 5 s, 320 for 10 s
  { model: 'kling-2.6/motion-control:720p', unit: 'per_second', kieCredits: 11 },               // 2.6 Motion Control, billed per second of the clip
  { model: 'kling-2.6/motion-control:1080p', unit: 'per_second', kieCredits: 18 },              // real: a 4 s clip cost 72
  { model: 'kling-2.6/motion-control', unit: 'per_second', kieCredits: 18 },                    // no mode: the higher rate

  // Wan
  { model: 'wan/2-6-image-to-video', unit: 'per_second', kieCredits: 21 },                      // 1080p: 105 for 5 s (720p: 70)
  { model: 'wan/2-5-image-to-video', unit: 'per_second', kieCredits: 20 },                      // 1080p: 100 for 5 s (720p: 60)
  { model: 'wan/2-2-animate-move', unit: 'per_second', kieCredits: 12.5 },                      // Animate, 720p; billed per second of the clip

  // The rest
  { model: 'hailuo/2-3-image-to-video-pro', unit: 'per_second', kieCredits: 13.334 },           // Pro, 1080p: 80 for 6 s
  { model: 'minimax-h3/image-to-video', unit: 'per_second', kieCredits: 8 },                    // H3, 768p
  { model: 'minimax-h3/text-to-video', unit: 'per_second', kieCredits: 13 },                    // H3, 2K
  // v6, 1080p with audio (without audio it is 14.4 a second: a real 2 s job on 23 October cost 28.8).
  // On 26 October 2026 KIE failed EVERY request for this model — with audio or without, at 1080p, 720p, 540p
  // and 360p, the audio field left out too — with "No model found [pixverse-v6-i2v] In the channel
  // configuration information", charging nothing. It is KIE's side (the same request worked three days
  // earlier), not a fault of ours or of audio. While that lasts, switch the row off in the admin panel
  // (Pricing → Allowed → Off): the app stops offering the model and the server refuses it at once.
  { model: 'pixverse-v6/image-to-video', unit: 'per_second', kieCredits: 18.4 },
  // Seedance. 2.5 at 1080p with images only ("no video input") is 158 a second: a real 4 s job cost 632 both
  // without and with audio (26 October 2026), so sound is not a price factor. The app never sends a video.
  { model: 'bytedance/seedance-2-5', unit: 'per_second', kieCredits: 158 },
  { model: 'bytedance/seedance-2-mini', unit: 'per_second', kieCredits: 8.2 },                  // 720P, no video input
  { model: 'bytedance/seedance-2-fast', unit: 'per_second', kieCredits: 24.8 },                 // 720p, no video input
  { model: 'grok-imagine/image-to-video', unit: 'per_second', kieCredits: 8 },                  // 1080p

  // Veo, per video. Both entries in the app are billed as Veo 3.1 Fast, 1080p: a real run of 'veo-3-1' on
  // 23 October 2026 cost 65 credits, not the 255 of the Quality tier (see videoModels.js).
  { model: 'veo3_fast', unit: 'per_video', kieCredits: 65 },
  { model: 'veo-3-1', unit: 'per_video', kieCredits: 65 },
])
