/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Media — REACT NATIVE implementation (see media.js for the web one).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The web module uses an <img> + <canvas> to resize, and an <a download> to
 * save. Neither exists here, so both are rebuilt on Expo modules.
 *
 * Uses the SDK 57 APIs: the contextual ImageManipulator (`manipulate()` ->
 * `renderAsync()` -> `saveAsync()`), NOT the deprecated `manipulateAsync`, and
 * the current `File`/`Paths` file system API rather than the legacy one.
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import { File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'

import { AppError, ERROR_CODES } from '../errors'

/**
 * Resize + compress an image, returning a base64 data URL.
 *
 * Matches the web contract exactly: same argument order and defaults, resolves
 * to a data URL, and falls back to the ORIGINAL input if anything goes wrong
 * rather than rejecting — callers treat this as best-effort.
 *
 * @param {string} source  file:// URI (from the picker) or a base64 data URL
 */
export async function compressImage(source, maxPx = 1400, quality = 0.82) {
  try {
    const context = ImageManipulator.manipulate(source)

    // Render once to learn the real dimensions; the scale factor needs them.
    let image = await context.renderAsync()
    const longestEdge = Math.max(image.width, image.height)

    if (longestEdge > maxPx) {
      const scale = maxPx / longestEdge
      context.resize({
        width: Math.round(image.width * scale),
        height: Math.round(image.height * scale),
      })
      image = await context.renderAsync()
    }

    const result = await image.saveAsync({
      compress: quality,
      format: SaveFormat.JPEG,
      base64: true,
    })

    return result.base64 ? `data:image/jpeg;base64,${result.base64}` : result.uri
  } catch (e) {
    console.warn('[media] compressImage failed, using original:', e?.message ?? e)
    return source
  }
}

/**
 * Hand a generated image or video to the user.
 *
 * "Download" is a desktop idea; the mobile equivalent is the share sheet, which
 * is where Save to Photos / Files also live. Remote files are fetched to the
 * cache first because the sheet needs a local file.
 *
 * Throws an AppError saying what went wrong. It used to swallow every failure
 * into a console warning, so tapping "Save or share" on an expired link, with
 * no connection, or on a device without a share sheet simply did nothing.
 * Callers await it and show the message (src/lib/share.js).
 */
export async function downloadImage(src, filename = 'image.jpg') {
  if (!src) {
    throw new AppError('There is nothing to share yet.', { code: ERROR_CODES.SHARE_FAILED })
  }
  if (!(await Sharing.isAvailableAsync())) {
    throw new AppError('Sharing is not available on this device.', { code: ERROR_CODES.SHARE_FAILED })
  }

  let file

  if (src.startsWith('data:')) {
    try {
      const base64 = src.slice(src.indexOf(',') + 1)
      file = new File(Paths.cache, safeName(filename))
      if (file.exists) file.delete()
      file.create()
      file.write(base64, { encoding: 'base64' })
    } catch (e) {
      console.warn('[media] could not write the file to share:', e?.message ?? e)
      throw new AppError('The file could not be prepared for sharing. Please check the available storage on your device.', {
        code: ERROR_CODES.SHARE_FAILED, cause: e,
      })
    }
  } else if (src.startsWith('http')) {
    try {
      // Straight from storage — no need for the web build's img-proxy, since
      // there is no browser CORS policy to work around here.
      const target = new File(Paths.cache, safeName(filename))
      if (target.exists) target.delete()
      file = await File.downloadFileAsync(src, target, { idempotent: true })
    } catch (e) {
      console.warn('[media] download failed:', e?.message ?? e)
      throw new AppError('The file could not be downloaded. Please check your connection and try again.', {
        code: ERROR_CODES.SHARE_FAILED, cause: e,
      })
    }
  } else if (src.startsWith('file:')) {
    // Copied into the cache first so the share sheet offers the caller's
    // readable filename rather than the internal one.
    const source = new File(src)
    if (!source.exists) {
      throw new AppError('This file is no longer available on this device.', { code: ERROR_CODES.SHARE_FAILED })
    }
    try {
      const target = new File(Paths.cache, safeName(filename))
      if (target.exists) target.delete()
      source.copy(target)
      file = target
    } catch {
      // A rename is a convenience, not the point — share the original.
      file = source
    }
  } else {
    console.warn('[media] unsupported source for sharing:', src.slice(0, 32))
    throw new AppError('This file cannot be shared.', { code: ERROR_CODES.SHARE_FAILED })
  }

  try {
    await Sharing.shareAsync(file.uri)
  } catch (e) {
    console.warn('[media] share sheet failed:', e?.message ?? e)
    throw new AppError('The share sheet could not be opened. Please try again.', {
      code: ERROR_CODES.SHARE_FAILED, cause: e,
    })
  }
}

function safeName(name) {
  return (name || 'image.jpg').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96)
}
