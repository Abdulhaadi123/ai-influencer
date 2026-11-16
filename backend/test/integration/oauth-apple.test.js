// Signing in with Apple, end to end: a real signed identity token (made here with a key of our own, whose public half a
// stand-in for Apple serves), the real endpoint, the real database. What is checked is what protects people: a token that
// is forged, expired, made for another app, without the nonce this sign-in began with, or unverified gets nothing; the
// same Apple account is always the same account; an address joined to an existing account cannot be used to take it
// over; Apple's habits (a name only once, a relay address, a token with no email) do the right thing; and deleting an
// account asks for a fresh Apple sign-in and REVOKES the person's Apple tokens, with a client secret signed the way
// Apple wants it — without ever standing between a person and the deletion of their account.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT, jwtVerify, decodeProtectedHeader } from 'jose'

import { startStack } from '../helpers/stack.js'

const BUNDLE = 'app.influenza.ai'
const OTHER_CLIENT = 'com.example.services'
const ISSUER = 'https://appleid.apple.com'
const TEAM = 'ABCDE12345'
const KEY_ID = 'KEYID12345'

let stack, apple, account
let primary, stranger, signer, pem
let appleServer, appleBase

// What the stand-in for Apple was asked, and how it answers.
const asked = []
const answers = { token: { status: 200, body: { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600 } }, revoke: { status: 200 } }

before(async () => {
  primary = await generateKeyPair('RS256')
  stranger = await generateKeyPair('RS256')
  signer = await generateKeyPair('ES256', { extractable: true })
  pem = await exportPKCS8(signer.privateKey)
  const jwk = { ...(await exportJWK(primary.publicKey)), kid: 'a1', alg: 'RS256', use: 'sig' }

  appleServer = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const path = new URL(req.url, 'http://x').pathname
      if (req.method === 'GET' && path === '/auth/keys') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ keys: [jwk] })) }
      if (req.method === 'POST' && (path === '/auth/token' || path === '/auth/revoke')) {
        const fields = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()))
        asked.push({ path, fields, type: req.headers['content-type'] })
        const answer = path === '/auth/token' ? answers.token : answers.revoke
        res.writeHead(answer.status, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(answer.body ?? {}))
      }
      res.writeHead(500); res.end('broken')
    })
  })
  await new Promise(r => appleServer.listen(0, '127.0.0.1', r))
  appleBase = `http://127.0.0.1:${appleServer.address().port}`

  stack = await startStack({
    env: {
      APPLE_CLIENT_IDS: `${BUNDLE}, ${OTHER_CLIENT}`,
      APPLE_JWKS_URL: `${appleBase}/auth/keys`,
      APPLE_AUTH_BASE_URL: appleBase,
      APPLE_TEAM_ID: TEAM,
      APPLE_KEY_ID: KEY_ID,
      APPLE_PRIVATE_KEY: pem,
    },
  })
  account = await stack.load('api/auth/account.js')
  apple = await stack.load('api/_lib/oauth/apple.js')
})
after(async () => { await stack?.stop(); await new Promise(r => { appleServer.closeAllConnections?.(); appleServer.close(r) }) })
beforeEach(async () => {
  await stack.reset()
  asked.length = 0
  answers.token = { status: 200, body: { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600 } }
  answers.revoke = { status: 200 }
})

const sha = value => createHash('sha256').update(value).digest('hex')

/** What the phone invents and keeps: Apple is given its hash, and the server is given the string itself. */
const NONCE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'

/**
 * A signed Apple identity token. Anything can be overridden, to make a bad one. `email: null` leaves the email out,
 * `nonce: null` leaves the nonce out, and `nonceClaim` puts exactly that in the token whatever the nonce is.
 */
