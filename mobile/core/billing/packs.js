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
 * What the server will charge for one generation, so the screen can say so before
 * anyone taps. The same rule as the server's (backend/api/_lib/billing.js priceOf):
 * `credits` per video or image, or per second.
 *
 * @param {Array<{model: string, unit: string, credits: number}>} prices
 * @param {string} model
 * @param {{seconds?: number|string}} [request]
 * @returns {number | null}  null when the model has no price, or a per-second price cannot be applied
 */
export function costOf(prices, model, { seconds } = {}) {
  const row = (prices || []).find(p => p.model === model)
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
