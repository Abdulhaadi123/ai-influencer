/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Persisting generated media — REACT NATIVE implementation.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * KIE deletes generated files within 24 hours to 3 days, so storing its URL
 * means the media disappears from history a day later. Everything generated is
 * copied onto the device instead, and the local URI is what gets saved.
 *
 * Written to the DOCUMENT directory, not the cache directory: the OS may purge
 * the cache whenever it likes, which would reintroduce the same bug.
 */

import { File, Directory, Paths } from 'expo-file-system'

const FOLDER = 'generated'

function mediaDir() {
  const dir = new Directory(Paths.document, FOLDER)
  if (!dir.exists) dir.create({ intermediates: true })
  return dir
}

function safeName(name) {
  return (name || `media_${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96)
}

/**
 * Download a generated file and return a permanent local URI.
 *
 * Best-effort: if the download fails the original URL is returned, so a
 * generation is never lost outright — it just keeps the old expiring behaviour
 * for that one item rather than throwing away the result.
 *
 * @param {string} url       remote media URL
 * @param {string} filename  suggested filename, extension included
 * @returns {Promise<string>} local file:// URI, or the original url on failure
 */
export async function persistMedia(url, filename) {
  if (!url || !url.startsWith('http')) return url

  try {
    const target = new File(mediaDir(), safeName(filename))
    if (target.exists) target.delete()

    const saved = await File.downloadFileAsync(url, target, { idempotent: true })
    return saved.uri
  } catch (e) {
    console.warn('[persistMedia] could not save locally, keeping remote URL:', e?.message ?? e)
    return url
  }
}

/** Build a stable, unique filename for a generated item. */
export function mediaFilename(kind, id, ext) {
  return `${kind}_${id}.${ext}`
}