async function identityToken({ sub = '001234.0a1b2c3d4e5f.1234', email = 'ada@icloud.example', emailVerified = 'true', aud = BUNDLE, iss = ISSUER,
  expiresIn = '10m', key = primary.privateKey, kid = 'a1', nonce = NONCE, nonceClaim, claims = {} } = {}) {
  const payload = { nonce_supported: true, ...claims }
  if (email !== null) { payload.email = email; payload.email_verified = emailVerified }
  const claim = nonceClaim !== undefined ? nonceClaim : (nonce === null ? undefined : sha(nonce))
  if (claim !== undefined) payload.nonce = claim
  const jwt = new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid }).setIssuedAt()
  if (iss) jwt.setIssuer(iss)
  if (aud) jwt.setAudience(aud)
  if (sub) jwt.setSubject(sub)
  jwt.setExpirationTime(expiresIn)
  return jwt.sign(key)
}

// Every call comes from its own address, so the per-address limit is not what a test runs into.
let calls = 0
const nextIp = () => { calls++; return `10.8.${Math.floor(calls / 250)}.${calls % 250}` }
const signInWith = (token, { nonce = NONCE, fullName, ip = nextIp(), provider = 'apple' } = {}) =>
  stack.api('POST', '/api/auth/oauth', { body: { provider, idToken: token, nonce, ...(fullName ? { fullName } : {}) }, headers: { 'x-forwarded-for': ip } })

const userByEmail = email => stack.one('select * from users where lower(email) = $1', [email])
const identitiesOf = userId => stack.sql('select * from auth_identities where user_id = $1 order by provider', [userId])
const me = token => stack.api('GET', '/api/auth/me', { token })

// ── Signing in and making the account ───────────────────────────────────────

test('a first sign-in makes a confirmed account with no password, named from Apple\'s sheet, and the session works like any other', async () => {
  const res = await signInWith(await identityToken(), { fullName: { givenName: 'Ada', familyName: 'Lovelace' } })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.isNewAccount, true)

  const row = await userByEmail('ada@icloud.example')
  assert.ok(row.email_confirmed_at, 'Apple has verified the address, so it is confirmed from the start')
  assert.equal(row.password_hash, null)
  assert.equal(row.display_name, 'Ada Lovelace')
  assert.equal(row.role, 'user')
  assert.deepEqual((await identitiesOf(row.id)).map(i => [i.provider, i.subject, i.email]), [['apple', '001234.0a1b2c3d4e5f.1234', 'ada@icloud.example']])

  const session = res.body.session
  assert.equal(session.user.email, 'ada@icloud.example')
  assert.equal(session.user.hasPassword, false)
  assert.deepEqual(session.user.providers, ['apple'], 'the app is told how this account signs in')
  const who = await me(session.accessToken)
  assert.equal(who.status, 200)
  assert.equal(who.body.user.hasPassword, false)
  assert.equal(who.body.user.emailConfirmed, true)
  assert.deepEqual(who.body.user.providers, ['apple'])

  const refreshed = await stack.api('POST', '/api/auth/refresh', { body: { refreshToken: session.refreshToken } })
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.body.session.user.hasPassword, false)
})

test('Apple gives the name once: later sign-ins without it keep the one the account has', async () => {
  const first = await signInWith(await identityToken(), { fullName: { givenName: 'Ada', familyName: 'Lovelace' } })
  const again = await signInWith(await identityToken())
  assert.equal(again.body.isNewAccount, false)
  assert.equal(again.body.session.user.id, first.body.session.user.id)
  assert.equal((await userByEmail('ada@icloud.example')).display_name, 'Ada Lovelace')
  const other = await signInWith(await identityToken(), { fullName: { givenName: 'Someone', familyName: 'Else' } })
  assert.equal(other.body.session.user.id, first.body.session.user.id)
  assert.equal((await userByEmail('ada@icloud.example')).display_name, 'Ada Lovelace', 'a later name does not rename the account')

  // No name at all: the account simply has none, as one made with an address and a password has none.
  const nameless = await signInWith(await identityToken({ sub: 'apple-2', email: 'bo@icloud.example' }), { fullName: {} })
  assert.equal(nameless.status, 200)
  assert.equal((await userByEmail('bo@icloud.example')).display_name, null)
  const odd = await signInWith(await identityToken({ sub: 'apple-3', email: 'cy@icloud.example' }), { fullName: { givenName: ['x'], familyName: 42 } })
  assert.equal(odd.status, 200, 'a name that is not text is ignored, not an error')
  assert.equal((await userByEmail('cy@icloud.example')).display_name, null)
})

