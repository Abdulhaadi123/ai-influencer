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
 * The count comes from `assets.byte_size`, which clients cannot write
 * (migration 0003), and uploads are signed for their exact length.
 */

/** Total bytes one account may hold. Default 5 GB. */
export const QUOTA_BYTES = Number(process.env.USER_STORAGE_QUOTA_BYTES || 5 * 1024 * 1024 * 1024)

export const QUOTA_EXCEEDED_RESPONSE = Object.freeze({
  error: 'You have run out of storage. Delete something to free space.',
  code: 'QUOTA_EXCEEDED',
})

/** @returns {Promise<boolean>} whether storing `extraBytes` more would pass the quota */
export async function wouldExceedQuota(db, userId, extraBytes) {
  const { data, error } = await db.rpc('user_storage_bytes', { p_user_id: userId })
  if (error) throw error
  return Number(data || 0) + Number(extraBytes || 0) > QUOTA_BYTES
}
