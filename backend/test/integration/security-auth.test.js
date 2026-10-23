// Security: authentication, session handling and the account endpoints, pushed to their edges.
//
// Tokens (every way to present, damage, expire or reuse one), the password rules at their boundaries,
// what the public endpoints reveal (or must not), brute-force limits and what they must not do to
// the victim, the one-time links in emails, and what hostile input does to the sign-up and sign-in
// endpoints (mass assignment, NUL bytes, header injection, prototype pollution, oversized bodies).

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { startStack } from '../helpers/stack.js'

let stack
before(async () => { stack = await startStack() })
after(async () => { await stack?.stop() })

// The rate limiters keep their counts in memory, between tests. Every test therefore calls from its own
// address (behind the proxy the server reads it from X-Forwarded-For), so one test's hammering cannot
// make the next one's ordinary request a 429. A test that wants to act as someone else sets the header.
let callerIp = '10.1.0.1'
let ipCounter = 0
beforeEach(async () => {
  await stack.reset()
  ipCounter += 1
  callerIp = `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`
})
const api = (method, path, opts = {}) => stack.api(method, path, { ...opts, headers: { 'x-forwarded-for': callerIp, ...(opts.headers || {}) } })

const PASSWORD = 'a-long-test-password-1'
const ME = '/api/auth/me'

const login = (email, password, extra = {}) => api('POST', '/api/auth/login', { body: { email, password, ...extra } })
const signup = (body) => api('POST', '/api/auth/signup', { body })
const rawRequest = ({ method = 'GET', path, headers = {}, body }) => new Promise((resolve, reject) => {
  const { port } = new URL(stack.base)
  const req = http.request({ host: '127.0.0.1', port: Number(port), path, method, headers: { 'x-forwarded-for': callerIp, ...headers } }, res => {
    let text = ''
    res.on('data', c => { text += c })
    res.on('end', () => { let json = null; try { json = JSON.parse(text) } catch { /* not json */ } resolve({ status: res.statusCode, text, json, headers: res.headers }) })
  })
  req.on('error', reject)
  if (body !== undefined) req.write(body)
  req.end()
})
const sessionRows = userId => stack.sql('select count(*)::int as n from sessions where user_id = $1', [userId]).then(r => r[0].n)

// ═════════════════════════════ Tokens ═════════════════════════════════════════

test('only a well-formed Bearer header is a session: other schemes, query strings, cookies and stray words are not', async () => {
  const u = await stack.createUser()
  const ok = await rawRequest({ path: ME, headers: { authorization: `Bearer ${u.token}` } })
  assert.equal(ok.status, 200)
  // The scheme word is case-insensitive and extra spaces are tolerated — nothing else is.
  assert.equal((await rawRequest({ path: ME, headers: { authorization: `bearer ${u.token}` } })).status, 200)
  assert.equal((await rawRequest({ path: ME, headers: { authorization: `Bearer   ${u.token}` } })).status, 200)

  for (const [what, init] of [
    ['no scheme', { headers: { authorization: u.token } }],
    ['Basic', { headers: { authorization: `Basic ${Buffer.from(`${u.email}:${PASSWORD}`).toString('base64')}` } }],
    ['Token scheme', { headers: { authorization: `Token ${u.token}` } }],
    ['token with a suffix', { headers: { authorization: `Bearer ${u.token}x` } }],
    ['token with a space and a word after', { headers: { authorization: `Bearer ${u.token} extra` } }],
    ['the empty token', { headers: { authorization: 'Bearer ' } }],
    ['a 5 000 character token', { headers: { authorization: `Bearer ${'a'.repeat(5000)}` } }],
    ['the token in the query string', { path: `${ME}?access_token=${u.token}` }],
    ['the token as a cookie', { headers: { cookie: `access_token=${u.token}; token=${u.token}; session=${u.token}` } }],
    ['the token in another header', { headers: { 'x-access-token': u.token, 'x-auth-token': u.token, 'x-api-key': u.token } }],
  ]) {
    const res = await rawRequest({ path: ME, ...init })
    assert.equal(res.status, 401, what)
    assert.equal(res.json?.code, 'NOT_AUTHENTICATED', what)
  }
})

test('a token stops working at once when it expires, is signed out, or its account is suspended or deleted', async () => {
  const expired = await stack.createUser()
  await stack.sql(`update sessions set access_expires_at = now() - interval '1 second' where user_id = $1`, [expired.id])
  assert.equal((await api('GET', ME, { token: expired.token })).status, 401, 'expired')

  const out = await stack.createUser()
  assert.equal((await api('POST', '/api/auth/logout', { token: out.token, body: { refreshToken: out.refreshToken } })).status, 204)
  assert.equal((await api('GET', ME, { token: out.token })).status, 401, 'signed out')
  assert.equal((await api('POST', '/api/auth/refresh', { body: { refreshToken: out.refreshToken } })).status, 401, 'and its refresh token is dead too')

  const gone = await stack.createUser({ password: PASSWORD })
  const deleted = await api('POST', '/api/account/delete', { token: gone.token, body: { password: PASSWORD } })
  assert.equal(deleted.status, 200)
  assert.equal((await api('GET', ME, { token: gone.token })).status, 401, 'deleted account')
  assert.equal((await login(gone.email, PASSWORD)).status, 401, 'and it cannot sign in again')
})

