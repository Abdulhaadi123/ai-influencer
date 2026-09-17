/**
 * POST /api/account/delete
 *
 * Permanently delete the caller's account and everything in it. Both app stores
 * require this of any app that lets people create an account.
 *
 * ── Order ────────────────────────────────────────────────────────────────────
 *
 * Files first, then the auth user. Deleting the auth user cascades to every row
 * the user owns — every table references auth.users on delete cascade — but it
 * cannot reach S3. The other way round, a failure after the rows were gone would
 * leave the files in the bucket with no record of whose they were and no way to
 * retry. If the file sweep fails, nothing has been deleted and the user can try
 * again; if the auth delete fails after it, a retry finds an empty prefix and
 * finishes the job.
 *
 * The user id comes from the verified token, never from the request — see
 * _lib/auth.js. The app re-checks the password before calling this.
 *
 * Body: none → { deletedObjects }
 */

import { requireUser, adminClient, applyCors } from '../_lib/auth.js'
import { sendServerError } from '../_lib/errors.js'
import { deleteUserObjects } from '../_lib/s3.js'

export default async function handler(req, res) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const user = await requireUser(req, res)
  if (!user) return

  try {
    const deletedObjects = await deleteUserObjects(user.id)

    const { error } = await adminClient().auth.admin.deleteUser(user.id)
    if (error) throw error

    console.log(`[account/delete] deleted account ${user.id} and ${deletedObjects} stored file(s)`)
    return res.status(200).json({ deletedObjects })
  } catch (e) {
    return sendServerError(res, e, { tag: '[account/delete]', message: 'Could not finish deleting the account. Please try again.' })
  }
}
