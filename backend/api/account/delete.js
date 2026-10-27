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

import { one, query } from '../_lib/db.js'
import { userRoute, badRequest, HttpError } from '../_lib/http.js'
import { deleteUserObjects } from '../_lib/s3.js'
import { checkPasswordForUser } from '../auth/account.js'
import { verifyOauthProof } from '../auth/oauth.js'

export default userRoute(async (req, res, user) => {
  const password = req.body?.password
  const oauth = req.body?.oauth

  if (typeof password === 'string' && password) {
    if (!(await checkPasswordForUser(user, password))) {
      throw new HttpError(403, 'Incorrect password.', 'WRONG_PASSWORD')
    }
  } else if (oauth && typeof oauth === 'object') {
    // An account made with Google has no password to type, so it proves itself the way it signed in:
    // a fresh Google sign-in, and it must be THIS account's Google identity, not just any Google account.
    const proof = await verifyOauthProof(req, oauth.provider, oauth.idToken)
    const theirs = await one(
      'select 1 from auth_identities where user_id = $1 and provider = $2 and subject = $3',
      [user.id, proof.provider, proof.subject],
    )
    if (!theirs) throw new HttpError(403, 'That Google account is not the one this account signs in with.', 'WRONG_ACCOUNT')
  } else {
    const row = await one('select password_hash from users where id = $1', [user.id])
    throw row?.password_hash
      ? badRequest('Enter your password to continue.', 'PASSWORD_REQUIRED')
      : badRequest('Sign in with Google again to confirm.', 'REAUTH_REQUIRED')
  }

  const deletedObjects = await deleteUserObjects(user.id)
  await query('delete from users where id = $1', [user.id])

  console.log(`[account/delete] deleted account ${user.id} and ${deletedObjects} stored file(s)`)
  res.json({ deletedObjects })
}, { tag: '[account/delete]', message: 'Unable to delete your account. Please try again.' })
