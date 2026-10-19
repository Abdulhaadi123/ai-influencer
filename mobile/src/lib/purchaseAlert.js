/**
 * Telling the buyer what a purchase did — one alert, one wording, for every screen that sells packs
 * (the Credits screen, and the "Get credits" / "Choose a pack" offer). What it says, and why it never
 * claims credits that have not arrived, is core/billing/packs.js purchaseNotice.
 */

import { Alert } from 'react-native'

import { purchaseNotice } from '@core/billing/packs'

/**
 * @param {{credits: number}} pack
 * @param {boolean} arrived  the balance rose while we waited
 * @param {{canRefresh?: boolean, onDone?: () => void}} [options]
 *        canRefresh  the screen can be pulled down to refresh
 *        onDone      what happens when the person taps OK. The alert then cannot be dismissed any other way, so
 *                    `onDone` runs exactly once (an offer screen closes itself here).
 */
export function announcePurchase(pack, arrived, { canRefresh = false, onDone } = {}) {
  const { title, body } = purchaseNotice(pack, arrived, { canRefresh })
  if (!onDone) { Alert.alert(title, body); return }
  Alert.alert(title, body, [{ text: 'OK', onPress: onDone }], { cancelable: false })
}