test('the same Apple account is the same account every time, even when Apple\'s email changes or is left out', async () => {
  const first = await signInWith(await identityToken())
  const renamed = await signInWith(await identityToken({ email: 'ada.lovelace@new.example' }))
  assert.equal(renamed.body.isNewAccount, false)
  assert.equal(renamed.body.session.user.id, first.body.session.user.id)
  const row = await userByEmail('ada@icloud.example')
  assert.equal((await identitiesOf(row.id))[0].email, 'ada.lovelace@new.example', 'what Apple says now is recorded; the account keeps its own address')

  const noEmail = await signInWith(await identityToken({ email: null }))
  assert.equal(noEmail.status, 200, JSON.stringify(noEmail.body))
  assert.equal(noEmail.body.session.user.id, first.body.session.user.id)
  assert.equal((await identitiesOf(row.id))[0].email, 'ada.lovelace@new.example', 'a token with no email does not erase the one on record')
  assert.equal((await stack.one('select count(*)::int as n from users')).n, 1)
})

test('either of our client ids will do, and a boolean email_verified is as good as the string Apple sends', async () => {
  assert.equal((await signInWith(await identityToken({ aud: OTHER_CLIENT, sub: 'apple-a', email: 'a@icloud.example' }))).status, 200)
  assert.equal((await signInWith(await identityToken({ emailVerified: true, sub: 'apple-b', email: 'b@icloud.example' }))).status, 200)
})

test('a different Apple account is a different account', async () => {
  const a = await signInWith(await identityToken({ sub: 'apple-1', email: 'a@icloud.example' }))
  const b = await signInWith(await identityToken({ sub: 'apple-2', email: 'b@icloud.example' }))
  assert.notEqual(a.body.session.user.id, b.body.session.user.id)
})

test('two first sign-ins at the same moment make one account', async () => {
  const token = await identityToken({ sub: 'apple-race', email: 'race@icloud.example' })
  const results = await Promise.all([signInWith(token), signInWith(token), signInWith(token)])
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(new Set(results.map(r => r.body.session.user.id)).size, 1)
  assert.equal((await stack.one(`select count(*)::int as n from users where lower(email) = 'race@icloud.example'`)).n, 1)
  assert.equal((await stack.one(`select count(*)::int as n from auth_identities where subject = 'apple-race'`)).n, 1)
})

// ── Apple's habits ──────────────────────────────────────────────────────────

test('"Hide My Email": the relay address is a verified address like any other, and never joins an account made with the real one', async () => {
  const real = await stack.createUser({ email: 'ada@icloud.example', password: 'owners-own-password-1' })
  const res = await signInWith(await identityToken({ sub: 'apple-hidden', email: 'x7k2p9@privaterelay.appleid.com' }))
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.isNewAccount, true)
  assert.notEqual(res.body.session.user.id, real.id)
  assert.equal(res.body.session.user.email, 'x7k2p9@privaterelay.appleid.com')
  assert.equal((await identitiesOf(real.id)).length, 0)
})

test('a token with no email: an account that exists signs in; with none yet the person is told what to do, and nothing is made', async () => {
  const none = await signInWith(await identityToken({ sub: 'apple-newcomer', email: null }))
  assert.equal(none.status, 422)
  assert.equal(none.body.code, 'OAUTH_EMAIL_MISSING')
  assert.match(none.body.error, /Sign in with Apple/)
  assert.equal((await stack.one('select count(*)::int as n from users')).n, 0)
  assert.equal((await stack.one('select count(*)::int as n from auth_identities')).n, 0)
})

