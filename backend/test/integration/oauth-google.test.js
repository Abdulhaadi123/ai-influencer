// Signing in with Google, end to end: a real signed token (made here with a key of our own, whose public half a
// stand-in for Google serves), the real endpoint, the real database. What is checked is what protects people: a
// token that is forged, expired, made for another app or unverified gets nothing; the same Google account is
// always the same account; an address joined to an existing account cannot be used to take it over; and an
// account with no password still cannot be signed in to with one, changed, or deleted without proof.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'

import { startStack } from '../helpers/stack.js'

const WEB_CLIENT = '1234567890-web.apps.googleusercontent.com'
const EXTRA_CLIENT = '1234567890-extra.apps.googleusercontent.com'
const ISSUER = 'https://accounts.google.com'

let stack, google, account
let primary, stranger, jwksServer, jwksUrl, brokenUrl
let calls = 0

before(async () => {
  primary = await generateKeyPair('RS256')
  stranger = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(primary.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }

  jwksServer = http.createServer((req, res) => {
    if (req.url === '/certs') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ keys: [jwk] })) }
    res.writeHead(500); res.end('broken')
  })
  await new Promise(r => jwksServer.listen(0, '127.0.0.1', r))
  const port = jwksServer.address().port
  jwksUrl = `http://127.0.0.1:${port}/certs`
  brokenUrl = `http://127.0.0.1:${port}/broken`

  stack = await startStack({ env: { GOOGLE_CLIENT_IDS: `${WEB_CLIENT}, ${EXTRA_CLIENT}`, GOOGLE_JWKS_URL: jwksUrl } })
  account = await stack.load('api/auth/account.js')
  google = await stack.load('api/_lib/oauth/google.js')
})
after(async () => { await stack?.stop(); await new Promise(r => { jwksServer.closeAllConnections?.(); jwksServer.close(r) }) })
beforeEach(async () => { await stack.reset() })

let n = 0
/** A signed Google ID token. Anything can be overridden, to make a bad one. */
async function idToken({ sub = 'g-1001', email = 'ada@gmail.example', name = 'Ada Lovelace', emailVerified = true, aud = WEB_CLIENT, iss = ISSUER, expiresIn = '1h', key = primary.privateKey, kid = 'k1', claims = {} } = {}) {
  const jwt = new SignJWT({ email, name, email_verified: emailVerified, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt()
  if (iss) jwt.setIssuer(iss)
  if (aud) jwt.setAudience(aud)
  if (sub) jwt.setSubject(sub)
  jwt.setExpirationTime(expiresIn)
  return jwt.sign(key)
}

// Every call comes from its own address, so the per-address limit is not what a test runs into.
const nextIp = () => { calls++; return `10.9.${Math.floor(calls / 250)}.${calls % 250}` }
const signInWith = (token, { ip = nextIp(), provider = 'google' } = {}) =>
  stack.api('POST', '/api/auth/oauth', { body: { provider, idToken: token }, headers: { 'x-forwarded-for': ip } })

const userByEmail = email => stack.one('select * from users where lower(email) = $1', [email])
const identitiesOf = userId => stack.sql('select * from auth_identities where user_id = $1', [userId])
const me = token => stack.api('GET', '/api/auth/me', { token })

// ── Signing in and making the account ───────────────────────────────────────

test('a first sign-in makes a confirmed account with no password, and the session works like any other', async () => {
  const res = await signInWith(await idToken())
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.isNewAccount, true)

  const row = await userByEmail('ada@gmail.example')
  assert.ok(row.email_confirmed_at, 'Google has verified the address, so it is confirmed from the start')
  assert.equal(row.password_hash, null)
  assert.equal(row.display_name, 'Ada Lovelace')
  assert.equal(row.role, 'user')
  const ids = await identitiesOf(row.id)
  assert.deepEqual(ids.map(i => [i.provider, i.subject, i.email]), [['google', 'g-1001', 'ada@gmail.example']])

  const session = res.body.session
  assert.equal(session.user.email, 'ada@gmail.example')
  assert.equal(session.user.hasPassword, false)
  const who = await me(session.accessToken)
  assert.equal(who.status, 200)
  assert.equal(who.body.user.hasPassword, false)
  assert.equal(who.body.user.emailConfirmed, true)

  const refreshed = await stack.api('POST', '/api/auth/refresh', { body: { refreshToken: session.refreshToken } })
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.body.session.user.hasPassword, false)
})

