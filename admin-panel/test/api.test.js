// The panel's connection to the server, against a scripted fetch and a clock the test owns.

import test from 'node:test'
import assert from './assert.js'

import { createApi, ApiError, queryString, SESSION_ENDED } from '../lib/api.js'

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const issued = (n, { expiresIn = 3600 } = {}) => ({
  accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresIn, user: { id: 'u1', email: 'boss@test.example' },
})

/**
 * A fetch driven by a function of the request, plus a log of every request made.
 * `handler(req)` returns a Response (or a promise of one), or throws.
 */
function harness(handler) {
  const calls = []
  let clock = 1_000_000
  const ended = []
  const fetchImpl = async (url, init = {}) => {
    const req = {
      url, method: init.method, signal: init.signal,
      auth: init.headers?.Authorization ?? null,
      body: init.body ? JSON.parse(init.body) : null,
    }
    calls.push(req)
    return handler(req, calls.length)
  }
  const api = createApi({ fetchImpl, now: () => clock, onSessionEnded: message => ended.push(message) })
  return { api, calls, ended, advance: ms => { clock += ms }, paths: () => calls.map(c => `${c.method} ${c.url}`) }
}

const OK = json(200, { ok: true })

async function signedIn(handler, opts) {
  let n = 0
  const h = harness((req, i) => {
    if (req.url === '/api/auth/login') return json(200, { session: issued(++n, opts) })
    return handler(req, i)
  })
  await h.api.login('boss@test.example', 'x')
  h.calls.length = 0
  return h
}

// ── Signing in ───────────────────────────────────────────────────────────────

test('login sends the credentials, keeps the session, and returns the user', async () => {
  const h = harness(() => json(200, { session: issued(1) }))
  const user = await h.api.login('boss@test.example', 'pw')
  assert.deepEqual(user, { id: 'u1', email: 'boss@test.example' })
  assert.equal(h.api.isSignedIn(), true)
  assert.deepEqual(h.api.user, user)
  assert.deepEqual(h.calls[0].body, { email: 'boss@test.example', password: 'pw', scope: 'admin' }, "the panel says it is the panel: an administrator gets an admin session, nobody else gets one")
  assert.equal(h.calls[0].auth, null, 'no token is sent to sign in')
  assert.equal(h.calls[0].url, '/api/auth/login')
})

test('a refused login says what the server said and leaves the panel signed out', async () => {
  const h = harness(() => json(401, { error: 'Incorrect email or password.', code: 'INVALID_CREDENTIALS' }))
  await assert.rejects(h.api.login('a@b.c', 'bad'), e => e instanceof ApiError && e.status === 401 && e.code === 'INVALID_CREDENTIALS' && e.message === 'Incorrect email or password.')
  assert.equal(h.api.isSignedIn(), false)
  assert.equal(h.api.user, null)
  assert.deepEqual(h.ended, [], 'there was no session to end')
})

test('login failures that are not the server\'s words are still plain', async () => {
  const net = harness(() => { throw new TypeError('Failed to fetch') })
  await assert.rejects(net.api.login('a', 'b'), e => e.code === 'NETWORK' && /Could not reach the server/.test(e.message))

  const html = harness(() => new Response('<html>Bad gateway</html>', { status: 502 }))
  await assert.rejects(html.api.login('a', 'b'), e => e.status === 502 && e.code === 'HTTP_502' && e.message === 'The server answered 502.')

  const odd = harness(() => json(200, { nothing: true }))
  await assert.rejects(odd.api.login('a', 'b'), e => e.code === 'BAD_RESPONSE')
  assert.equal(odd.api.isSignedIn(), false)
})

test('a missing expiry is treated as an hour, not as already expired', async () => {
  const h = harness(req => (req.url === '/api/auth/login'
    ? json(200, { session: { accessToken: 'a', refreshToken: 'r', user: { id: 'u' } } })
    : OK))
  await h.api.login('a', 'b')
  h.calls.length = 0
  await h.api.get('/api/x')
  assert.deepEqual(h.paths(), ['GET /api/x'], 'no renewal was attempted first')
})

// ── Ordinary requests ────────────────────────────────────────────────────────

test('requests carry the bearer token, and the query leaves out what is empty', async () => {
  const h = await signedIn(() => OK)
  await h.api.get('/api/admin/users', { q: 'mia', page: 2, status: '', sort: undefined, dir: null, zero: 0, no: false })
  assert.equal(h.calls[0].url, '/api/admin/users?q=mia&page=2&zero=0&no=false')
  assert.equal(h.calls[0].auth, 'Bearer access-1')
  assert.equal(h.calls[0].method, 'GET')
})