// ── Joining an existing account ─────────────────────────────────────────────

test('an account with the same confirmed address is joined, and its password keeps working', async () => {
  const owner = await stack.createUser({ email: 'ada@icloud.example', password: 'owners-own-password-1' })
  const res = await signInWith(await identityToken())
  assert.equal(res.status, 200)
  assert.equal(res.body.isNewAccount, false)
  assert.equal(res.body.session.user.id, owner.id)
  assert.equal(res.body.session.user.hasPassword, true)
  assert.equal((await identitiesOf(owner.id)).length, 1)

  const byPassword = await stack.api('POST', '/api/auth/login', { body: { email: 'ada@icloud.example', password: 'owners-own-password-1' }, headers: { 'x-forwarded-for': nextIp() } })
  assert.equal(byPassword.status, 200, 'joining Apple does not take the password away')
})

test('an account that already signs in with Google and is joined by Apple says so: both ways in', async () => {
  const owner = await stack.createUser({ email: 'ada@icloud.example', password: 'owners-own-password-1' })
  await stack.sql(`insert into auth_identities (user_id, provider, subject, email) values ($1, 'google', 'g-1', 'ada@icloud.example')`, [owner.id])
  const res = await signInWith(await identityToken())
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.session.user.providers, ['apple', 'google'])
})

test('an address that was never confirmed is TAKEN OVER: the password someone set is erased and their sessions end', async () => {
  const squatter = await stack.api('POST', '/api/auth/signup', { body: { email: 'ada@icloud.example', password: 'squatters-password-9' }, headers: { 'x-forwarded-for': nextIp() } })
  assert.equal(squatter.status, 201)
  const row = await userByEmail('ada@icloud.example')
  assert.equal(row.email_confirmed_at, null)
  const session = await (await stack.load('api/_lib/sessions.js')).createSession(row)
  await account.issueEmailToken(row.id, 'confirm_email', 3600)

  const res = await signInWith(await identityToken(), { fullName: { givenName: 'Ada', familyName: 'Lovelace' } })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.session.user.id, row.id, 'the real owner gets that account, not a second one')

  const after = await userByEmail('ada@icloud.example')
  assert.ok(after.email_confirmed_at)
  assert.equal(after.password_hash, null, 'the squatter\'s password is gone')
  assert.equal((await me(session.accessToken)).status, 401, 'and so is their session')
  assert.equal((await stack.one('select count(*)::int as n from email_tokens where user_id = $1', [row.id])).n, 0, 'and their links')
  const byPassword = await stack.api('POST', '/api/auth/login', { body: { email: 'ada@icloud.example', password: 'squatters-password-9' }, headers: { 'x-forwarded-for': nextIp() } })
  assert.equal(byPassword.status, 401)
})

test('an administrator\'s account is never joined or signed in this way', async () => {
  const admin = await stack.createUser({ email: 'ada@icloud.example', role: 'admin' })
  const res = await signInWith(await identityToken())
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'ADMIN_ACCOUNT')
  assert.equal((await identitiesOf(admin.id)).length, 0)
})

test('a suspended account is refused, and is not joined either', async () => {
  const user = await stack.createUser({ email: 'ada@icloud.example', status: 'suspended' })
  const res = await signInWith(await identityToken())
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'ACCOUNT_SUSPENDED')
  assert.equal((await identitiesOf(user.id)).length, 0)

  const other = await signInWith(await identityToken({ sub: 'apple-2', email: 'bo@icloud.example' }))
  await stack.sql(`update users set status = 'suspended' where id = $1`, [other.body.session.user.id])
  const refused = await signInWith(await identityToken({ sub: 'apple-2', email: 'bo@icloud.example' }))
  assert.equal(refused.body.code, 'ACCOUNT_SUSPENDED')
})

// ── Tokens that must not be believed ────────────────────────────────────────

