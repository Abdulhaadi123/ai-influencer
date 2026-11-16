/**
 * POST /api/account/delete  { password } → { deletedObjects }
 *                           { oauth: { provider, idToken, nonce?, authorizationCode? } } → { deletedObjects }
 *
 * Permanently delete the caller's account and everything in it. Both app stores
 * require this of any app that lets people create an account.
 *
 * The password is checked here, on the server: a phone left unlocked and signed
 * in must not be enough to wipe someone's work. An account made with Google or Apple has no
 * password, so it proves itself the way it signed in: a FRESH sign-in, which must be the account's own.
 *
 * Apple adds one duty: an app that offers Sign in with Apple must revoke the person's Apple
 * tokens when it deletes their account (App Store guideline 5.1.1(v)). The fresh Apple sign-in
 * brings a one-time authorization code for exactly that (api/_lib/oauth/apple.js). Revoking is
 * best effort — it never stands between a person and the deletion of their account — and its
 * outcome goes to the log.
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
import { revokeAppleSignIn } from '../_lib/oauth/apple.js'
import { checkPasswordForUser } from '../auth/account.js'
import { verifyOauthProof, providerLabel } from '../auth/oauth.js'

export default userRoute(async (req, res, user) => {
  const password = req.body?.password
  const oauth = req.body?.oauth

  if (typeof password === 'string' && password) {
    if (!(await checkPasswordForUser(user, password))) {
      throw new HttpError(403, 'Incorrect password.', 'WRONG_PASSWORD')
    }
  } else if (oauth && typeof oauth === 'object') {
    // An account made with Google or Apple has no password to type, so it proves itself the way it signed in:
    // a fresh sign-in, and it must be THIS account's identity, not just any Google or Apple account.
    const proof = await verifyOauthProof(req, oauth.provider, oauth.idToken, { nonce: oauth.nonce })
    const theirs = await one(
      'select 1 from auth_identities where user_id = $1 and provider = $2 and subject = $3',
      [user.id, proof.provider, proof.subject],
    )
    if (!theirs) throw new HttpError(403, `That ${providerLabel(proof.provider)} account is not the one this account signs in with.`, 'WRONG_ACCOUNT')

    if (proof.provider === 'apple') {
      const outcome = await revokeAppleSignIn(oauth.authorizationCode)
      if (!outcome.revoked) console.warn(`[account/delete] Apple sign-in not revoked for account ${user.id}: ${outcome.reason}`)
    }
  } else {
    const row = await one('select password_hash from users where id = $1', [user.id])
    if (row?.password_hash) throw badRequest('Enter your password to continue.', 'PASSWORD_REQUIRED')
    // No password: say which sign-in will do, the most recently used one if there are two.
    const identity = await one('select provider from auth_identities where user_id = $1 order by last_used_at desc limit 1', [user.id])
    const label = providerLabel(identity?.provider)
    throw badRequest(label ? `Sign in with ${label} again to confirm.` : 'Sign in again to confirm.', 'REAUTH_REQUIRED')
  }

  const deletedObjects = await deleteUserObjects(user.id)
  await query('delete from users where id = $1', [user.id])

  console.log(`[account/delete] deleted account ${user.id} and ${deletedObjects} stored file(s)`)
  res.json({ deletedObjects })
}, { tag: '[account/delete]', message: 'Unable to delete your account. Please try again.' })