test('post sends JSON, and an absent body is an empty object', async () => {
  const h = await signedIn(() => OK)
  await h.api.post('/api/admin/users/suspend', { userId: 'x', reason: 'r' })
  await h.api.post('/api/admin/users/unsuspend')
  assert.deepEqual(h.calls[0].body, { userId: 'x', reason: 'r' })
  assert.deepEqual(h.calls[1].body, {})
})

test('queryString: encodes, skips empty, and is "" for nothing', () => {
  assert.equal(queryString({}), '')
  assert.equal(queryString(null), '')
  assert.equal(queryString(undefined), '')
  assert.equal(queryString({ a: '' }), '')
  assert.equal(queryString({ q: 'a b&c=d/é' }), '?q=a+b%26c%3Dd%2F%C3%A9')
  assert.equal(queryString({ n: 0, f: false, t: true }), '?n=0&f=false&t=true')
})

test('a server error carries its message, status and code; an unreadable one is described by status', async () => {
  const h = await signedIn(req => (req.url.endsWith('/a')
    ? json(400, { error: 'userId is required.', code: 'BAD_REQUEST' })
    : new Response('oops', { status: 500 })))
  await assert.rejects(h.api.get('/api/admin/a'), e => e.status === 400 && e.code === 'BAD_REQUEST' && e.message === 'userId is required.')
  await assert.rejects(h.api.get('/api/zzz'), e => e.status === 500 && e.code === 'HTTP_500' && /500/.test(e.message))
})

test('a body that is not the documented shape does not break the reader', async () => {
  const h = await signedIn(() => json(400, { error: 123, code: ['x'] }))
  await assert.rejects(h.api.get('/api/x'), e => e.status === 400 && e.code === 'HTTP_400' && e.message === 'The server answered 400.')
})

test('204 is fine and gives nothing back', async () => {
  const h = await signedIn(() => new Response(null, { status: 204 }))
  assert.equal(await h.api.post('/api/x', {}), null)
})

test('a lost connection is NETWORK, and is not the end of the session', async () => {
  const h = await signedIn(() => { throw new TypeError('Failed to fetch') })
  await assert.rejects(h.api.get('/api/x'), e => e.code === 'NETWORK')
  assert.equal(h.api.isSignedIn(), true)
  assert.deepEqual(h.ended, [])
})

test('an abort passes straight through, untranslated, so callers can ignore it', async () => {
  const h = await signedIn(() => { throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }) })
  await assert.rejects(h.api.get('/api/x', null, { signal: new AbortController().signal }), e => e.name === 'AbortError')
  assert.equal(h.api.isSignedIn(), true)
})

test('the signal reaches fetch', async () => {
  const h = await signedIn(() => OK)
  const controller = new AbortController()
  await h.api.get('/api/x', null, { signal: controller.signal })
  assert.equal(h.calls[0].signal, controller.signal)
})

test('with no session nothing is sent', async () => {
  const h = harness(() => OK)
  await assert.rejects(h.api.get('/api/x'), e => e.status === 401 && e.code === 'NOT_AUTHENTICATED')
  await assert.rejects(h.api.post('/api/x'), e => e.code === 'NOT_AUTHENTICATED')
  assert.equal(h.calls.length, 0)
})

// ── Renewing the token ───────────────────────────────────────────────────────

test('a token about to expire is renewed first, and the renewed one is used', async () => {
  const h = await signedIn((req) => (req.url === '/api/auth/refresh' ? json(200, { session: issued(2) }) : OK))
  h.advance(3600 * 1000 - 30_000)   // 30 seconds left
  await h.api.get('/api/admin/stats')
  assert.deepEqual(h.paths(), ['POST /api/auth/refresh', 'GET /api/admin/stats'])
  assert.deepEqual(h.calls[0].body, { refreshToken: 'refresh-1' })
  assert.equal(h.calls[1].auth, 'Bearer access-2')
})

test('a token with plenty of life is left alone', async () => {
  const h = await signedIn(() => OK)
  h.advance(10 * 60 * 1000)
  await h.api.get('/api/x')
  assert.deepEqual(h.paths(), ['GET /api/x'])
})

