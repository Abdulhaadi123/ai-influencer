// The app and the admin panel are different places (sessions.js, "Scope"): an administrator account
// signs in to the panel and cannot sign in to the app; every other account signs in to the app and
// cannot get a panel session. What each kind of session may call is checked on every request, so a
// role changed in the panel takes effect on the next call.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack } from '../helpers/stack.js'
import { publicRoute } from '../../api/_lib/http.js'

let stack
before(async () => { stack = await startStack() })
after(async () => { await stack?.stop() })
beforeEach(async () => { await stack.reset() })

const ADMIN_PASSWORD = 'a-long-admin-password-1'
const USER_PASSWORD = 'a-long-user-password-1'

const APP_ENDPOINT = '/api/billing/me'      // an ordinary app endpoint
const ADMIN_ENDPOINT = '/api/admin/stats'   // an ordinary panel endpoint
const SHARED_ENDPOINT = '/api/auth/me'      // about the caller's own account: either kind of session

const login = (email, password, scope) => stack.api('POST', '/api/auth/login', { body: { email, password, ...(scope ? { scope } : {}) } })
const call = (path, who) => stack.api('GET', path, { token: who.token })
const scopesOf = userId => stack.sql('select scope from sessions where user_id = $1 order by created_at', [userId]).then(rows => rows.map(r => r.scope))
const noSessions = userId => stack.sql('delete from sessions where user_id = $1', [userId])

const admin = () => stack.createUser({ role: 'admin', password: ADMIN_PASSWORD })
const ordinary = () => stack.createUser({ password: USER_PASSWORD })

// ── Signing in ───────────────────────────────────────────────────────────────

test('an administrator account is refused at the app\'s sign-in — after the right password, with no session made', async () => {
  const boss = await admin()
  await noSessions(boss.id)

  const wrong = await login(boss.email, 'not-the-password-1')
  assert.equal(wrong.status, 401)
  assert.equal(wrong.body.code, 'INVALID_CREDENTIALS', 'a wrong password says nothing about the role')

  for (const scope of [undefined, 'app', 'something-else']) {
    const res = await login(boss.email, boss.password, scope)
    assert.equal(res.status, 403, `scope ${scope}`)
    assert.equal(res.body.code, 'ADMIN_ACCOUNT')
    assert.match(res.body.error, /admin panel/i)
  }
  assert.deepEqual(await scopesOf(boss.id), [], 'no session was made')
})

test('the panel\'s sign-in lets administrators in and nobody else, and gives them an admin session', async () => {
  const boss = await admin()
  const mia = await ordinary()
  await stack.sql('delete from sessions')

  const refused = await login(mia.email, mia.password, 'admin')
  assert.equal(refused.status, 403)
  assert.equal(refused.body.code, 'NOT_ADMIN')
  assert.equal((await login(mia.email, 'not-the-password-1', 'admin')).status, 401, 'a wrong password is still just a wrong password')
  assert.deepEqual(await scopesOf(mia.id), [], 'an ordinary account never gets an admin session')

  const ok = await login(boss.email, boss.password, 'admin')
  assert.equal(ok.status, 200)
  assert.deepEqual(await scopesOf(boss.id), ['admin'])
  assert.equal((await call(ADMIN_ENDPOINT, { token: ok.body.session.accessToken })).status, 200)
})

test('an ordinary account signs in to the app as it always did, and gets an app session', async () => {
  const mia = await ordinary()
  await noSessions(mia.id)

  for (const scope of [undefined, 'app']) {
    const res = await login(mia.email, mia.password, scope)
    assert.equal(res.status, 200, `scope ${scope}`)
    assert.equal((await call(APP_ENDPOINT, { token: res.body.session.accessToken })).status, 200)
  }
  assert.deepEqual(await scopesOf(mia.id), ['app', 'app'])
})

// ── What each kind of session may call ───────────────────────────────────────

test('an admin session is refused by the app\'s endpoints, but may read and change its own account', async () => {
  const boss = await admin()

  const refused = await call(APP_ENDPOINT, boss)
  assert.equal(refused.status, 401)
  assert.equal(refused.body.code, 'NOT_AUTHENTICATED', 'an admin token is not a session for the app')

  const me = await call(SHARED_ENDPOINT, boss)
  assert.equal(me.status, 200)
  assert.equal(me.body.user.email, boss.email)
  assert.ok(!('scope' in me.body.user) && !('role' in me.body.user), 'the server\'s own checks are not shown')

  const change = await stack.api('POST', '/api/auth/change-password', {
    token: boss.token, body: { currentPassword: boss.password, newPassword: 'another-long-password-2' },
  })
  assert.equal(change.status, 200, 'an administrator changes their own password on an admin session')
  assert.equal((await login(boss.email, 'another-long-password-2', 'admin')).status, 200)
})

