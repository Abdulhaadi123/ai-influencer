/**
 * "Save or share", with its failures shown.
 *
 * downloadImage throws a message saying what went wrong (no connection, an
 * expired link, no share sheet). Every Save-or-share button calls this rather
 * than firing downloadImage and hoping — which is how a failed share used to
 * do nothing at all.
 */

import { downloadImage } from '@core/platform/media'

import { showError } from './alerts'

export async function shareMedia(url, filename) {
  try {
    await downloadImage(url, filename)
  } catch (e) {
    showError('Unable to share', e, 'This file could not be shared. Please try again.')
  }
}