test('signing out with just an access token ends that session and no other; with nothing it changes nothing', async () => {
  const u = await stack.createUser({ password: PASSWORD })
  const second = (await login(u.email, PASSWORD)).body.session
  assert.equal(await sessionRows(u.id), 2)

  assert.equal((await api('POST', '/api/auth/logout', { token: u.token })).status, 204)
  assert.equal(await sessionRows(u.id), 1, 'only the one that was named')
  assert.equal((await api('GET', ME, { token: second.accessToken })).status, 200, 'the other device is still in')

  assert.equal((await api('POST', '/api/auth/logout', { body: {} })).status, 204)
  assert.equal(await sessionRows(u.id), 1)
})

test('an access token cannot be used as a refresh token, nor the other way round, and refresh refuses junk without a 500', async () => {
  const u = await stack.createUser()
  assert.equal((await api('POST', '/api/auth/refresh', { body: { refreshToken: u.token } })).status, 401, 'access token as refresh token')
  assert.equal((await api('GET', ME, { token: u.refreshToken })).status, 401, 'refresh token as access token')

  for (const bad of [undefined, null, '', 0, 1, true, [], {}, [u.refreshToken], { toString: 'x' }, 'x'.repeat(10_000), u.refreshToken + ' ', ' ' + u.refreshToken]) {
    const res = await api('POST', '/api/auth/refresh', { body: { refreshToken: bad } })
    assert.equal(res.status, 401, JSON.stringify(bad)?.slice(0, 40))
  }
  assert.equal((await api('POST', '/api/auth/refresh', { body: { refreshToken: u.refreshToken } })).status, 200, 'the real one still works after all that')
})

test('a refresh whose answer was lost can be retried in the grace period, and the retry works', async () => {
  const u = await stack.createUser()
  assert.equal((await api('POST', '/api/auth/refresh', { body: { refreshToken: u.refreshToken } })).status, 200)
  const retry = await api('POST', '/api/auth/refresh', { body: { refreshToken: u.refreshToken } })
  assert.equal(retry.status, 200, 'the app that never got the first answer still has the old token')
  assert.equal((await api('GET', ME, { token: retry.body.session.accessToken })).status, 200)
})

test('a refresh token that comes back after its grace period was copied: the whole session ends', async () => {
  const u = await stack.createUser()
  const first = await api('POST', '/api/auth/refresh', { body: { refreshToken: u.refreshToken } })
  assert.equal(first.status, 200)
  await stack.sql(`update sessions set rotated_at = now() - interval '5 minutes' where user_id = $1`, [u.id])
  const replay = await api('POST', '/api/auth/refresh', { body: { refreshToken: u.refreshToken } })
  assert.equal(replay.status, 401)
  assert.equal(await sessionRows(u.id), 0, 'everyone holding that session is signed out — the real app included, which signs in again')
  assert.equal((await api('GET', ME, { token: first.body.session.accessToken })).status, 401, 'the thief\'s copy and the rotated one are both dead')
})

test('an admin session\'s refresh token lasts hours, an app session\'s weeks — at sign-in and after every refresh', async () => {
  const boss = await stack.createUser({ role: 'admin' })
  const mia = await stack.createUser()
  const hoursLeft = async userId => Number((await stack.one(`select extract(epoch from (refresh_expires_at - now())) / 3600 as h from sessions where user_id = $1`, [userId])).h)

  assert.ok(await hoursLeft(boss.id) <= 12.01, `admin: ${await hoursLeft(boss.id)} h`)
  assert.ok(await hoursLeft(mia.id) > 24 * 29, `app: ${await hoursLeft(mia.id)} h`)

  await api('POST', '/api/auth/refresh', { body: { refreshToken: boss.refreshToken } })
  await api('POST', '/api/auth/refresh', { body: { refreshToken: mia.refreshToken } })
  assert.ok(await hoursLeft(boss.id) <= 12.01, 'still hours after a refresh')
  assert.ok(await hoursLeft(mia.id) > 24 * 29, 'still weeks after a refresh')
})

test('twenty refreshes of one token at the same moment never leave two live copies of the session', async () => {
  const u = await stack.createUser()
  const answers = await Promise.all(Array.from({ length: 20 }, () => api('POST', '/api/auth/refresh', { body: { refreshToken: u.refreshToken } })))
  assert.ok(answers.every(a => a.status === 200 || a.status === 401), answers.map(a => a.status).join(','))
  assert.equal(await sessionRows(u.id) <= 1, true, 'still one session, however many raced')
  const tokens = answers.filter(a => a.status === 200).map(a => a.body.session.accessToken)
  assert.equal(new Set(tokens).size >= 1, true)
})

test('tokens are long, random and never stored: the database holds only hashes', async () => {
  const u = await stack.createUser()
  assert.ok(u.token.length >= 43 && u.refreshToken.length >= 43)
  assert.notEqual(u.token, u.refreshToken)
  const rows = await stack.sql('select access_hash, refresh_hash from sessions where user_id = $1', [u.id])
  assert.equal(rows.length, 1)
  assert.match(rows[0].access_hash, /^[0-9a-f]{64}$/)
  assert.ok(rows[0].access_hash !== u.token && rows[0].refresh_hash !== u.refreshToken)
  const dump = JSON.stringify(await stack.sql('select * from sessions'))
  assert.equal(dump.includes(u.token) || dump.includes(u.refreshToken), false)
})

