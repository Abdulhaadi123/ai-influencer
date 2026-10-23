/**
 * Telling the buyer what a purchase did — one notice, one wording, for every screen that sells packs
 * (the Credits screen, and the "Get credits" / "Choose a pack" offer). What it says, and why it never
 * claims credits that have not arrived, is core/billing/packs.js purchaseNotice.
 *
 * It used to be the system alert: a grey Android box over a light page, the one moment in the
 * app that did not look like the app. It is now drawn by PurchaseNoticeHost (components/PurchaseNotice.js),
 * mounted once above the navigator, so every screen that sells shows the same card. The system alert
 * is kept only for the case where no host is mounted, so a purchase is never announced to nobody.
 */

import { Alert } from 'react-native'

import { purchaseNotice } from '@core/billing/packs'

/** @type {((notice: {title: string, body: string, arrived: boolean, onDone?: () => void}) => void) | null} */
let host = null

/** Called by PurchaseNoticeHost on mount; returns the unsubscribe. */
export function registerPurchaseNoticeHost(show) {
  host = show
  return () => { if (host === show) host = null }
}

/**
 * @param {{credits: number}} pack
 * @param {boolean} arrived  the balance rose while we waited
 * @param {{canRefresh?: boolean, onDone?: () => void}} [options]
 *        canRefresh  the screen can be pulled down to refresh
 *        onDone      what happens when the person closes the notice; runs exactly once
 *                    (an offer screen closes itself here).
 */
export function announcePurchase(pack, arrived, { canRefresh = false, onDone } = {}) {
  const { title, body } = purchaseNotice(pack, arrived, { canRefresh })
  if (host) { host({ title, body, arrived, onDone }); return }
  if (!onDone) { Alert.alert(title, body); return }
  Alert.alert(title, body, [{ text: 'OK', onPress: onDone }], { cancelable: false })
}
