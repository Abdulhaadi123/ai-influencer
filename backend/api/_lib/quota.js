/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The per-account storage quota.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two things put bytes in an account: an upload (/api/storage/upload-url) and
 * saving a generated result (/api/storage/ingest). Both check here before any
 * bytes move. The worker does not — it only ever stores results the user
 * already paid the generator for, and refusing those would lose them when the
 * generator's link expires.
 *
 * The count is `assets.byte_size`, which only the backend writes, and uploads
 * are signed for their exact length.
 */

import { one } from './db.js'

/** Total bytes one account may hold. Default 5 GB. */
export const QUOTA_BYTES = Number(process.env.USER_STORAGE_QUOTA_BYTES || 5 * 1024 * 1024 * 1024)

export const QUOTA_EXCEEDED_RESPONSE = Object.freeze({
  error: 'You have run out of storage. Delete something to free space.',
  code: 'QUOTA_EXCEEDED',
})

export async function usedBytes(userId) {
  const row = await one('select coalesce(sum(byte_size), 0)::bigint as used from assets where user_id = $1', [userId])
  return Number(row?.used || 0)
}

/** @returns {Promise<boolean>} whether storing `extraBytes` more would pass the quota */
export async function wouldExceedQuota(userId, extraBytes) {
  return (await usedBytes(userId)) + Number(extraBytes || 0) > QUOTA_BYTES
}
