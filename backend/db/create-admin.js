/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Make an account an administrator — how the first one is made.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The admin panel can promote anyone, but only an administrator can open it, so the first one is made here,
 * on the server (and any later one too, if you would rather not use the panel). From the backend folder:
 *
 *   read -rp "Email: " E; read -rsp "Password: " P; echo
 *   printf '%s\n%s\n' "$E" "$P" | docker compose exec -T api node db/create-admin.js
 *   unset E P
 *
 * The email is the first line and the password the second. The password travels through a pipe, so it is
 * never in a command line, in `ps`, in the shell history or in a log.
 *
 *   • No account has that email: one is created — confirmed, active, an administrator. A password is required
 *     (the rules are the same as everywhere: 10 to 128 characters, a letter and a number).
 *   • An account has it: that account is made an administrator and confirmed. A password on the second line
 *     replaces its password; an empty second line keeps the one it has. A suspended account is refused — it
 *     was suspended for a reason, so restore it first.
 *
 * Every session the account holds is ended: a session belongs to the app or to the panel, and the account has
 * just changed which of the two it is for. An administrator signs in at /admin and never in the app.
 *
 * The change is written to the audit log, as the doing of the server console.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { transaction, closeDb } from '../api/_lib/db.js'
import { audit } from '../api/_lib/admin.js'
import { normalizeEmail, emailProblem } from '../api/_lib/validate.js'
import { passwordProblem, hashPassword } from '../api/_lib/passwords.js'

/** Something the person running this can put right; its message is for them. */
export class MakeAdminError extends Error {}

/**
 * @param {{email: string, password?: string}} who
 * @returns {Promise<{id: string, email: string, created: boolean, passwordSet: boolean}>}
 * @throws {MakeAdminError}
 */
export async function makeAdmin({ email: rawEmail, password: rawPassword }) {
  const email = normalizeEmail(rawEmail)
  const emailFault = emailProblem(email)
  if (emailFault) throw new MakeAdminError(emailFault)

  const password = typeof rawPassword === 'string' && rawPassword !== '' ? rawPassword : null
  if (password) {
    const fault = passwordProblem(password)
    if (fault) throw new MakeAdminError(`That password is not accepted. ${fault}`)
  }
  const passwordHash = password ? await hashPassword(password) : null

  return transaction(async client => {
    const { rows } = await client.query('select id, status from users where lower(email) = $1 for update', [email])
    const existing = rows[0]

    let id
    if (existing) {
      if (existing.status !== 'active') {
        throw new MakeAdminError('That account is suspended. Restore it first (in the panel, or with a different administrator), then run this again.')
      }
      id = existing.id
      await client.query(
        `update users
            set role = 'admin', email_confirmed_at = coalesce(email_confirmed_at, now())
                ${passwordHash ? ', password_hash = $2, password_changed_at = now()' : ''}
          where id = $1`,
        passwordHash ? [id, passwordHash] : [id],
      )
    } else {
      if (!passwordHash) throw new MakeAdminError('There is no account with that email, so a password is needed to create one (the second line).')
      const created = await client.query(
        `insert into users (email, password_hash, display_name, email_confirmed_at, role, status)
         values ($1, $2, 'Administrator', now(), 'admin', 'active')
         returning id`,
        [email, passwordHash],
      )
      id = created.rows[0].id
    }

    await client.query('delete from sessions where user_id = $1', [id])
    const result = { id, email, created: !existing, passwordSet: !!passwordHash }
    await audit(
      { id, email }, 'admin.console-make-admin',
      { targetType: 'user', targetId: id, details: { email, created: result.created, passwordSet: result.passwordSet, by: 'the server console' } },
      client,
    )
    return result
  })
}

/** The two lines the script is given. A Windows line ending does no harm. */
export function parseInput(text) {
  const [email = '', password = ''] = String(text).split(/\r?\n/)
  return { email, password }
}

const USAGE = `Give the email on the first line and the password on the second, through a pipe:

  read -rp "Email: " E; read -rsp "Password: " P; echo
  printf '%s\\n%s\\n' "$E" "$P" | docker compose exec -T api node db/create-admin.js
  unset E P
`

/**
 * The command: read the two lines, make the administrator, say what was done. Returns the exit code —
 * 0 done, 1 something to put right (said in words), 2 something broke. (The streams are parameters so that
 * a test can run it in the process that holds the test database.)
 */
export async function main({ stdin = process.stdin, out = console.log, err = console.error, env = process.env } = {}) {
  if (stdin.isTTY) {
    err(USAGE)
    return 1
  }
  let text = ''
  for await (const chunk of stdin) text += chunk

  try {
    const result = await makeAdmin(parseInput(text))
    const base = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
    out(
      `${result.email} is now an administrator (${result.created ? 'account created' : 'existing account'}` +
      `${result.passwordSet ? (result.created ? '' : ', password changed') : ', password unchanged'}).`,
    )
    out(`Administrators sign in to the panel${base ? ` at ${base}/admin` : ' (/admin)'}, not in the app.`)
    return 0
  } catch (e) {
    if (e instanceof MakeAdminError) {
      err(e.message)
      return 1
    }
    err(`Could not finish: ${e?.message ?? e}`)
    return 2
  }
}

// `node db/create-admin.js`
const entry = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : ''
if (entry && entry === fileURLToPath(import.meta.url).toLowerCase()) {
  main()
    .then(async code => { await closeDb(); process.exit(code) })
    .catch(e => { console.error(e?.message ?? e); process.exit(2) })
}