test('the same Google account is the same account every time, even after Google changes its email', async () => {
  const first = await signInWith(await idToken())
  const again = await signInWith(await idToken())
  assert.equal(again.body.isNewAccount, false)
  assert.equal(again.body.session.user.id, first.body.session.user.id)

  const renamed = await signInWith(await idToken({ email: 'ada.lovelace@newname.example' }))
  assert.equal(renamed.body.isNewAccount, false)
  assert.equal(renamed.body.session.user.id, first.body.session.user.id)
  assert.equal((await stack.one('select count(*)::int as n from users')).n, 1)
  const row = await userByEmail('ada@gmail.example')
  assert.equal((await identitiesOf(row.id))[0].email, 'ada.lovelace@newname.example', 'what Google says now is recorded; the account keeps its own address')
})

test('an account audience may be either of our client ids', async () => {
  const res = await signInWith(await idToken({ aud: EXTRA_CLIENT }))
  assert.equal(res.status, 200)
})

test('a different Google account is a different account', async () => {
  const a = await signInWith(await idToken({ sub: 'g-1', email: 'a@gmail.example' }))
  const b = await signInWith(await idToken({ sub: 'g-2', email: 'b@gmail.example' }))
  assert.notEqual(a.body.session.user.id, b.body.session.user.id)
})

test('two first sign-ins at the same moment make one account', async () => {
  const token = await idToken({ sub: 'g-race', email: 'race@gmail.example' })
  const results = await Promise.all([signInWith(token), signInWith(token), signInWith(token)])
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(new Set(results.map(r => r.body.session.user.id)).size, 1)
  assert.equal((await stack.one(`select count(*)::int as n from users where lower(email) = 'race@gmail.example'`)).n, 1)
  assert.equal((await stack.one(`select count(*)::int as n from auth_identities where subject = 'g-race'`)).n, 1)
})

// ── Joining an existing account ─────────────────────────────────────────────

test('an account with the same confirmed address is joined, and its password keeps working', async () => {
  const owner = await stack.createUser({ email: 'ada@gmail.example', password: 'owners-own-password-1' })
  const res = await signInWith(await idToken())
  assert.equal(res.status, 200)
  assert.equal(res.body.isNewAccount, false)
  assert.equal(res.body.session.user.id, owner.id)
  assert.equal(res.body.session.user.hasPassword, true)
  assert.equal((await identitiesOf(owner.id)).length, 1)

  const byPassword = await stack.api('POST', '/api/auth/login', { body: { email: 'ada@gmail.example', password: 'owners-own-password-1' }, headers: { 'x-forwarded-for': nextIp() } })
  assert.equal(byPassword.status, 200, 'joining Google does not take the password away')
})

test('an address that was never confirmed is TAKEN OVER: the password someone set is erased and their sessions end', async () => {
  // Someone signed up with ada's address and a password of their own, and never confirmed it.
  const squatter = await stack.api('POST', '/api/auth/signup', { body: { email: 'ada@gmail.example', password: 'squatters-password-9' }, headers: { 'x-forwarded-for': nextIp() } })
  assert.equal(squatter.status, 201)
  const row = await userByEmail('ada@gmail.example')
  assert.equal(row.email_confirmed_at, null)
  // …and even holds a session and a pending link.
  const session = await (await stack.load('api/_lib/sessions.js')).createSession(row)
  await account.issueEmailToken(row.id, 'confirm_email', 3600)

  const res = await signInWith(await idToken())
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.session.user.id, row.id, 'the real owner gets that account, not a second one')

  const after = await userByEmail('ada@gmail.example')
  assert.ok(after.email_confirmed_at)
  assert.equal(after.password_hash, null, 'the squatter\'s password is gone')
  assert.equal((await me(session.accessToken)).status, 401, 'and so is their session')
  assert.equal((await stack.one('select count(*)::int as n from email_tokens where user_id = $1', [row.id])).n, 0, 'and their links')
  const byPassword = await stack.api('POST', '/api/auth/login', { body: { email: 'ada@gmail.example', password: 'squatters-password-9' }, headers: { 'x-forwarded-for': nextIp() } })
  assert.equal(byPassword.status, 401)
})

test('an administrator\'s account is never joined or signed in this way', async () => {
  const admin = await stack.createUser({ email: 'ada@gmail.example', role: 'admin' })
  const res = await signInWith(await idToken())
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'ADMIN_ACCOUNT')
  assert.equal((await identitiesOf(admin.id)).length, 0)
})

test('a suspended account is refused, and is not joined either', async () => {
  const user = await stack.createUser({ email: 'ada@gmail.example', status: 'suspended' })
  const res = await signInWith(await idToken())
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'ACCOUNT_SUSPENDED')
  assert.equal((await identitiesOf(user.id)).length, 0)

  // Suspended after it was joined: the next sign-in is refused too.
  const other = await signInWith(await idToken({ sub: 'g-2', email: 'bo@gmail.example' }))
  await stack.sql(`update users set status = 'suspended' where id = $1`, [other.body.session.user.id])
  const refused = await signInWith(await idToken({ sub: 'g-2', email: 'bo@gmail.example' }))
  assert.equal(refused.body.code, 'ACCOUNT_SUSPENDED')
})