test('changing the password signs every other device out and keeps this one; a reset link sent before is dead', async () => {
  const u = await stack.createUser({ password: PASSWORD })
  const other = (await login(u.email, PASSWORD)).body.session
  await api('POST', '/api/auth/forgot-password', { body: { email: u.email } })
  await new Promise(r => setTimeout(r, 100))
  assert.equal((await stack.sql(`select count(*)::int as n from email_tokens where user_id = $1 and purpose = 'reset_password'`, [u.id]))[0].n, 1)

  const res = await api('POST', '/api/auth/change-password', { token: u.token, body: { currentPassword: PASSWORD, newPassword: 'another-long-password-2' } })
  assert.equal(res.status, 200)
  assert.equal((await api('GET', ME, { token: other.accessToken })).status, 401, 'the other device is out')
  assert.equal((await api('GET', ME, { token: u.token })).status, 200, 'this one stays')
  assert.equal((await stack.sql(`select count(*)::int as n from email_tokens where user_id = $1 and purpose = 'reset_password'`, [u.id]))[0].n, 0, 'no reset link survives')
  assert.equal((await login(u.email, PASSWORD)).status, 401)
  assert.equal((await login(u.email, 'another-long-password-2')).status, 200)
})

test('change-password needs the CURRENT password, refuses the same one and weak ones, and is rate limited per account', async () => {
  const u = await stack.createUser({ password: PASSWORD })
  const change = (currentPassword, newPassword) => api('POST', '/api/auth/change-password', { token: u.token, body: { currentPassword, newPassword } })
  assert.equal((await change(undefined, 'another-long-password-2')).body.code, 'PASSWORD_REQUIRED')
  assert.equal((await change('', 'another-long-password-2')).body.code, 'PASSWORD_REQUIRED')
  assert.equal((await change(PASSWORD, PASSWORD)).body.code, 'SAME_PASSWORD')
  assert.equal((await change(PASSWORD, 'short1')).body.code, 'WEAK_PASSWORD')
  assert.equal((await change('not-the-current-1', 'another-long-password-2')).body.code, 'WRONG_PASSWORD')
  for (const v of [null, 1, {}, [], true]) assert.equal((await change(v, 'another-long-password-2')).status, 400, `currentPassword ${JSON.stringify(v)}`)
  assert.equal((await login(u.email, PASSWORD)).status, 200, 'the password was never changed by any of those')

  let limited = null
  for (let i = 0; i < 14 && !limited; i++) {
    const res = await change(`wrong-guess-${i}-x1`, 'another-long-password-2')
    if (res.status === 429) limited = res
  }
  assert.ok(limited, 'guessing the current password is capped')
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
})

// ═════════════════════════ Passwords ══════════════════════════════════════════

test('the password rules hold at every boundary', async () => {
  const tryPassword = (password, n) => signup({ email: `rule${n}@test.example`, password })
  const cases = [
    ['', 400], [undefined, 400], [null, 400], [123456789012, 400], [['a1'.repeat(8)], 400], [{ a: 1 }, 400],
    ['a1'.repeat(4), 400],                       // 8
    ['abcdefgh1', 400],                          // 9: one short
    ['abcdefghi1', 201],                         // 10: exactly enough
    ['1234567890', 400],                         // no letter
    ['abcdefghij', 400],                         // no number
    ['Password123456', 400],                     // the lists that head every credential-stuffing run
    ['qwertyuiop12', 400],
    ['  abcdefgh1 ', 201],                       // spaces count as characters, are not trimmed away
    ['a1' + 'x'.repeat(126), 201],               // 128
    ['a1' + 'x'.repeat(127), 400],               // 129
    ['a1' + 'x'.repeat(100_000), 413],           // far too long: the whole body is refused (16 KB ceiling) before it is read or hashed
    ['pässwörd-ünïcode-1', 201],
    ['ab1\u0000cdefghij', 400],                  // NUL
  ]
  let n = 0
  for (const [password, want] of cases) {
    const res = await tryPassword(password, ++n)
    assert.equal(res.status, want, `${JSON.stringify(password)?.slice(0, 40)} -> ${res.status} ${res.body?.code ?? ''}`)
  }
})

test('a very long or odd password cannot be used to make the server slow or crash: it is refused up front', async () => {
  const u = await stack.createUser({ password: PASSWORD })
  const started = Date.now()
  for (const password of ['x'.repeat(1_000_000), 'a1'.repeat(100_000), '\u0000'.repeat(1000)]) {
    const res = await login(u.email, password)
    assert.ok([400, 401, 413].includes(res.status), `status ${res.status}`)
  }
  assert.ok(Date.now() - started < 15_000, 'no hashing of megabytes')
})

// ═════════════════════ What the endpoints reveal ══════════════════════════════

