/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Making a generated result permanent — one implementation for both platforms.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * KIE deletes its result URLs roughly 24 hours after completion, so a result is
 * not really the user's until the bytes are somewhere we control.
 *
 * This used to be two files. Web was a passthrough — it stored the expiring KIE
 * URL and the media quietly died a day later. Native downloaded the file into
 * the app's document directory, which worked but tied the result to one
 * install: reinstall the app or pick up a different phone and it was gone, and
 * nothing was backed up.
 *
 * Now both ask the server to copy the file into the user's own S3 space. The
 * bytes never travel through the device at all, which means a phone that dies
 * mid-download does not lose work that was already paid for, and the same
 * result is available on every device the user signs in to.
 *
 * The return value changed with it. Callers used to get a URI to store; they
 * now get an `assetId` — the durable reference — plus a `url` that is a signed,
 * short-lived link for showing it immediately. Storing the url would recreate
 * the original bug, so it is deliberately not the primary return.
 */

import { ingestRemote, resolveUrl } from '../data/assets'

/**
 * Copy a generated file into permanent storage.
 *
 * @param {object} input
 * @param {string} input.sourceUrl      the expiring URL from the generator
 * @param {'image'|'video'} input.kind
 * @param {string} [input.influencerId] links the file to an influencer so it is
 *                                      swept when that influencer is deleted
 * @returns {Promise<{assetId: string, url: string|null}>}
 */
export async function persistGenerated({ sourceUrl, kind = 'image', influencerId = null }) {
  if (!sourceUrl) throw new Error('persistGenerated needs a sourceUrl')

  const { assetId } = await ingestRemote({ sourceUrl, kind, influencerId })

  // Resolved here so the calling screen can show the result straight away
  // without a second round trip.
  const url = await resolveUrl(assetId)

  return { assetId, url }
}

/**
 * A filename to offer when the user saves or shares.
 *
 * Purely cosmetic now — it names the download, it does not name the object.
 * S3 keys are generated server-side from the asset id so nothing a user types
 * can influence where a file lands.
 */
export function mediaFilename(kind, id, ext) {
  return `${kind}_${id}.${ext}`
}
