/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Reports — "this result is inappropriate".
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A person flags something the app generated for them. The report goes to the
 * studio's moderation queue; it costs the reporter nothing and is never held
 * against them. Google Play expects an AI app to offer this.
 *
 * Only the reporter's own gallery can be reported (the server answers "not found"
 * for anything else), so the id is a gallery entry's `id` — the same one used to
 * delete it.
 */

import { apiFetch } from '../api/client'

/**
 * The reasons offered. The ids are the server's (backend/api/reports/index.js
 * REPORT_REASONS) — a different one is refused — so change both together.
 */
export const REPORT_REASONS = Object.freeze([
  { id: 'sexual', label: 'Sexual content' },
  { id: 'violence', label: 'Violence or gore' },
  { id: 'hateful', label: 'Hateful or abusive' },
  { id: 'other', label: 'Something else' },
])

/**
 * @param {object} args
 * @param {string} args.generationId  a gallery entry's id
 * @param {string} args.reason        one of REPORT_REASONS' ids
 * @param {string} [args.note]
 * @returns {Promise<void>}
 */
export async function report({ generationId, reason, note = null }) {
  await apiFetch('/api/reports', {
    method: 'POST',
    body: { generationId, reason, ...(note ? { note } : {}) },
  })
}
