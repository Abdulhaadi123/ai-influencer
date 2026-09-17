/**
 * POST /api/account/delete  { password } → { deletedObjects }
 *
 * Permanently delete the caller's account and everything in it. Both app stores
 * require this of any app that lets people create an account.
 *
 * The password is checked here, on the server: a phone left unlocked and signed
 * in must not be enough to wipe someone's work.
 *
 * Files first, then the user. Deleting the user cascades to every row they own
 * — sessions included, so every device is signed out — but it cannot reach S3.
 * The other order, a failure after the rows were gone would leave files with no
 * record of whose they were. If the sweep fails, nothing has been deleted and
 * the user can try again; if the row delete fails after it, a retry finds an
 * empty prefix and finishes the job.
 */

import { query } from '../_lib/db.js'
import { userRoute, badRequest, HttpError } from '../_lib/http.js'
import { deleteUserObjects } from '../_lib/s3.js'
import { checkPasswordForUser } from '../auth/account.js'

export default userRoute(async (req, res, user) => {
  const password = req.body?.password
  if (typeof password !== 'string' || !password) throw badRequest('Enter your password to confirm.', 'PASSWORD_REQUIRED')

  if (!(await checkPasswordForUser(user, password))) {
    throw new HttpError(403, 'That password is not right.', 'WRONG_PASSWORD')
  }

  const deletedObjects = await deleteUserObjects(user.id)
  await query('delete from users where id = $1', [user.id])

  console.log(`[account/delete] deleted account ${user.id} and ${deletedObjects} stored file(s)`)
  res.json({ deletedObjects })
}, { tag: '[account/delete]', message: 'Could not finish deleting the account. Please try again.' })
