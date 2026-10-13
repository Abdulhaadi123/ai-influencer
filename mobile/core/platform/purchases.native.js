/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Buying credit packs — REACT NATIVE (see purchases.js for web).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The only file that talks to the store, through RevenueCat's SDK. Everything else
 * in the app asks for packs and purchases here and knows nothing of the SDK.
 *
 * ── What the app does and does not do ────────────────────────────────────────
 *
 * It starts a purchase. It does NOT grant credits: the store tells RevenueCat, RevenueCat
 * tells our server (a webhook), and the server adds them (backend/api/revenuecat-webhook.js).
 * A purchase the SDK reports as done changes nothing on its own — the Credits screen
 * waits for the balance to rise (core/data/billing.js waitForCredits). Nothing the app says
 * could add a credit, which is what makes it safe to ship.
 *
 * ── Who RevenueCat thinks the buyer is ───────────────────────────────────────
 *
 * Always OUR account id, never an anonymous one. RevenueCat merges anonymous ids with
 * real ones over time, and a purchase that lands on an id the server does not know cannot
 * be credited. So the SDK is configured with the signed-in account's id, and `logIn`
 * moves it when another account signs in. `logOut` is never called: it would mint an
 * anonymous id, and the next sign-in's `logIn` replaces the account anyway.
 *
 * ── Keys ─────────────────────────────────────────────────────────────────────
 *
 * The Google Play key for real builds. The Test Store key (simulated purchases, no
 * store) only in a development build: RevenueCat's SDK deliberately crashes when a release
 * build is configured with it, so it must never be reachable there — `__DEV__` is false
 * in a release build, which makes that true by construction.
 */

import Purchases from 'react-native-purchases'

import { REVENUECAT_ANDROID_KEY, REVENUECAT_TEST_KEY } from '../config/env'
import { AppError, NETWORK_MESSAGE } from '../errors'

// Read off the class: the SDK's own docs name it that way, and it is the one spelling both its platforms agree on.
const { LOG_LEVEL, PURCHASES_ERROR_CODE } = Purchases

function sdkKey() {
  return __DEV__ && REVENUECAT_TEST_KEY ? REVENUECAT_TEST_KEY : REVENUECAT_ANDROID_KEY
}

/** Whether this build can sell anything (a key was provided). */
export function purchasesAvailable() {
  return sdkKey() !== ''
}

let configuredFor = null
let chain = Promise.resolve()

async function start(userId) {
  if (!userId || !purchasesAvailable()) return false
  if (configuredFor === userId) return true
  if (configuredFor === null) {
    Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.INFO : LOG_LEVEL.WARN)
    Purchases.configure({ apiKey: sdkKey(), appUserID: userId })
  } else {
    await Purchases.logIn(userId)
  }
  configuredFor = userId
  return true
}

/**
 * Tell RevenueCat who is signed in. One call at a time (a second sign-in cannot overtake a
 * first); never rejects — a store that cannot start must not stop the app.
 *
 * @returns {Promise<boolean>} whether purchases are ready for this account
 */
export function startPurchases(userId) {
  chain = chain.then(() => start(userId)).catch(e => {
    console.warn('[purchases] could not start:', e?.message ?? e)
    return false
  })
  return chain
}

/**
 * What is for sale, as the store describes it (the local price in the buyer's currency).
 * What each pack is WORTH comes from our server (core/billing/packs.js joinPacks).
 *
 * @returns {Promise<Array<{id: string, productId: string, title: string, price: string, native: object}>>}
 */
export async function loadStorePackages() {
  const offerings = await Purchases.getOfferings()
  const offering = offerings.all?.default ?? offerings.current
  return (offering?.availablePackages ?? []).map(p => ({
    id: p.identifier,
    productId: p.product.identifier,
    title: p.product.title,
    price: p.product.priceString,
    native: p,
  }))
}

const FAILURES = {
  [PURCHASES_ERROR_CODE.NETWORK_ERROR]: NETWORK_MESSAGE,
  [PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR]: 'Your payment is pending. The credits will be added once it is confirmed.',
  [PURCHASES_ERROR_CODE.PRODUCT_ALREADY_PURCHASED_ERROR]: 'This purchase is already being processed. Pull down to refresh your credits.',
  [PURCHASES_ERROR_CODE.PRODUCT_NOT_AVAILABLE_FOR_PURCHASE_ERROR]: 'This pack is not available right now. Please try again later.',
  [PURCHASES_ERROR_CODE.PURCHASE_NOT_ALLOWED_ERROR]: 'Purchases are not allowed on this device or account.',
}

/**
 * Buy one pack.
 *
 * @param {object} nativePackage  `native` from loadStorePackages
 * @returns {Promise<{cancelled: boolean}>}  cancelling is a choice, not a failure
 * @throws {AppError}  worded for the person, with the store's own error kept as `cause`
 */
export async function buyPackage(nativePackage) {
  try {
    await Purchases.purchasePackage(nativePackage)
    return { cancelled: false }
  } catch (e) {
    if (e?.userCancelled || e?.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) return { cancelled: true }
    console.warn('[purchases] purchase failed:', e?.code, e?.message)
    throw new AppError(FAILURES[e?.code] || 'The purchase could not be completed. Please try again.', { code: 'PURCHASE_FAILED', cause: e })
  }
}

/**
 * Ask the store to re-send anything it has not told RevenueCat about (a purchase made
 * while the app was closed or offline). Best effort — a failure here only means the next
 * refresh looks again.
 */
export async function syncPurchases() {
  try {
    await Purchases.syncPurchases()
  } catch (e) {
    console.warn('[purchases] sync failed:', e?.message ?? e)
  }
}