test('an app session is refused by the panel: 403 for an ordinary account, 401 for an administrator holding a stale one', async () => {
  const mia = await ordinary()
  const notAdmin = await call(ADMIN_ENDPOINT, mia)
  assert.equal(notAdmin.status, 403)
  assert.equal(notAdmin.body.code, 'NOT_ADMIN')

  // An app session that belongs to an administrator (it predates the split, or the account was promoted).
  const stale = await stack.createUser({ role: 'admin', scope: 'app' })
  const refused = await call(ADMIN_ENDPOINT, stale)
  assert.equal(refused.status, 401)
  assert.equal(refused.body.code, 'NOT_AUTHENTICATED', 'the panel shows its sign-in')
  assert.equal((await call(APP_ENDPOINT, stale)).status, 401, 'and the app does not take an administrator either')
  assert.equal((await call(SHARED_ENDPOINT, stale)).status, 401)
})

test('promoting an account ends its app sessions, demoting one ends its admin sessions — on the next call', async () => {
  const mia = await ordinary()
  assert.equal((await call(APP_ENDPOINT, mia)).status, 200)

  await stack.sql(`update users set role = 'admin' where id = $1`, [mia.id])
  assert.equal((await call(APP_ENDPOINT, mia)).status, 401, 'promoted: the phone is signed out of the app')
  assert.equal((await call(ADMIN_ENDPOINT, mia)).status, 401, 'and the app session is not a panel session')
  assert.equal((await login(mia.email, mia.password)).body.code, 'ADMIN_ACCOUNT', 'signing in again explains why')

  const panel = await login(mia.email, mia.password, 'admin')
  assert.equal((await call(ADMIN_ENDPOINT, { token: panel.body.session.accessToken })).status, 200)

  await stack.sql(`update users set role = 'user' where id = $1`, [mia.id])
  const token = panel.body.session.accessToken
  assert.equal((await call(ADMIN_ENDPOINT, { token })).status, 403, 'demoted: the panel stops at once')
  assert.equal((await call(APP_ENDPOINT, { token })).status, 401, 'an admin session never works in the app')
  assert.equal((await login(mia.email, mia.password)).status, 200, 'and the account is an app account again')
})

// ── The session keeps its scope ──────────────────────────────────────────────

test('refreshing keeps the session\'s scope', async () => {
  const boss = await admin()
  const renewed = await stack.api('POST', '/api/auth/refresh', { body: { refreshToken: boss.refreshToken } })
  assert.equal(renewed.status, 200)
  const fresh = { token: renewed.body.session.accessToken }
  assert.equal((await call(ADMIN_ENDPOINT, fresh)).status, 200)
  assert.equal((await call(APP_ENDPOINT, fresh)).status, 401)
  assert.deepEqual(await scopesOf(boss.id), ['admin'])

  const mia = await ordinary()
  const renewedApp = await stack.api('POST', '/api/auth/refresh', { body: { refreshToken: mia.refreshToken } })
  const freshApp = { token: renewedApp.body.session.accessToken }
  assert.equal((await call(APP_ENDPOINT, freshApp)).status, 200)
  assert.equal((await call(ADMIN_ENDPOINT, freshApp)).status, 403)
  assert.deepEqual(await scopesOf(mia.id), ['app'])
})

test('an admin session can sign itself out', async () => {
  const boss = await admin()
  const out = await stack.api('POST', '/api/auth/logout', { token: boss.token, body: { refreshToken: boss.refreshToken } })
  assert.equal(out.status, 204)
  assert.equal((await call(ADMIN_ENDPOINT, boss)).status, 401)
})

// ── A neighbour found on the way ─────────────────────────────────────────────

test('a route declared without options still answers an unexpected failure with JSON (it used to throw inside its own error handler)', async () => {
  const sent = {}
  const res = { status(code) { sent.status = code; return this }, json(body) { sent.body = body; return this }, setHeader() {} }
  await publicRoute(async () => { throw new Error('boom: something nobody expected') })({ headers: {} }, res)
  assert.equal(sent.status, 500)
  assert.equal(sent.body.code, 'INTERNAL')
  assert.ok(typeof sent.body.error === 'string' && sent.body.error.length > 0)
  assert.ok(!/boom/.test(sent.body.error), 'the client gets a sentence, never the internals')
})
