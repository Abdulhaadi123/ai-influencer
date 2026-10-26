/**
 * Open one of the website's legal pages in the phone's browser.
 *
 * Linking.openURL on an https address needs no extra permission or native module. If the phone
 * has no browser to hand it to (or refuses), say so and show the address, rather than a tap that
 * does nothing.
 */

import { Linking } from 'react-native'

import { legalUrl } from '@core/config/legal'
import { Alert } from './dialog'

/** @param {'privacy'|'terms'|'support'|'deleteAccount'} id */
export async function openLegal(id) {
  const url = legalUrl(id)
  try {
    await Linking.openURL(url)
  } catch (e) {
    console.warn('[legal] could not open', url, e?.message ?? e)
    Alert.alert('Could not open the page', `Open this address in your browser:\n${url}`)
  }
}