// ── Tokens that must not be believed ────────────────────────────────────────

test('a token that is not Google\'s, not ours, not valid or not verified gets nothing', async () => {
  const forgedHeaderAndBody = async (header, claims) => {
    const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url')
    return `${enc(header)}.${enc(claims)}.`
  }
  const now = Math.floor(Date.now() / 1000)
  const goodClaims = { iss: ISSUER, aud: WEB_CLIENT, sub: 'g-evil', email: 'evil@gmail.example', email_verified: true, iat: now, exp: now + 3600 }

  const cases = {
    'signed by another key': await idToken({ key: stranger.privateKey }),
    'a key id Google never published': await idToken({ kid: 'nope' }),
    'made for another app': await idToken({ aud: 'someone-else.apps.googleusercontent.com' }),
    'from another issuer': await idToken({ iss: 'https://evil.example' }),
    'expired': await idToken({ expiresIn: '-10m' }),
    'email not verified': await idToken({ emailVerified: false }),
    'no email': await idToken({ email: '' }),
    'no subject': await idToken({ sub: '' }),
    'algorithm "none"': await forgedHeaderAndBody({ alg: 'none', typ: 'JWT' }, goodClaims),
    'HS256 signed with the public key as the secret': await new SignJWT({ ...goodClaims }).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).sign(new TextEncoder().encode('anything')),
    'garbage': 'not.a.token',
    'a very long string': 'x'.repeat(5000),
    'empty': '',
  }
  for (const [what, token] of Object.entries(cases)) {
    const res = await signInWith(token)
    assert.equal(res.status, 401, `${what}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.code, 'OAUTH_TOKEN_INVALID', what)
    assert.ok(!/signature|expired|audience|claim/i.test(res.body.error), `${what}: the answer does not teach a forger anything`)
  }
  assert.equal((await stack.one('select count(*)::int as n from users')).n, 0, 'none of them made an account')

  for (const bad of [undefined, null, 42, {}, ['x']]) {
    const res = await signInWith(bad)
    assert.equal(res.status, 401, `a ${typeof bad} token`)
  }
})

test('only Google is a way in so far', async () => {
  const res = await signInWith(await idToken(), { provider: 'apple' })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'UNSUPPORTED_PROVIDER')
  const none = await stack.api('POST', '/api/auth/oauth', { body: { idToken: await idToken() }, headers: { 'x-forwarded-for': nextIp() } })
  assert.equal(none.status, 400)
})

test('not configured: answers "not available", and says nothing about tokens', async () => {
  const saved = process.env.GOOGLE_CLIENT_IDS
  process.env.GOOGLE_CLIENT_IDS = ''
  try {
    const res = await signInWith(await idToken())
    assert.equal(res.status, 503)
    assert.equal(res.body.code, 'OAUTH_NOT_CONFIGURED')
    assert.equal(google.googleConfigured(), false)
  } finally { process.env.GOOGLE_CLIENT_IDS = saved }
})

test('Google\'s keys cannot be fetched: "try again", not "your token is bad"', async () => {
  const saved = process.env.GOOGLE_JWKS_URL
  try {
    process.env.GOOGLE_JWKS_URL = brokenUrl                                  // answers 500
    assert.equal((await signInWith(await idToken())).body.code, 'OAUTH_UNAVAILABLE')
    process.env.GOOGLE_JWKS_URL = 'http://127.0.0.1:1/certs'                // nothing listens
    const res = await signInWith(await idToken())
    assert.equal(res.status, 503)
    assert.equal(res.body.code, 'OAUTH_UNAVAILABLE')
  } finally { process.env.GOOGLE_JWKS_URL = saved }
  assert.equal((await signInWith(await idToken())).status, 200, 'and it works again once the keys are back')
})

test('sign-ins are limited per caller', async () => {
  const ip = '10.77.0.1'
  const token = await idToken()
  let last
  for (let i = 0; i < 31; i++) last = await signInWith(token, { ip })
  assert.equal(last.status, 429)
  assert.equal((await signInWith(token, { ip: '10.77.0.2' })).status, 200, 'another caller is unaffected')
})

// ── An account with no password ─────────────────────────────────────────────

test('no password can ever sign in to a Google account, and its address cannot be signed up again', async () => {
  const made = await signInWith(await idToken())
  for (const password of ['', 'a-long-test-password-1', 'null', 'undefined', 'x'.repeat(40)]) {
    const res = await stack.api('POST', '/api/auth/login', { body: { email: 'ada@gmail.example', password }, headers: { 'x-forwarded-for': nextIp() } })
    assert.equal(res.status, password ? 401 : 400, `password "${password.slice(0, 10)}"`)
  }
  const signUp = await stack.api('POST', '/api/auth/signup', { body: { email: 'ada@gmail.example', password: 'a-long-test-password-1' }, headers: { 'x-forwarded-for': nextIp() } })
  assert.equal(signUp.status, 409)
  assert.equal(signUp.body.code, 'EMAIL_TAKEN')
  assert.equal((await userByEmail('ada@gmail.example')).password_hash, null, 'sign-up did not give it a password')
  assert.ok(made.body.session)
})

test('change password: an account with none is told so, one with a password is unaffected', async () => {
  const made = await signInWith(await idToken())
  const res = await stack.api('POST', '/api/auth/change-password', { token: made.body.session.accessToken, body: { currentPassword: 'a-long-test-password-1', newPassword: 'a-brand-new-password-2' } })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'NO_PASSWORD')
  assert.equal((await userByEmail('ada@gmail.example')).password_hash, null)

  const owner = await stack.createUser({ password: 'owners-own-password-1' })
  const ok = await stack.api('POST', '/api/auth/change-password', { token: owner.token, body: { currentPassword: 'owners-own-password-1', newPassword: 'a-brand-new-password-2' } })
  assert.equal(ok.status, 200)
})

test('"Forgot password" is how a Google account sets one, and then both ways in work', async () => {
  const made = await signInWith(await idToken())
  const userId = made.body.session.user.id
  const token = await account.issueEmailToken(userId, 'reset_password', 3600)
  const res = await fetch(`${stack.base}/auth/reset-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': nextIp() },
    body: new URLSearchParams({ token, password: 'a-brand-new-password-2', confirm: 'a-brand-new-password-2' }),
  })
  assert.equal(res.status, 200)
  assert.ok((await userByEmail('ada@gmail.example')).password_hash)
  const byPassword = await stack.api('POST', '/api/auth/login', { body: { email: 'ada@gmail.example', password: 'a-brand-new-password-2' }, headers: { 'x-forwarded-for': nextIp() } })
  assert.equal(byPassword.status, 200)
  assert.equal(byPassword.body.session.user.hasPassword, true)
  assert.equal((await signInWith(await idToken())).status, 200, 'Google still works')
})

