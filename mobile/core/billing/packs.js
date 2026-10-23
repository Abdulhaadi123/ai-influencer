/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Credit packs and prices — the plain logic behind the Credits screen.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * No React, no native modules, no network: these are the rules, kept apart so they can
 * be checked on their own (packs.test.js).
 *
 * Two lists meet here. The STORE says what is for sale and for how much, in the buyer's
 * own currency (RevenueCat → Google Play). Our SERVER says what each product is worth in
 * credits (`credit_packs`) and what each model costs (`model_prices`). The app never
 * decides either: it shows what the server will honour.
 */

/** "credits_500", whether the store reports it as that or as "credits_500:base-plan". */
export function normalizeProductId(id) {
  return typeof id === 'string' ? id.split(':')[0] : ''
}

/**
 * The packs worth showing: each store product the server will credit, with its worth.
 *
 * A product the server does not list — RevenueCat's leftover sample, a product that was
 * switched off — is not shown at all: offering something that would not be credited
 * is worse than offering less.
 *
 * @param {Array<{id: string, productId: string, price: string, title?: string, native?: unknown}>} storePackages
 * @param {Array<{productId: string, credits: number, label?: string}>} serverPacks
 * @returns {Array<{id: string, productId: string, credits: number, label: string, price: string, native: unknown}>}
 *          smallest pack first
 */
export function joinPacks(storePackages, serverPacks) {
  const worth = new Map((serverPacks || []).map(p => [normalizeProductId(p.productId), p]))
  const joined = []
  for (const pkg of storePackages || []) {
    const pack = worth.get(normalizeProductId(pkg.productId))
    if (!pack || !(Number(pack.credits) > 0)) continue
    joined.push({
      id: pkg.id,
      productId: normalizeProductId(pkg.productId),
      credits: Number(pack.credits),
      label: pack.label || `${formatCredits(pack.credits)} credits`,
      price: pkg.price,
      native: pkg.native,
    })
  }
  return joined.sort((a, b) => a.credits - b.credits)
}

/**
 * 1234.5 → "1,234.5". By hand rather than toLocaleString: the same text on every device,
 * and it does not depend on the JavaScript engine shipping locale data.
 */
export function formatCredits(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  const [whole, fraction] = (Math.round(n * 1000) / 1000).toString().split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${grouped}.${fraction}` : grouped
}

/** Seconds a request asks for, if it asks for a usable number (the server's rule). */
function usableSeconds(seconds) {
  const n = typeof seconds === 'string' && seconds.trim() !== '' ? Number(seconds) : seconds
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 600 ? n : null
}

/**
 * The seconds a video of this length is billed as — the server's rule (billing.js
 * billedSeconds): whole seconds rounded up, as KIE bills a clip, with 50 ms of slack for
 * a container that reports a hair too long. For a clip the person picked; a length they
 * chose from a list (5 s, 10 s) is already whole.
 */
export function billedSeconds(clipSeconds) {
  const n = Number(clipSeconds)
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.ceil(n - 0.05)) : null
}

/**
 * The price row for a model: the row for its `mode` (`kling-3.0/motion-control:720p`) when the
 * list has one — KIE bills some modes at different rates — otherwise the model's own.
 */
export function priceRow(prices, model, mode = null) {
  const list = prices || []
  return (mode ? list.find(p => p.model === `${model}:${mode}`) : null) || list.find(p => p.model === model) || null
}

/**
 * The models a picker should offer: the ones the server will accept.
 *
 * With charging on, the server refuses a model that has no price ("This model is not
 * available right now"), so a picker that lists every model the app knows about lets a person
 * choose one that can only fail — which is what happened after a video failed and they tried
 * another model. A model is on sale when the price list has a row for it, or for one of its
 * modes (`kling-3.0/motion-control:720p`).
 *
 * Nothing is hidden while charging is off, or while the list has not arrived (hiding
 * everything because a request failed would be worse), and the picker is never left empty.
 *
 * @template {{id: string}} M
 * @param {M[]} models   in the order they are offered (the default first)
 * @param {Array<{model: string}>|null|undefined} prices  the server's price list
 * @param {boolean} enforced  whether the server is charging yet
 * @returns {M[]}
 */
export function modelsOnSale(models, prices, enforced) {
  if (!enforced || !Array.isArray(prices) || prices.length === 0) return models
  const onSale = models.filter(m => prices.some(p => p.model === m.id || String(p.model).startsWith(`${m.id}:`)))
  return onSale.length ? onSale : models
}

/**
 * What the server will charge for one generation, so the screen can say so before
 * anyone taps. The same rule as the server's (backend/api/_lib/billing.js priceOf):
 * `credits` per video or image, or per second.
 *
 * @param {Array<{model: string, unit: string, credits: number}>} prices
 * @param {string} model
 * @param {{seconds?: number|string, mode?: string|null}} [request]
 * @returns {number | null}  null when the model has no price, or a per-second price cannot be applied
 */
export function costOf(prices, model, { seconds, mode = null } = {}) {
  const row = priceRow(prices, model, mode)
  if (!row) return null
  const credits = Number(row.credits)
  if (!Number.isFinite(credits) || credits < 0) return null
  if (row.unit === 'per_second') {
    const s = usableSeconds(seconds)
    return s === null ? null : Math.round(credits * s * 1000) / 1000
  }
  return Math.round(credits * 1000) / 1000
}

/** "18 credits per image", "20 credits per second" — one line of the price list. */
export function describePrice(row) {
  const unit = { per_image: 'image', per_video: 'video', per_second: 'second' }[row?.unit] ?? 'generation'
  const credits = Number(row?.credits)
  return `${formatCredits(credits)} ${credits === 1 ? 'credit' : 'credits'} per ${unit}`
}

/** The price a person reads before tapping: "About 100 credits", or nothing when it is not known. */
export function costLine(cost) {
  if (cost === null || cost === undefined) return null
  if (cost === 0) return 'Free'
  return `${formatCredits(cost)} ${cost === 1 ? 'credit' : 'credits'}`
}

/**
 * What a bought pack tells the buyer, in every place that sells packs. The store confirms a purchase
 * at once, but the credits are added when the server hears from RevenueCat — so the words depend on
 * whether the balance has risen yet, and never claim credits that have not arrived.
 *
 * @param {{credits: number}} pack
 * @param {boolean} arrived  the balance rose while we waited
 * @param {{canRefresh?: boolean}} [where]  the screen can be pulled down to refresh (the Credits screen)
 * @returns {{title: string, body: string}}
 */
export function purchaseNotice(pack, arrived, { canRefresh = false } = {}) {
  if (arrived) return { title: 'Credits added', body: `${formatCredits(pack?.credits)} credits were added to your account.` }
  return {
    title: 'Purchase complete',
    body: `Your purchase went through. The credits can take a minute to appear${canRefresh ? ' — pull down to refresh.' : '.'}`,
  }
}

/**
 * Whether the app should bring credits up at all.
 *
 * While the server is only watching (BILLING_ENFORCED off) nobody is charged, so a
 * "0 credits" in the header would worry people for nothing. Credits show when they
 * matter: the server is enforcing, the account holds some (or owes some), or this is a
 * development build, where the purchase flow has to be reachable to be tested.
 *
 * @param {{enforced?: boolean, balance?: number|null}} state
 * @param {boolean} [dev]  true in a development build
 */
export function creditsVisible(state, dev = false) {
  return dev === true || state?.enforced === true || (Number(state?.balance) || 0) !== 0
}
