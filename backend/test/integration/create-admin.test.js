// db/create-admin.js — how the first administrator is made, on the server.
//
// The function is tested in-process; the command line (stdin, exit codes, what is printed and what is
// not) is tested by running the script itself against the same database.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { startStack } from '../helpers/stack.js'

const BACKEND = fileURLToPath(new URL('../../', import.meta.url))
const PASSWORD = 'a-long-first-admin-password-1'

let stack
let makeAdmin, MakeAdminError, parseInput, verifyPassword

before(async () => {
  stack = await startStack({ env: { PUBLIC_BASE_URL: 'https://api.test.example' } })
  ;({ makeAdmin, MakeAdminError, parseInput } = await stack.load('db/create-admin.js'))
  ;({ verifyPassword } = await stack.load('api/_lib/passwords.js'))
})
after(async () => { await stack?.stop() })
beforeEach(() => stack.reset())

const userBy = email => stack.one('select * from users where lower(email) = lower($1)', [email])
const login = (email, password, scope) => stack.api('POST', '/api/auth/login', { body: { email, password, ...(scope ? { scope } : {}) }, headers: { 'x-forwarded-for': `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } })
const auditRows = () => stack.sql(`select admin_id, admin_email, action, target_id, details from admin_audit_log where action = 'admin.console-make-admin' order by id`)

test('a new administrator: created confirmed and active, signs in to the panel and nowhere else, and the log says who made it', async () => {
  const made = await makeAdmin({ email: '  First.Admin@Test.Example ', password: PASSWORD })
  assert.equal(made.created, true)
  assert.equal(made.passwordSet, true)
  assert.equal(made.email, 'first.admin@test.example', 'stored the way sign-in looks it up')

  const row = await userBy('first.admin@test.example')
  assert.equal(row.role, 'admin')
  assert.equal(row.status, 'active')
  assert.ok(row.email_confirmed_at, 'confirmed: nothing has to arrive by email')
  assert.ok(await verifyPassword(row.password_hash, PASSWORD))
  assert.ok(!row.password_hash.includes(PASSWORD))

  const panel = await login('first.admin@test.example', PASSWORD, 'admin')
  assert.equal(panel.status, 200)
  assert.equal((await stack.api('GET', '/api/admin/stats', { token: panel.body.session.accessToken })).status, 200)
  const app = await login('first.admin@test.example', PASSWORD)
  assert.equal(app.status, 403)
  assert.equal(app.body.code, 'ADMIN_ACCOUNT', 'and the app tells them where to go')

  const [entry] = await auditRows()
  assert.equal(entry.admin_id, row.id)
  assert.equal(entry.target_id, row.id)
  assert.deepEqual(
    [entry.details.created, entry.details.passwordSet, entry.details.by],
    [true, true, 'the server console'],
  )
  assert.ok(!JSON.stringify(entry).includes(PASSWORD), 'no secret in the log')
})

test('an existing account is promoted: confirmed, its password kept unless a new one is given, every old session ended', async () => {
  const mia = await stack.createUser({ email: 'mia@test.example', password: 'mias-own-password-9' })
  await stack.sql(`update users set email_confirmed_at = null where id = $1`, [mia.id])
  assert.equal((await stack.api('GET', '/api/billing/me', { token: mia.token })).status, 200, 'she was using the app')

  const made = await makeAdmin({ email: 'MIA@test.example', password: '' })
  assert.deepEqual([made.created, made.passwordSet], [false, false])

  const row = await userBy('mia@test.example')
  assert.equal(row.role, 'admin')
  assert.ok(row.email_confirmed_at, 'confirmed by whoever has the server')
  assert.ok(await verifyPassword(row.password_hash, 'mias-own-password-9'), 'her password is as it was')
  assert.equal((await stack.api('GET', '/api/billing/me', { token: mia.token })).status, 401, 'her phone is signed out')
  assert.equal((await stack.sql('select count(*)::int as n from sessions where user_id = $1', [mia.id]))[0].n, 0)
  assert.equal((await login('mia@test.example', 'mias-own-password-9', 'admin')).status, 200, 'and she signs in to the panel with it')

  // With a password on the second line, that becomes her password.
  await makeAdmin({ email: 'mia@test.example', password: 'a-brand-new-password-2' })
  const changed = await userBy('mia@test.example')
  assert.ok(await verifyPassword(changed.password_hash, 'a-brand-new-password-2'))
  assert.equal(await verifyPassword(changed.password_hash, 'mias-own-password-9'), false)
  assert.ok(new Date(changed.password_changed_at) > new Date(row.password_changed_at) || changed.password_changed_at !== row.password_changed_at)

  // Run again for an account that is already one: harmless, and still logged.
  const again = await makeAdmin({ email: 'mia@test.example', password: '' })
  assert.deepEqual([again.created, again.passwordSet], [false, false])
  assert.equal((await auditRows()).length, 3)
})

test('what cannot be done is refused, says why, and leaves nothing behind', async () => {
  const suspended = await stack.createUser({ email: 'sleeper@test.example', status: 'suspended' })
  const before = await stack.sql('select id, email, role, status, password_hash from users order by id')

  const refusals = [
    [{ email: '', password: PASSWORD }, /email/i],
    [{ email: 'not-an-email', password: PASSWORD }, /email/i],
    [{ email: 'a@b.co\r\nBcc: x@y.z', password: PASSWORD }, /email/i],
    [{ email: 'new@test.example', password: '' }, /needs? a password|password is needed/i],
    [{ email: 'new@test.example', password: undefined }, /password is needed/i],
    [{ email: 'new@test.example', password: 'short1' }, /at least 10/i],
    [{ email: 'new@test.example', password: 'onlyletterspassword' }, /letter and one number/i],
    [{ email: 'new@test.example', password: 'x1'.repeat(80) }, /128/],
    [{ email: 'new@test.example', password: 'Password123456' }, /too easy/i],
    [{ email: 'sleeper@test.example', password: PASSWORD }, /suspended/i],
    [{ email: suspended.email, password: '' }, /suspended/i],
  ]
  for (const [input, message] of refusals) {
    await assert.rejects(makeAdmin(input), e => e instanceof MakeAdminError && message.test(e.message), JSON.stringify({ ...input, password: input.password && '…' }))
  }
  assert.deepEqual(await stack.sql('select id, email, role, status, password_hash from users order by id'), before, 'no account was created or changed')
  assert.deepEqual(await auditRows(), [])
})

test('the two lines are read as they come, whatever line ending they have', () => {
  assert.deepEqual(parseInput('a@b.co\nsecret-1234567\n'), { email: 'a@b.co', password: 'secret-1234567' })
  assert.deepEqual(parseInput('a@b.co\r\nsecret-1234567\r\n'), { email: 'a@b.co', password: 'secret-1234567' })
  assert.deepEqual(parseInput('a@b.co\n\n'), { email: 'a@b.co', password: '' })
  assert.deepEqual(parseInput('a@b.co'), { email: 'a@b.co', password: '' })
  assert.deepEqual(parseInput(''), { email: '', password: '' })
  assert.deepEqual(parseInput('a@b.co\n pass with spaces 1 \nignored'), { email: 'a@b.co', password: ' pass with spaces 1 ' }, 'spaces in a password count')
})

// ── The command itself ───────────────────────────────────────────────────────

/** Run the command in this process, with these lines on its standard input. */
async function command(input, { tty = false, env = { PUBLIC_BASE_URL: 'https://api.test.example' } } = {}) {
  const { main } = await stack.load('db/create-admin.js')
  const stdin = Readable.from([input])
  if (tty) stdin.isTTY = true
  const out = []
  const err = []
  const code = await main({ stdin, out: line => out.push(line), err: line => err.push(line), env })
  return { code, stdout: out.join('\n'), stderr: err.join('\n') }
}

test('the command: two lines in, an administrator out, exit 0, and nothing secret printed', async () => {
  const res = await command(`cli.admin@test.example\n${PASSWORD}\n`)
  assert.equal(res.code, 0, res.stderr)
  assert.match(res.stdout, /cli\.admin@test\.example is now an administrator \(account created\)/)
  assert.match(res.stdout, /https:\/\/api\.test\.example\/admin/)
  assert.ok(!res.stdout.includes(PASSWORD) && !res.stderr.includes(PASSWORD))
  assert.equal((await login('cli.admin@test.example', PASSWORD, 'admin')).status, 200)

  const promoted = await command('cli.admin@test.example\n\n', { env: {} })
  assert.equal(promoted.code, 0)
  assert.match(promoted.stdout, /existing account, password unchanged/)
  assert.match(promoted.stdout, /\(\/admin\)/, 'with no public address configured it still says where')
})

test('the command: a refusal is exit 1 with the reason, never echoes the password, and creates nothing', async () => {
  const weak = await command('cli.weak@test.example\nshort1\n')
  assert.equal(weak.code, 1)
  assert.match(weak.stderr, /at least 10/)
  assert.ok(!weak.stderr.includes('short1') && !weak.stdout.includes('short1'))
  assert.equal(await userBy('cli.weak@test.example'), null)

  const none = await command('')
  assert.equal(none.code, 1)
  assert.match(none.stderr, /email/i)

  const typed = await command('cli.typed@test.example\n', { tty: true })
  assert.equal(typed.code, 1, 'run by hand with nothing piped in, it explains how instead of waiting')
  assert.match(typed.stderr, /through a pipe/)
  assert.equal(await userBy('cli.typed@test.example'), null)
})

// ── The file run as a command (the parts that need no database) ──────────────

function runFile(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['db/create-admin.js'], { cwd: BACKEND, env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

test('run as `node db/create-admin.js`: a refusal exits 1 with its reason, and a database that cannot be reached exits 2 in plain words', async () => {
  // (A refusal is decided before the database is touched, so this needs none — the embedded test database
  // serves one connection at a time, and the app under test is holding it.)
  const refused = await runFile('someone@test.example\nshort1\n')
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /at least 10/)
  assert.ok(!refused.stderr.includes('short1') && !refused.stdout.includes('short1'))

  const down = await runFile(`down.admin@test.example\n${PASSWORD}\n`, { DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' })
  assert.equal(down.code, 2)
  assert.match(down.stderr, /Could not finish/)
  assert.ok(!down.stderr.includes(PASSWORD) && !down.stdout.includes(PASSWORD))
})