// ── Deleting the account ────────────────────────────────────────────────────

const deleteWith = (token, body) => stack.api('POST', '/api/account/delete', { token, body, headers: { 'x-forwarded-for': nextIp() } })

test('deleting an account with no password asks for a fresh Google sign-in, and only THIS account\'s Google will do', async () => {
  const made = await signInWith(await idToken())
  const token = made.body.session.accessToken
  const userId = made.body.session.user.id

  const none = await deleteWith(token, {})
  assert.equal(none.status, 400)
  assert.equal(none.body.code, 'REAUTH_REQUIRED')
  const password = await deleteWith(token, { password: 'a-long-test-password-1' })
  assert.equal(password.status, 403, 'there is no password to match')

  const someoneElse = await deleteWith(token, { oauth: { provider: 'google', idToken: await idToken({ sub: 'g-other', email: 'other@gmail.example' }) } })
  assert.equal(someoneElse.status, 403)
  assert.equal(someoneElse.body.code, 'WRONG_ACCOUNT')
  const forged = await deleteWith(token, { oauth: { provider: 'google', idToken: await idToken({ key: stranger.privateKey }) } })
  assert.equal(forged.status, 401)
  assert.ok(await stack.one('select 1 from users where id = $1', [userId]), 'nothing was deleted by any of those')

  const ok = await deleteWith(token, { oauth: { provider: 'google', idToken: await idToken() } })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(await stack.one('select 1 from users where id = $1', [userId]), null)
  assert.equal((await identitiesOf(userId)).length, 0, 'the identity goes with the account')
  assert.equal((await me(token)).status, 401)
  // The same Google account can start again, as a brand-new account.
  const again = await signInWith(await idToken())
  assert.equal(again.body.isNewAccount, true)
  assert.notEqual(again.body.session.user.id, userId)
})

test('an account WITH a password still deletes with its password, as before', async () => {
  const owner = await stack.createUser({ password: 'owners-own-password-1' })
  assert.equal((await deleteWith(owner.token, {})).body.code, 'PASSWORD_REQUIRED')
  assert.equal((await deleteWith(owner.token, { password: 'wrong-password-123' })).status, 403)
  assert.equal((await deleteWith(owner.token, { password: 'owners-own-password-1' })).status, 200)
})
