/**
 * "Save or share", with its failures shown — and with as little waiting as can be had.
 *
 * downloadImage throws a message saying what went wrong (no connection, an
 * expired link, no share sheet). Every Save-or-share button calls this rather
 * than firing downloadImage and hoping — which is how a failed share used to
 * do nothing at all.
 *
 * ── Why it used to take twenty to thirty seconds ─────────────────────────────
 *
 * The share sheet needs a file on the phone, so Share downloaded the picture from storage — every time, even
 * when the same picture was on the screen already. A generated 2K picture is megabytes (the PNGs were nearly
 * 10 MB), a clip several times that, and nothing on screen said anything was happening, so people waited
 * and tapped again. Now:
 *
 *   • A picture the app has already loaded is taken from where the image view keeps it on the phone
 *     (expo-image's disk cache, keyed on the asset: components/MediaImage.js) — no download at all.
 *   • What does have to be downloaded shows a pill with its progress and a cross to stop it
 *     (components/ShareStatusHost.js), and a second tap while it works is ignored, not a second download.
 */

import { Image } from 'expo-image'

import { downloadImage } from '@core/platform/media'

import { showError } from './alerts'
import { shareStatus } from './shareStatus'
import { mediaImageSource } from '../components/MediaImage'
import { isThumbUrl } from '@core/data/assets'

/**
 * The file on the phone that already holds this picture, as a file:// address, or null.
 * Only for a full picture the image view loaded (never a small preview, never a clip).
 */
export async function loadedCopyOf(url) {
  try {
    if (typeof url !== 'string' || !url.startsWith('http') || isThumbUrl(url)) return null
    const key = mediaImageSource(url)?.cacheKey
    if (!key) return null
    const path = await Image.getCachePathAsync(key)
    return path ? (path.startsWith('file:') ? path : `file://${path}`) : null
  } catch (e) {
    console.warn('[share] could not look in the image cache:', e?.message ?? e)
    return null
  }
}

export async function shareMedia(url, filename) {
  // One at a time: the pill says it is working, and a second tap is not a second download.
  if (shareStatus.get().active) return

  const controller = new AbortController()
  shareStatus.start(() => controller.abort())
  try {
    const local = await loadedCopyOf(url)
    await downloadImage(local ?? url, filename, {
      signal: controller.signal,
      onProgress: progress => shareStatus.progress(progress),
      // The share sheet is open (or about to be): the pill's work is done, whatever the sheet takes after.
      onReady: () => shareStatus.stop(),
    })
  } catch (e) {
    if (controller.signal.aborted) return          // the person stopped it
    showError('Unable to share', e, 'This file could not be shared. Please try again.')
  } finally {
    shareStatus.stop()
  }
}