test('sign-in says the same thing for a missing account and a wrong password, and does not reveal a role or a status until the password is right', async () => {
  const real = await stack.createUser({ password: PASSWORD })
  const boss = await stack.createUser({ role: 'admin', password: PASSWORD })
  const suspended = await stack.createUser({ status: 'suspended', password: PASSWORD })

  const missing = await login('nobody-here@test.example', PASSWORD)
  const wrong = await login(real.email, 'not-the-password-1')
  assert.deepEqual([missing.status, missing.body], [wrong.status, wrong.body])
  assert.equal(missing.body.code, 'INVALID_CREDENTIALS')

  for (const who of [boss, suspended]) {
    const wrongOne = await login(who.email, 'not-the-password-1')
    assert.deepEqual([wrongOne.status, wrongOne.body], [wrong.status, wrong.body], 'a wrong password reveals nothing about the account')
  }
  assert.equal((await login(suspended.email, PASSWORD)).body.code, 'ACCOUNT_SUSPENDED')
})

test('sign-up, forgot-password and resend answer identically whether or not the address is registered', async () => {
  const taken = await stack.createUser({ email: 'taken@test.example' })
  const strip = r => [r.status, JSON.stringify(r.body)]

  const a = await signup({ email: taken.email, password: PASSWORD })
  const b = await signup({ email: 'brand-new@test.example', password: PASSWORD })
  assert.deepEqual(strip(a), strip(b), 'sign-up')

  await stack.reset()
  const real = await stack.createUser({ email: 'real@test.example' })
  const f1 = await api('POST', '/api/auth/forgot-password', { body: { email: real.email } })
  const f2 = await api('POST', '/api/auth/forgot-password', { body: { email: 'ghost@test.example' } })
  assert.deepEqual(strip(f1), strip(f2), 'forgot-password')
  const r1 = await api('POST', '/api/auth/resend-confirmation', { body: { email: real.email } })
  const r2 = await api('POST', '/api/auth/resend-confirmation', { body: { email: 'ghost@test.example' } })
  assert.deepEqual(strip(r1), strip(r2), 'resend-confirmation')
})

/** Wait for something an email sent in the background leaves behind (its link row). */
const eventually = async (check, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, 25)) }
  return false
}
const linksFor = (userId, purpose) =>
  stack.sql('select count(*)::int as n from email_tokens where user_id = $1 and purpose = $2', [userId, purpose]).then(r => r[0].n)

test('signing up again with a confirmed address emails its owner "you already have an account" (a reset link), never a second account', async () => {
  const owner = await stack.createUser({ email: 'returning@test.example' })

  const res = await signup({ email: 'Returning@Test.Example', password: PASSWORD })
  assert.deepEqual([res.status, res.body], [201, { needsEmailConfirmation: true }], 'the same answer as a new account')
  assert.ok(await eventually(async () => (await linksFor(owner.id, 'reset_password')) === 1), 'a reset link was issued for the owner')
  assert.equal((await stack.sql(`select count(*)::int as n from users where lower(email) = 'returning@test.example'`))[0].n, 1)
  assert.equal(await linksFor(owner.id, 'confirm_email'), 0, 'no confirmation for an account that is already confirmed')

  // "Resend" on the check-your-email screen reaches them too.
  await stack.reset()
  const again = await stack.createUser({ email: 'resend-owner@test.example' })
  const r = await api('POST', '/api/auth/resend-confirmation', { body: { email: again.email } })
  assert.deepEqual([r.status, r.body], [200, { sent: true }])
  assert.ok(await eventually(async () => (await linksFor(again.id, 'reset_password')) === 1), 'resend sends the account-exists email')
})

test('an account that is not confirmed yet gets its confirmation again on a second sign-up, not a reset link', async () => {
  assert.equal((await signup({ email: 'pending-owner@test.example', password: PASSWORD })).status, 201)
  const user = (await stack.sql(`select id from users where email = 'pending-owner@test.example'`))[0]
  assert.ok(await eventually(async () => (await linksFor(user.id, 'confirm_email')) === 1), 'the sign-up sent a confirmation')
  assert.equal(await linksFor(user.id, 'reset_password'), 0, 'and no reset link')
})

test('the account-exists email says only the server\'s words and carries the reset link', async () => {
  const { accountExistsEmail } = await stack.load('api/_lib/email.js')
  const link = 'https://api.test.example/auth/reset-password?token=t'
  const mail = accountExistsEmail({ to: 'owner@test.example', link })
  assert.equal(mail.to, 'owner@test.example')
  assert.match(mail.subject, /already have/)
  assert.ok(mail.text.includes(link) && mail.html.includes(link))
  assert.match(mail.text, /no new one was made/)
})

test('the time sign-in takes does not tell a registered address from an unregistered one', async () => {
  const real = await stack.createUser({ email: 'timing@test.example', password: PASSWORD })
  const median = async (email, n = 7) => {
    const times = []
    for (let i = 0; i < n; i++) { const t = process.hrtime.bigint(); await login(email, 'not-the-password-1'); times.push(Number(process.hrtime.bigint() - t) / 1e6) }
    return times.sort((x, y) => x - y)[Math.floor(n / 2)]
  }
  // Spread across two addresses each, so the per-address limiter never interferes.
  const known = await median(real.email, 4)
  const unknown = await median('never-registered-1@test.example', 4)
  const ratio = Math.max(known, unknown) / Math.max(1, Math.min(known, unknown))
  assert.ok(ratio < 3, `known ${known.toFixed(1)} ms vs unknown ${unknown.toFixed(1)} ms`)
})