test('a token that is not Apple\'s, not ours, not valid, not verified or not THIS sign-in\'s gets nothing', async () => {
  const forged = (header, claims) => {
    const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url')
    return `${enc(header)}.${enc(claims)}.`
  }
  const now = Math.floor(Date.now() / 1000)
  const goodClaims = { iss: ISSUER, aud: BUNDLE, sub: 'apple-evil', email: 'evil@icloud.example', email_verified: 'true', nonce: sha(NONCE), iat: now, exp: now + 600 }

  const cases = {
    'signed by another key': [await identityToken({ key: stranger.privateKey })],
    'a key id Apple never published': [await identityToken({ kid: 'nope' })],
    'made for another app': [await identityToken({ aud: 'com.someone.else' })],
    'from another issuer': [await identityToken({ iss: 'https://evil.example' })],
    'Google\'s issuer': [await identityToken({ iss: 'https://accounts.google.com' })],
    'expired': [await identityToken({ expiresIn: '-10m' })],
    'email not verified': [await identityToken({ emailVerified: 'false' })],
    'email not verified (boolean)': [await identityToken({ emailVerified: false })],
    'an email that is not an address': [await identityToken({ email: 'not-an-address' })],
    'no subject': [await identityToken({ sub: '' })],
    'no nonce in the token': [await identityToken({ nonce: null })],
    'the nonce itself, not its hash, in the token': [await identityToken({ nonceClaim: NONCE })],
    'the hash of another nonce': [await identityToken({ nonce: 'another-nonce-another-nonce-another' })],
    'a nonce the app did not send': [await identityToken(), { nonce: 'x'.repeat(40) }],
    'no nonce sent': [await identityToken(), { nonce: null }],
    'an empty nonce': [await identityToken(), { nonce: '' }],
    'a nonce that is not text': [await identityToken(), { nonce: 12345678901234567890 }],
    'a nonce too short to be a secret': [await identityToken({ nonce: 'short' }), { nonce: 'short' }],
    'a nonce too long': [await identityToken({ nonce: 'n'.repeat(300) }), { nonce: 'n'.repeat(300) }],
    'algorithm "none"': [forged({ alg: 'none', typ: 'JWT' }, goodClaims)],
    'HS256 signed with a made-up secret': [await new SignJWT({ ...goodClaims }).setProtectedHeader({ alg: 'HS256', kid: 'a1' }).sign(new TextEncoder().encode('anything'))],
    'garbage': ['not.a.token'],
    'a very long string': ['x'.repeat(5000)],
    'empty': [''],
  }
  for (const [what, [token, options]] of Object.entries(cases)) {
    const res = await signInWith(token, options)
    assert.equal(res.status, 401, `${what}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.code, 'OAUTH_TOKEN_INVALID', what)
    assert.ok(!/signature|expired|audience|claim|nonce/i.test(res.body.error), `${what}: the answer does not teach a forger anything`)
  }
  assert.equal((await stack.one('select count(*)::int as n from users')).n, 0, 'none of them made an account')

  for (const bad of [undefined, null, 42, {}, ['x']]) {
    const res = await signInWith(bad)
    assert.equal(res.status, 401, `a ${typeof bad} token`)
  }
})

test('a token and the nonce it was made with, used by someone else with a different nonce, is no use to them', async () => {
  const token = await identityToken()
  assert.equal((await signInWith(token)).status, 200, 'the phone that asked for it')
  assert.equal((await signInWith(token, { nonce: sha(NONCE) })).status, 401, 'someone holding only the token, guessing the hash as the nonce')
})

test('an unknown way of signing in is not a way in', async () => {
  const res = await signInWith(await identityToken(), { provider: 'facebook' })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'UNSUPPORTED_PROVIDER')
  for (const provider of [undefined, null, 7, {}, '__proto__', 'constructor', 'toString']) {
    const r = await stack.api('POST', '/api/auth/oauth', { body: { provider, idToken: await identityToken(), nonce: NONCE }, headers: { 'x-forwarded-for': nextIp() } })
    assert.equal(r.status, 400, `provider ${JSON.stringify(provider)}`)
    assert.equal(r.body.code, 'UNSUPPORTED_PROVIDER')
  }
})

test('not configured: answers "not available", and says nothing about tokens', async () => {
  const saved = process.env.APPLE_CLIENT_IDS
  process.env.APPLE_CLIENT_IDS = ''
  try {
    const res = await signInWith(await identityToken())
    assert.equal(res.status, 503)
    assert.equal(res.body.code, 'OAUTH_NOT_CONFIGURED')
    assert.match(res.body.error, /Apple/)
    assert.equal(apple.appleConfigured(), false)
  } finally { process.env.APPLE_CLIENT_IDS = saved }
})

test('Apple\'s keys cannot be fetched: "try again", not "your token is bad"', async () => {
  const saved = process.env.APPLE_JWKS_URL
  try {
    process.env.APPLE_JWKS_URL = `${appleBase}/broken`                       // answers 500
    assert.equal((await signInWith(await identityToken())).body.code, 'OAUTH_UNAVAILABLE')
    process.env.APPLE_JWKS_URL = 'http://127.0.0.1:1/auth/keys'              // nothing listens
    const res = await signInWith(await identityToken())
    assert.equal(res.status, 503)
    assert.equal(res.body.code, 'OAUTH_UNAVAILABLE')
  } finally { process.env.APPLE_JWKS_URL = saved }
  assert.equal((await signInWith(await identityToken())).status, 200, 'and it works again once the keys are back')
})

test('sign-ins are limited per caller', async () => {
  const ip = '10.78.0.1'
  const token = await identityToken()
  let last
  for (let i = 0; i < 31; i++) last = await signInWith(token, { ip })
  assert.equal(last.status, 429)
  assert.equal((await signInWith(token, { ip: '10.78.0.2' })).status, 200, 'another caller is unaffected')
})

test('the nonce is the SHA-256 of the app\'s string, in hex', () => {
  assert.equal(apple.nonceClaimFor('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.deepEqual(apple.appleAudiences(), [BUNDLE, OTHER_CLIENT])
})

// ── An account with no password ─────────────────────────────────────────────

test('no password can ever sign in to an Apple account, and its address cannot be signed up again', async () => {
  const made = await signInWith(await identityToken())
  for (const password of ['', 'a-long-test-password-1', 'null', 'undefined', 'x'.repeat(40)]) {
    const res = await stack.api('POST', '/api/auth/login', { body: { email: 'ada@icloud.example', password }, headers: { 'x-forwarded-for': nextIp() } })
    assert.equal(res.status, password ? 401 : 400, `password "${password.slice(0, 10)}"`)
  }
  const signUp = await stack.api('POST', '/api/auth/signup', { body: { email: 'ada@icloud.example', password: 'a-long-test-password-1' }, headers: { 'x-forwarded-for': nextIp() } })
  assert.equal(signUp.status, 409)
  assert.equal((await userByEmail('ada@icloud.example')).password_hash, null, 'sign-up did not give it a password')
  assert.ok(made.body.session)
})

test('change password: an Apple account is told it has none to change', async () => {
  const made = await signInWith(await identityToken())
  const res = await stack.api('POST', '/api/auth/change-password', { token: made.body.session.accessToken, body: { currentPassword: 'a-long-test-password-1', newPassword: 'a-brand-new-password-2' } })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'NO_PASSWORD')
})

// ── Deleting the account ────────────────────────────────────────────────────

const deleteWith = (token, body) => stack.api('POST', '/api/account/delete', { token, body, headers: { 'x-forwarded-for': nextIp() } })
const proof = async (overrides = {}, tokenOptions = {}) => ({ provider: 'apple', idToken: await identityToken(tokenOptions), nonce: NONCE, authorizationCode: 'c-one-time-code', ...overrides })

test('deleting an Apple account asks for a fresh Apple sign-in, and only THIS account\'s Apple will do', async () => {
  const made = await signInWith(await identityToken())
  const token = made.body.session.accessToken
  const userId = made.body.session.user.id

  const none = await deleteWith(token, {})
  assert.equal(none.status, 400)
  assert.equal(none.body.code, 'REAUTH_REQUIRED')
  assert.match(none.body.error, /Sign in with Apple again/, 'it says WHICH sign-in')
  assert.equal((await deleteWith(token, { password: 'a-long-test-password-1' })).status, 403, 'there is no password to match')

  const someoneElse = await deleteWith(token, { oauth: await proof({}, { sub: 'apple-other', email: 'other@icloud.example' }) })
  assert.equal(someoneElse.status, 403)
  assert.equal(someoneElse.body.code, 'WRONG_ACCOUNT')
  assert.match(someoneElse.body.error, /Apple/)
  const forged = await deleteWith(token, { oauth: await proof({}, { key: stranger.privateKey }) })
  assert.equal(forged.status, 401)
  const wrongNonce = await deleteWith(token, { oauth: await proof({ nonce: 'z'.repeat(40) }) })
  assert.equal(wrongNonce.status, 401, 'the fresh sign-in must be the one the phone just made')
  assert.ok(await stack.one('select 1 from users where id = $1', [userId]), 'nothing was deleted by any of those')
  assert.equal(asked.length, 0, 'and Apple was not asked to revoke anything for any of them')

  const ok = await deleteWith(token, { oauth: await proof() })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(await stack.one('select 1 from users where id = $1', [userId]), null)
  assert.equal((await identitiesOf(userId)).length, 0, 'the identity goes with the account')
  assert.equal((await me(token)).status, 401)
  const again = await signInWith(await identityToken())
  assert.equal(again.body.isNewAccount, true, 'the same Apple account can start again, as a brand-new account')
  assert.notEqual(again.body.session.user.id, userId)
})

test('deleting it REVOKES the person\'s Apple tokens: the code is traded, the refresh token revoked, the client secret is signed as Apple wants', async () => {
  const made = await signInWith(await identityToken())
  const res = await deleteWith(made.body.session.accessToken, { oauth: await proof() })
  assert.equal(res.status, 200, JSON.stringify(res.body))

  assert.deepEqual(asked.map(a => a.path), ['/auth/token', '/auth/revoke'])
  const [exchange, revoke] = asked
  assert.equal(exchange.type, 'application/x-www-form-urlencoded')
  assert.equal(exchange.fields.grant_type, 'authorization_code')
  assert.equal(exchange.fields.code, 'c-one-time-code')
  assert.equal(exchange.fields.client_id, BUNDLE, 'the app\'s bundle id, the first of the client ids')
  assert.equal(revoke.fields.token, 'rt-1')
  assert.equal(revoke.fields.token_type_hint, 'refresh_token')
  assert.equal(revoke.fields.client_id, BUNDLE)

  // The client secret is a short-lived ES256 JWT from our team, made with our key, for Apple, about this app.
  for (const call of asked) {
    assert.equal(decodeProtectedHeader(call.fields.client_secret).kid, KEY_ID)
    const { payload, protectedHeader } = await jwtVerify(call.fields.client_secret, signer.publicKey, {
      issuer: TEAM, audience: ISSUER, subject: BUNDLE, algorithms: ['ES256'],
    })
    assert.equal(protectedHeader.alg, 'ES256')
    assert.ok(payload.exp - payload.iat <= 300, 'good for minutes, not months')
  }
})

test('with only an access token to revoke, that is what is revoked', async () => {
  answers.token = { status: 200, body: { access_token: 'at-only', token_type: 'Bearer', expires_in: 3600 } }
  const made = await signInWith(await identityToken())
  assert.equal((await deleteWith(made.body.session.accessToken, { oauth: await proof() })).status, 200)
  assert.equal(asked[1].fields.token, 'at-only')
  assert.equal(asked[1].fields.token_type_hint, 'access_token')
})

test('revoking never stands between a person and the deletion of their account', async () => {
  let n = 0
  /** Delete a new Apple account with a fresh Apple sign-in carrying `overrides`; the account must be gone afterwards. */
  const deleteOne = async (overrides = {}) => {
    const who = { sub: `apple-del-${++n}`, email: `del${n}@icloud.example` }
    const made = await signInWith(await identityToken(who))
    const userId = made.body.session.user.id
    const res = await deleteWith(made.body.session.accessToken, { oauth: await proof(overrides, who) })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(await stack.one('select 1 from users where id = $1', [userId]), null)
  }

  // Apple refuses the code (used already, or too old).
  answers.token = { status: 400, body: { error: 'invalid_grant' } }
  await deleteOne()
  assert.deepEqual(asked.map(a => a.path), ['/auth/token'], 'nothing was revoked, and nothing more was asked')

  // Apple accepts the code and then refuses the revocation.
  asked.length = 0
  answers.token = { status: 200, body: { refresh_token: 'rt-2' } }
  answers.revoke = { status: 500 }
  await deleteOne()
  assert.deepEqual(asked.map(a => a.path), ['/auth/token', '/auth/revoke'])

  // Apple gives no token at all.
  asked.length = 0
  answers.token = { status: 200, body: {} }
  await deleteOne()
  assert.deepEqual(asked.map(a => a.path), ['/auth/token'])

  // The app sent no authorization code: Apple is not asked anything.
  asked.length = 0
  await deleteOne({ authorizationCode: undefined })
  assert.equal(asked.length, 0)

  // Apple cannot be reached.
  const savedBase = process.env.APPLE_AUTH_BASE_URL
  process.env.APPLE_AUTH_BASE_URL = 'http://127.0.0.1:1'
  try {
    await deleteOne()
  } finally { process.env.APPLE_AUTH_BASE_URL = savedBase }

  // The server has no Sign in with Apple key yet: deleting works, nothing is asked.
  asked.length = 0
  const savedKey = process.env.APPLE_PRIVATE_KEY
  process.env.APPLE_PRIVATE_KEY = ''
  try {
    await deleteOne()
    assert.equal(asked.length, 0)
    assert.equal(apple.appleRevocationConfigured(), false)
    assert.deepEqual(await apple.revokeAppleSignIn('anything'), { revoked: false, reason: 'not configured (APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY)' })
  } finally { process.env.APPLE_PRIVATE_KEY = savedKey }

  // A key that is not a key: still deleted.
  process.env.APPLE_PRIVATE_KEY = 'this is not a PEM file'
  try {
    await deleteOne()
    const outcome = await apple.revokeAppleSignIn('code')
    assert.equal(outcome.revoked, false)
    assert.ok(!outcome.reason.includes('this is not a PEM file'), 'the key is never put in a message')
  } finally { process.env.APPLE_PRIVATE_KEY = savedKey }
})

test('an account WITH a password and Apple joined still deletes with its password, and Apple is not troubled', async () => {
  const owner = await stack.createUser({ email: 'ada@icloud.example', password: 'owners-own-password-1' })
  await signInWith(await identityToken())
  assert.equal((await deleteWith(owner.token, {})).body.code, 'PASSWORD_REQUIRED')
  assert.equal((await deleteWith(owner.token, { password: 'wrong-password-123' })).status, 403)
  assert.equal((await deleteWith(owner.token, { password: 'owners-own-password-1' })).status, 200)
  assert.equal(asked.length, 0)
})

test('the provider named decides which checks run: an Apple token offered as Google is never accepted', async () => {
  const made = await signInWith(await identityToken())
  // Google is not set up on this server, so it is refused as "not available"; with it set up the token would still fail Google's checks.
  const res = await deleteWith(made.body.session.accessToken, { oauth: { provider: 'google', idToken: await identityToken() } })
  assert.notEqual(res.status, 200)
  assert.ok(await userByEmail('ada@icloud.example'), 'nothing was deleted')
})