test('the edge: exactly 60 seconds left is not yet renewed, 59 is', async () => {
  const h = await signedIn((req) => (req.url === '/api/auth/refresh' ? json(200, { session: issued(2) }) : OK))
  h.advance(3600 * 1000 - 60_000)
  await h.api.get('/api/x')
  assert.deepEqual(h.paths(), ['GET /api/x'])
  h.advance(1000)
  await h.api.get('/api/x')
  assert.deepEqual(h.paths(), ['GET /api/x', 'POST /api/auth/refresh', 'GET /api/x'])
})

test('several requests that all find the token expired cause ONE refresh — the server treats a second use of the old token as theft', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const h = await signedIn(async (req) => {
    if (req.url === '/api/auth/refresh') { await gate; return json(200, { session: issued(2) }) }
    return OK
  })
  h.advance(3600 * 1000 + 1)

  const pending = [h.api.get('/api/a'), h.api.get('/api/b'), h.api.get('/api/c'), h.api.post('/api/d', {})]
  await new Promise(r => setTimeout(r, 20))
  assert.equal(h.calls.filter(c => c.url === '/api/auth/refresh').length, 1, 'one refresh in flight, however many are waiting')
  release()
  await Promise.all(pending)

  assert.equal(h.calls.filter(c => c.url === '/api/auth/refresh').length, 1)
  const work = h.calls.filter(c => c.url !== '/api/auth/refresh')
  assert.equal(work.length, 4)
  assert.ok(work.every(c => c.auth === 'Bearer access-2'), 'every request used the NEW token')
})

test('several requests the server refuses at once also cause one refresh', async () => {
  let refreshes = 0
  const h = await signedIn(req => {
    if (req.url === '/api/auth/refresh') { refreshes++; return json(200, { session: issued(2) }) }
    return req.auth === 'Bearer access-1' ? json(401, { error: 'Please sign in to continue.', code: 'NOT_AUTHENTICATED' }) : OK
  })
  await Promise.all([h.api.get('/api/a'), h.api.get('/api/b'), h.api.get('/api/c')])
  assert.equal(refreshes, 1)
  assert.equal(h.api.isSignedIn(), true)
})

test('a refused token is renewed once and the request retried with the new one', async () => {
  const h = await signedIn(req => {
    if (req.url === '/api/auth/refresh') return json(200, { session: issued(2) })
    return req.auth === 'Bearer access-1' ? json(401, { error: 'Please sign in to continue.', code: 'NOT_AUTHENTICATED' }) : json(200, { fine: true })
  })
  assert.deepEqual(await h.api.get('/api/x'), { fine: true })
  assert.deepEqual(h.paths(), ['GET /api/x', 'POST /api/auth/refresh', 'GET /api/x'])
})

test('the refresh token rotates: the next renewal uses the newest, never an old one', async () => {
  let n = 1
  const h = await signedIn(req => (req.url === '/api/auth/refresh' ? json(200, { session: issued(++n) }) : OK))
  h.advance(3600 * 1000 + 1); await h.api.get('/api/x')
  h.advance(3600 * 1000 + 1); await h.api.get('/api/x')
  const refreshes = h.calls.filter(c => c.url === '/api/auth/refresh')
  assert.deepEqual(refreshes.map(c => c.body.refreshToken), ['refresh-1', 'refresh-2'])
})

test('if the renewal is refused the session is over, once, with the standard message', async () => {
  const h = await signedIn(req => (req.url === '/api/auth/refresh'
    ? json(401, { error: 'Your session has expired. Please sign in again.', code: 'SESSION_EXPIRED' })
    : json(401, { error: 'Please sign in to continue.', code: 'NOT_AUTHENTICATED' })))
  await assert.rejects(h.api.get('/api/x'), e => e instanceof ApiError)
  assert.deepEqual(h.ended, [SESSION_ENDED])
  assert.equal(h.api.isSignedIn(), false)

  const before = h.calls.length
  await assert.rejects(h.api.get('/api/y'), e => e.code === 'NOT_AUTHENTICATED')
  assert.equal(h.calls.length, before, 'nothing more is sent once signed out')
  assert.equal(h.ended.length, 1, 'the end of the session is announced once')
})

test('if the retry is refused as well, the session is over — no loop', async () => {
  const h = await signedIn(req => (req.url === '/api/auth/refresh'
    ? json(200, { session: issued(2) })
    : json(401, { error: 'Please sign in to continue.', code: 'NOT_AUTHENTICATED' })))
  await assert.rejects(h.api.get('/api/x'), e => e.status === 401)
  assert.equal(h.calls.filter(c => c.url === '/api/auth/refresh').length, 1, 'renewed once, not again')
  assert.equal(h.api.isSignedIn(), false)
  assert.equal(h.ended.length, 1)
})