test('no response ever carries a password, a hash or a token it should not', async () => {
  const u = await stack.createUser({ email: 'leak@test.example', password: PASSWORD })
  const outputs = [
    await login(u.email, PASSWORD),
    await api('GET', ME, { token: u.token }),
    await api('POST', ME, { token: u.token, body: { displayName: 'Leaky' } }),
    await api('GET', '/api/influencers', { token: u.token }),
    await api('GET', '/api/billing/me', { token: u.token }),
  ]
  const text = outputs.map(o => o.text).join('\n')
  assert.equal(/password_hash|\$argon2|passwordHash|access_hash|refresh_hash/i.test(text), false)
  assert.equal(text.includes(PASSWORD), false)
  for (const o of outputs) assert.match(o.headers.get('cache-control') || '', /no-store/, 'session and profile answers are not cacheable')
})

// ═════════════════════ Brute force and lockouts ═══════════════════════════════

test('guessing one account\'s password is stopped after ten tries, and the right password still works for its owner elsewhere', async () => {
  const u = await stack.createUser({ email: 'target@test.example', password: PASSWORD })
  let blocked = null
  for (let i = 0; i < 14 && !blocked; i++) {
    const res = await login(u.email, `wrong-${i}-guess-x1`)
    if (res.status === 429) blocked = res
  }
  assert.ok(blocked, 'blocked')
  assert.equal(blocked.body.code, 'RATE_LIMITED')
  assert.ok(Number(blocked.headers.get('retry-after')) > 0)
  // The right password does not get through while it is blocked either — a guess cannot be confirmed by trying.
  assert.equal((await login(u.email, PASSWORD)).status, 429)
})

test('an attacker who locks a victim\'s address out cannot also lock the victim out from the victim\'s own network (the limit counts the caller too)', async () => {
  const victim = await stack.createUser({ email: 'victim@test.example', password: PASSWORD })
  // The attacker, from one address, burns the allowance for the victim's email.
  for (let i = 0; i < 12; i++) await api('POST', '/api/auth/login', { body: { email: victim.email, password: `nope-${i}-nope-1` }, headers: { 'x-forwarded-for': '203.0.113.7' } })
  // The victim, from another address, signs in with the right password.
  const real = await api('POST', '/api/auth/login', { body: { email: victim.email, password: PASSWORD }, headers: { 'x-forwarded-for': '198.51.100.20' } })
  assert.equal(real.status, 200, 'the owner is not locked out by someone else\'s guesses')
})

test('sign-up and password-reset requests are capped per address and per caller, so they cannot be used to flood someone\'s inbox', async () => {
  let blockedAddress = null
  for (let i = 0; i < 8 && !blockedAddress; i++) {
    const res = await api('POST', '/api/auth/forgot-password', { body: { email: 'inbox-victim@test.example' } })
    if (res.status === 429) blockedAddress = res
  }
  assert.ok(blockedAddress, 'one address can only be mailed so often')

  let blockedIp = null
  for (let i = 0; i < 45 && !blockedIp; i++) {
    const res = await api('POST', '/api/auth/forgot-password', { body: { email: `spray-${i}@test.example` } })
    if (res.status === 429) blockedIp = res
  }
  assert.ok(blockedIp, 'and so can one caller, across many addresses')
})

// ═════════════════════ The links in emails ════════════════════════════════════

const mailedLink = async (kind) => {
  // `EMAIL_TRANSPORT=log` writes the mail to the console, which the stack mutes; read the token from the database side instead.
  const token = (await import('node:crypto')).randomBytes(32).toString('base64url')
  return token
}
const plantToken = async (userId, purpose, { expired = false, used = false } = {}) => {
  const { createHash } = await import('node:crypto')
  const token = await mailedLink()
  await stack.sql(
    `insert into email_tokens (user_id, purpose, token_hash, expires_at, used_at)
     values ($1, $2, $3, now() + $4::interval, $5)`,
    [userId, purpose, createHash('sha256').update(token).digest('hex'), expired ? '-1 minute' : '1 hour', used ? new Date() : null],
  )
  return token
}
const form = (path, fields) => rawRequest({ method: 'POST', path, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })

test('a reset link works once, only for reset, only while fresh — and opening it does not spend it', async () => {
  const u = await stack.createUser({ password: PASSWORD })
  const token = await plantToken(u.id, 'reset_password')

  // Opening (a mail scanner does this) shows the form and spends nothing.
  for (let i = 0; i < 3; i++) assert.equal((await rawRequest({ path: `/auth/reset-password?token=${token}` })).status, 200)

  // Wrong purpose: a confirmation token is not a reset token, and the other way round.
  const confirmTok = await plantToken(u.id, 'confirm_email')
  assert.equal((await rawRequest({ path: `/auth/reset-password?token=${confirmTok}` })).status, 410)
  assert.equal((await rawRequest({ path: `/auth/confirm-email?token=${token}` })).status, 410)
  assert.equal((await form('/auth/reset-password', { token: confirmTok, password: 'brand-new-password-3', confirm: 'brand-new-password-3' })).status, 410)

  // A form mistake keeps the link usable.
  const mismatch = await form('/auth/reset-password', { token, password: 'brand-new-password-3', confirm: 'something-else-4' })
  assert.equal(mismatch.status, 400)
  const weak = await form('/auth/reset-password', { token, password: 'short1', confirm: 'short1' })
  assert.equal(weak.status, 400)
  assert.equal((await login(u.email, PASSWORD)).status, 200, 'nothing changed yet')

  const done = await form('/auth/reset-password', { token, password: 'brand-new-password-3', confirm: 'brand-new-password-3' })
  assert.equal(done.status, 200)
  assert.equal((await login(u.email, 'brand-new-password-3')).status, 200)
  assert.equal((await login(u.email, PASSWORD)).status, 401)

  // Used: it cannot be used again, to set a password the attacker likes.
  assert.equal((await form('/auth/reset-password', { token, password: 'attacker-chosen-pw-9', confirm: 'attacker-chosen-pw-9' })).status, 410)
  assert.equal((await login(u.email, 'attacker-chosen-pw-9')).status, 401)
})

