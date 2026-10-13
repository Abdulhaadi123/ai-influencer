/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Buying credit packs — WEB (see purchases.native.js for the real thing).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The web build is a reference only and has no store. These stand-ins keep the same
 * shape so shared code can import `purchases` without caring which platform it is on:
 * nothing is for sale here, and trying to buy says so.
 */

import { AppError } from '../errors'

export const purchasesAvailable = () => false

export async function startPurchases() {
  return false
}

export async function loadStorePackages() {
  return []
}

export async function buyPackage() {
  throw new AppError('Purchases are only available in the mobile app.', { code: 'PURCHASES_UNAVAILABLE' })
}

export async function syncPurchases() {}
