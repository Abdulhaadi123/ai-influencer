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
 * Unlike the web version this is async — existing callers fire it without
 * awaiting, which is still correct.
 */
export async function downloadImage(src, filename = 'image.jpg') {
  try {
    if (!(await Sharing.isAvailableAsync())) {
      console.warn('[media] sharing is not available on this device')
      return
    }

    let file

    if (src.startsWith('data:')) {
      const base64 = src.slice(src.indexOf(',') + 1)
      file = new File(Paths.cache, safeName(filename))
      if (file.exists) file.delete()
      file.create()
      file.write(base64, { encoding: 'base64' })
    } else if (src.startsWith('http')) {
      // Straight from the CDN — no need for the web build's img-proxy, since
      // there is no browser CORS policy to work around here.
      file = await File.downloadFileAsync(src, new File(Paths.cache, safeName(filename)), {
        idempotent: true,
      })
    } else if (src.startsWith('file:')) {
      // Already on the device. persistMedia copies every generated result to
      // the documents directory because KIE's URLs expire within a day, so by
      // the time the user taps Save or share the source is a local path — this
      // branch used to be missing and every share silently warned instead.
      //
      // Copied into the cache first so the share sheet offers the caller's
      // readable filename rather than the internal one (video_mfz1x9.mp4).
      const source = new File(src)
      if (!source.exists) {
        console.warn('[media] file has gone missing:', src.slice(0, 64))
        return
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
      console.warn('[media] unsupported source for download:', src.slice(0, 32))
      return
    }

    await Sharing.shareAsync(file.uri)
  } catch (e) {
    console.warn('[media] download/share failed:', e?.message ?? e)
  }
}

function safeName(name) {
  return (name || 'image.jpg').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96)
}