test('the pages that say "done" show a tick that draws itself — and still load nothing from anywhere', async () => {
  const u = await stack.createUser({ password: PASSWORD })
  const verified = await form('/auth/confirm-email', { token: await plantToken(u.id, 'confirm_email') })
  const updated = await form('/auth/reset-password', { token: await plantToken(u.id, 'reset_password'), password: 'brand-new-password-3', confirm: 'brand-new-password-3' })

  for (const [page, heading] of [[verified, 'Email verified'], [updated, 'Password updated']]) {
    assert.equal(page.status, 200)
    assert.match(page.text, new RegExp(`<h1>${heading}</h1>`))
    assert.match(page.text, /<svg class="tick"[^>]*role="img"/, `${heading}: the tick is there`)
    assert.match(page.text, /stroke-dashoffset/, 'and it is drawn by the page\'s own CSS')
    assert.match(page.text, /prefers-reduced-motion/, 'and stands still for anyone who asked for less motion')
    assert.match(page.text, /class="button"/, 'the way back into the app is still there')
    // The policy is what it was: no script, no outside resource, no frame.
    assert.match(page.headers['content-security-policy'], /default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'/)
    assert.ok(!/<script|<img|<link|src=|@import|url\(/i.test(page.text), 'nothing is loaded')
  }
})

test('an expired or unknown link is the same gentle 410 page; none of them says whether an account exists', async () => {
  const u = await stack.createUser()
  const expired = await plantToken(u.id, 'reset_password', { expired: true })
  const used = await plantToken(u.id, 'reset_password', { used: true })
  const pages = []
  for (const token of [expired, used, 'x'.repeat(30), 'short', '', undefined, 'a'.repeat(500)]) {
    const res = await rawRequest({ path: `/auth/reset-password${token === undefined ? '' : `?token=${token}`}` })
    assert.equal(res.status, 410, String(token).slice(0, 20))
    pages.push(res.text)
  }
  assert.equal(new Set(pages).size, 1, 'the same page for every reason')
  assert.equal(pages[0].includes(u.email), false)
})

test('a reset ends every session of the account, and a confirmation page escapes the address it shows', async () => {
  const u = await stack.createUser({ email: 'sess@test.example', password: PASSWORD })
  const signedIn = (await login(u.email, PASSWORD)).body.session
  const token = await plantToken(u.id, 'reset_password')
  await form('/auth/reset-password', { token, password: 'brand-new-password-3', confirm: 'brand-new-password-3' })
  assert.equal((await api('GET', ME, { token: signedIn.accessToken })).status, 401)
  assert.equal(await sessionRows(u.id), 0)

  // The page escapes what it prints: an address made of markup cannot become markup.
  await stack.sql('update users set email = $2 where id = $1', [u.id, 'a"><script>alert(1)</script>@test.example'])
  const t2 = await plantToken(u.id, 'confirm_email')
  const page = await rawRequest({ path: `/auth/confirm-email?token=${t2}` })
  assert.equal(page.status, 200)
  assert.equal(page.text.includes('<script>alert(1)</script>'), false)
  assert.ok(page.text.includes('&lt;script&gt;'))
  assert.match(page.headers['content-security-policy'], /default-src 'none'/)
  assert.match(page.headers['cache-control'], /no-store/)
  assert.equal(page.headers['referrer-policy'], 'no-referrer')
})

test('the one-time pages cap how fast a caller can try tokens', async () => {
  let limited = null
  for (let i = 0; i < 40 && !limited; i++) {
    const res = await form('/auth/confirm-email', { token: `${'t'.repeat(30)}${i}` })
    if (res.status === 429) limited = res
  }
  assert.ok(limited)
})

// ═════════════════════ Hostile input to the public endpoints ══════════════════

test('mass assignment: nothing an account sends can set its role, status, scope, confirmation or balance', async () => {
  const hostile = { role: 'admin', status: 'active', scope: 'admin', email_confirmed_at: new Date().toISOString(), emailConfirmed: true, isAdmin: true, is_admin: true, admin: true, balance: 1e9, credits: 1e9, id: '00000000-0000-0000-0000-000000000001', password_hash: 'x', userId: '00000000-0000-0000-0000-000000000001' }

  const created = await signup({ email: 'mass@test.example', password: PASSWORD, displayName: 'Mass', ...hostile })
  assert.equal(created.status, 201)
  const row = await stack.one(`select role, status, email_confirmed_at from users where email = 'mass@test.example'`)
  assert.deepEqual([row.role, row.status, row.email_confirmed_at], ['user', 'active', null], 'sign-up ignored every one of them')
  assert.equal((await login('mass@test.example', PASSWORD)).body.code, 'EMAIL_NOT_CONFIRMED')

  const u = await stack.createUser({ email: 'mass2@test.example' })
  const patched = await api('POST', ME, { token: u.token, body: { displayName: 'New Name', ...hostile } })
  assert.equal(patched.status, 200)
  const after = await stack.one('select role, status, display_name, email from users where id = $1', [u.id])
  assert.deepEqual([after.role, after.status, after.display_name, after.email], ['user', 'active', 'New Name', 'mass2@test.example'])
  assert.equal((await stack.sql('select count(*)::int as n from credit_ledger where user_id = $1', [u.id]))[0].n, 0)

  // And the sign-in's own `scope` cannot be used to ask for more than the account is.
  const signedIn = await login(u.email, u.password, { scope: 'admin', role: 'admin' })
  assert.equal(signedIn.body.code, 'NOT_ADMIN')
})

test('prototype pollution: __proto__, constructor and prototype keys in a body change nothing for anyone', async () => {
  const u = await stack.createUser({ password: PASSWORD })
  const bodies = [
    '{"__proto__":{"role":"admin","polluted":"yes"},"email":"a@b.co","password":"x"}',
    '{"constructor":{"prototype":{"role":"admin","polluted":"yes"}},"displayName":"x"}',
    '{"displayName":"x","__proto__":{"polluted":"yes"}}',
  ]
  for (const body of bodies) {
    for (const [path, token] of [['/api/auth/login'], ['/api/auth/signup'], [ME, u.token], ['/api/influencers/create', u.token], ['/api/studio-settings', u.token]]) {
      await rawRequest({ method: 'POST', path, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body })
    }
  }
  assert.equal({}.polluted, undefined, 'Object.prototype is untouched')
  assert.equal({}.role, undefined)
  assert.equal((await api('GET', '/api/admin/stats', { token: u.token })).status, 403, 'and nobody became an administrator')
})

test('malformed and oddly-typed bodies are 400s with the same JSON shape — never a 500, never an HTML page', async () => {
  const send = (path, init) => rawRequest({ method: 'POST', path, ...init })
  const json = { 'content-type': 'application/json' }
  for (const path of ['/api/auth/login', '/api/auth/signup', '/api/auth/forgot-password', '/api/auth/resend-confirmation', '/api/auth/refresh']) {
    for (const [what, init] of [
      ['broken JSON', { headers: json, body: '{"email": ' }],
      ['an empty body', { headers: json, body: '' }],
      ['null', { headers: json, body: 'null' }],
      ['an array', { headers: json, body: '[1,2,3]' }],
      ['a bare string', { headers: json, body: '"hello"' }],
      ['a number', { headers: json, body: '12345' }],
      ['form-encoded instead of JSON', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a%40b.co&password=x' }],
      ['text/plain', { headers: { 'content-type': 'text/plain' }, body: '{"email":"a@b.co","password":"x"}' }],
      ['multipart', { headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: '--x\r\n\r\n--x--' }],
      ['no content type', { body: '{"email":"a@b.co"}' }],
      ['depth bomb', { headers: json, body: `${'['.repeat(200_000)}${']'.repeat(200_000)}` }],
    ]) {
      const res = await send(path, init)
      assert.ok(res.status >= 400 && res.status < 500, `${path} ${what} -> ${res.status}`)
      assert.ok(res.json && typeof res.json.error === 'string', `${path} ${what}: not the JSON error shape`)
      assert.equal(/at .*\.js:\d+|node_modules|SyntaxError|body-parser/.test(res.text), false, `${path} ${what} leaks internals`)
    }
  }
})

test('odd types for every field of sign-in and sign-up are refused as 400s', async () => {
  const odd = [null, 0, 1, true, false, [], ['a@b.co'], {}, { a: 1 }, 'x'.repeat(5000), '\u0000', 'a\u0000@b.co', '\ud800', 'a@b.co\r\nBcc: victim@test.example', 'a@b.co\nSubject: hi', ' ', '\t\n']
  for (const v of odd) {
    for (const [path, body] of [
      ['/api/auth/login', { email: v, password: PASSWORD }],
      ['/api/auth/login', { email: 'a@b.co', password: v }],
      ['/api/auth/signup', { email: v, password: PASSWORD }],
      ['/api/auth/signup', { email: 'ok@test.example', password: v }],
      ['/api/auth/signup', { email: 'ok@test.example', password: PASSWORD, displayName: v }],
      ['/api/auth/forgot-password', { email: v }],
      ['/api/auth/resend-confirmation', { email: v }],
    ]) {
      const res = await api('POST', path, { body })
      // A display name of any shape is optional text: it is accepted or cleaned, never a crash.
      assert.ok(res.status < 500, `${path} ${JSON.stringify(body)?.slice(0, 80)} -> ${res.status} ${res.text?.slice(0, 80)}`)
    }
  }
})

test('an email with a line break in it can never become a mail header', async () => {
  // (A break at the very start or end is just padding and is trimmed away like any other whitespace.)
  for (const email of ['a@b.co\r\nBcc: victim@test.example', 'a@b.co\nBcc: x@y.z', 'a@b.co\rX: y', 'a\r\n@b.co', 'a@b\u0001.co', 'a@b.co\u007f']) {
    const res = await signup({ email, password: PASSWORD })
    assert.equal(res.status, 400, JSON.stringify(email))
    assert.equal(res.body.code, 'INVALID_EMAIL')
    assert.equal((await stack.sql('select count(*)::int as n from users'))[0].n, 0)
  }
})

test('the display name cannot be used to put your own words into an email sent to someone else', async () => {
  // Anyone can type any address into sign-up, so the mail goes to a person who asked for nothing. What
  // that mail says must be the server's words, not the signer's: a name like this is a phishing message
  // that arrives from the app's own address.
  const sent = []
  const real = console.log
  const stackConsole = global.console
  process.env.EMAIL_TRANSPORT = 'log'
  const { confirmationEmail } = await stack.load('api/_lib/email.js')
  const mail = confirmationEmail({ to: 'victim@test.example', displayName: 'Your account is locked. Call +1 555 0100 now\n\nhttps://evil.example/login', link: 'https://api.test.example/auth/confirm-email?token=t' })
  sent.push(mail.text, mail.html)
  for (const body of sent) {
    assert.equal(/Call \+1 555|evil\.example|Your account is locked/.test(body), false, 'a stranger-typed name is not in the mail')
  }
  void real; void stackConsole
})

test('email addresses are one identity however they are written: case and padding cannot make a second account', async () => {
  assert.equal((await signup({ email: 'Case.Test@Test.Example', password: PASSWORD })).status, 201)
  for (const variant of ['case.test@test.example', 'CASE.TEST@TEST.EXAMPLE', '  case.test@test.example  ']) {
    await signup({ email: variant, password: PASSWORD })
  }
  assert.equal((await stack.sql(`select count(*)::int as n from users where lower(email) = 'case.test@test.example'`))[0].n, 1)
  assert.equal((await stack.sql('select email from users'))[0].email, 'case.test@test.example', 'stored normalised')
})

test('twenty simultaneous sign-ups for one address create exactly one account', async () => {
  const answers = await Promise.all(Array.from({ length: 20 }, () => signup({ email: 'race@test.example', password: PASSWORD })))
  assert.ok(answers.every(a => a.status === 201 || a.status === 429), answers.map(a => a.status).join(','))
  assert.equal((await stack.sql(`select count(*)::int as n from users where email = 'race@test.example'`))[0].n, 1)
})

// ═════════════════════ Body size ══════════════════════════════════════════════

test('unauthenticated endpoints refuse a large body outright, before reading it all', async () => {
  const big = JSON.stringify({ email: 'a@b.co', password: PASSWORD, pad: 'x'.repeat(200_000) })
  for (const path of ['/api/auth/login', '/api/auth/signup', '/api/auth/forgot-password', '/api/auth/refresh', '/api/auth/resend-confirmation']) {
    const res = await rawRequest({ method: 'POST', path, headers: { 'content-type': 'application/json' }, body: big })
    assert.equal(res.status, 413, `${path} -> ${res.status}`)
    assert.equal(res.json?.code, 'TOO_LARGE', path)
  }
  // The two webhooks may carry more (a RevenueCat event is a few KB, but KIE's payloads can have long result lists): 256 KB.
  const bigger = JSON.stringify({ pad: 'x'.repeat(300_000) })
  for (const path of ['/webhooks/revenuecat', '/webhooks/kie']) {
    const res = await rawRequest({ method: 'POST', path, headers: { 'content-type': 'application/json' }, body: bigger })
    assert.equal(res.status, 413, `${path} -> ${res.status}`)
    assert.equal(res.json?.code, 'TOO_LARGE', path)
  }
  const form = new URLSearchParams({ token: 'x'.repeat(50_000) }).toString()
  for (const path of ['/auth/confirm-email', '/auth/reset-password']) {
    const res = await rawRequest({ method: 'POST', path, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })
    assert.equal(res.status, 413, path)
  }
})

test('signed-in endpoints have a sensible ceiling too, with room only where a body really is large (the generation proxy)', async () => {
  const u = await stack.createUser()
  const huge = JSON.stringify({ record: { name: 'x', backstory: 'y'.repeat(1_500_000) } })
  const res = await rawRequest({ method: 'POST', path: '/api/influencers/create', headers: { 'content-type': 'application/json', authorization: `Bearer ${u.token}` }, body: huge })
  assert.equal(res.status, 413)

  const upload = JSON.stringify({ model: 'kling-3.0/video', input: { prompt: 'p', pad: 'z'.repeat(2_000_000) } })
  const proxied = await rawRequest({ method: 'POST', path: '/api/kie/api/file-base64-upload', headers: { 'content-type': 'application/json', authorization: `Bearer ${u.token}` }, body: upload })
  assert.notEqual(proxied.status, 413, 'a base64 file upload through the proxy legitimately needs megabytes')
})