test('a renewal that cannot reach the server leaves the person signed in', async () => {
  const h = await signedIn(req => { if (req.url === '/api/auth/refresh') throw new TypeError('Failed to fetch'); return OK })
  h.advance(3600 * 1000 + 1)
  await assert.rejects(h.api.get('/api/x'), e => e.code === 'NETWORK')
  assert.equal(h.api.isSignedIn(), true)
  assert.deepEqual(h.ended, [])
})

test('a renewal answered with garbage ends the session rather than carrying on without a token', async () => {
  const h = await signedIn(req => (req.url === '/api/auth/refresh' ? json(200, { not: 'a session' }) : OK))
  h.advance(3600 * 1000 + 1)
  await assert.rejects(h.api.get('/api/x'))
  assert.equal(h.api.isSignedIn(), false)
})

test('a server error on the renewal (5xx) does not sign the person out', async () => {
  const h = await signedIn(req => (req.url === '/api/auth/refresh' ? json(503, { error: 'Try later.', code: 'SERVICE_UNAVAILABLE' }) : OK))
  h.advance(3600 * 1000 + 1)
  await assert.rejects(h.api.get('/api/x'), e => e.status === 503)
  assert.equal(h.api.isSignedIn(), true)
})

// ── Other refusals ───────────────────────────────────────────────────────────

test('a suspended administrator is signed out with the server\'s own words', async () => {
  const h = await signedIn(() => json(403, { error: 'Your account has been suspended.', code: 'ACCOUNT_SUSPENDED' }))
  await assert.rejects(h.api.get('/api/x'), e => e.code === 'ACCOUNT_SUSPENDED')
  assert.deepEqual(h.ended, ['Your account has been suspended.'])
  assert.equal(h.api.isSignedIn(), false)
})

test('"not an administrator" is an error but not a sign-out (the sign-in screen handles it)', async () => {
  const h = await signedIn(() => json(403, { error: 'This area is for administrators.', code: 'NOT_ADMIN' }))
  await assert.rejects(h.api.get('/api/admin/stats'), e => e.code === 'NOT_ADMIN')
  assert.equal(h.api.isSignedIn(), true)
  assert.deepEqual(h.ended, [])
})

test('ordinary refusals (400, 404, 409, 429) leave the session alone', async () => {
  for (const status of [400, 403, 404, 409, 422, 429]) {
    const h = await signedIn(() => json(status, { error: 'No.', code: 'NOPE' }))
    await assert.rejects(h.api.get('/api/x'), e => e.status === status)
    assert.equal(h.api.isSignedIn(), true, String(status))
  }
})

// ── Signing out ──────────────────────────────────────────────────────────────

test('logout tells the server which session to end, then forgets everything', async () => {
  const h = await signedIn(() => new Response(null, { status: 204 }))
  await h.api.logout()
  assert.equal(h.api.isSignedIn(), false)
  assert.equal(h.calls[0].url, '/api/auth/logout')
  assert.deepEqual(h.calls[0].body, { refreshToken: 'refresh-1' })
  assert.equal(h.calls[0].auth, 'Bearer access-1')
  await assert.rejects(h.api.get('/api/x'), e => e.code === 'NOT_AUTHENTICATED')
})

test('logout never throws and always signs out locally — even when the server cannot be reached', async () => {
  const h = await signedIn(() => { throw new TypeError('Failed to fetch') })
  await assert.doesNotReject(h.api.logout())
  assert.equal(h.api.isSignedIn(), false)
  assert.deepEqual(h.ended, [], 'a deliberate sign-out is not "the session ended"')
})

test('logging out with nothing to log out of sends nothing', async () => {
  const h = harness(() => OK)
  await h.api.logout()
  assert.equal(h.calls.length, 0)
})

test('after a sign-out a stale in-flight refresh cannot bring the session back', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const h = await signedIn(async req => {
    if (req.url === '/api/auth/refresh') { await gate; return json(200, { session: issued(9) }) }
    return OK
  })
  h.advance(3600 * 1000 + 1)
  const pending = h.api.get('/api/x').catch(e => e)
  await new Promise(r => setTimeout(r, 10))
  await h.api.logout()
  release()
  await pending
  // The refresh finishing later may install a token, but the request that waited
  // for it must not have been sent as the signed-out person.
  assert.ok(!h.calls.some(c => c.url === '/api/x'), 'no request was made after the sign-out')
})
