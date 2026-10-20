// Security: who may call every route the server registers.
//
// The routes are read from the real Express app, not from a list kept by hand, so a route added
// tomorrow is covered the day it is added. Anything that is not on the PUBLIC / WEBHOOK / panel
// lists below must refuse a caller with no session — a new endpoint that forgets its guard fails here.
//
// Four callers are tried on each kind of route:
//   nobody · a made-up token · an ordinary account's app session · an administrator's panel session
// plus the two awkward ones: an administrator holding an APP session (promoted after signing in)
// and a suspended account.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { startStack } from '../helpers/stack.js'
import { ADMIN_UI_PATHS } from '../../api/admin/ui.js'

const KIE_SECRET = 'route-matrix-kie-secret'
const RC_AUTH = 'route-matrix-revenuecat-auth'

let stack
let routes
let ordinary, boss, staleBoss, suspended

before(async () => {
  stack = await startStack({ env: { KIE_WEBHOOK_SECRET: KIE_SECRET, REVENUECAT_WEBHOOK_AUTH: RC_AUTH, PUBLIC_BASE_URL: 'https://api.test.example' } })
  const { createApp } = await stack.load('server/index.js')
  routes = listRoutes(createApp())

  ordinary = await stack.createUser()
  boss = await stack.createUser({ role: 'admin' })
  staleBoss = await stack.createUser({ role: 'admin', scope: 'app' })
  suspended = await stack.createUser({ status: 'suspended' })
})
after(async () => { await stack?.stop() })

/** Every route of the app as { methods, path } — a RegExp path is turned into the one URL it is for. */
function listRoutes(app) {
  const stackOfLayers = (app.router || app._router).stack
  const found = []
  for (const layer of stackOfLayers) {
    if (!layer.route) continue
    const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]).map(m => m.toUpperCase())
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]
    for (const path of paths) {
      if (path instanceof RegExp) found.push({ methods: ['GET', 'POST'], path: '/api/kie/api/v1/chat/credit', proxy: true })
      else found.push({ methods: methods.length > 10 ? ['GET', 'POST'] : methods, path })
    }
  }
  return found
}

// ── What each route is meant to be ───────────────────────────────────────────

/** Open on purpose: they exist to be reached by someone who has no session. */
const PUBLIC = new Set([
  'GET /health',
  'POST /api/auth/signup', 'POST /api/auth/login', 'POST /api/auth/refresh', 'POST /api/auth/logout',
  'POST /api/auth/forgot-password', 'POST /api/auth/resend-confirmation',
  'GET /auth/confirm-email', 'POST /auth/confirm-email', 'GET /auth/reset-password', 'POST /auth/reset-password',
])

/** About the caller's own account: an app session OR an admin session may use these. */
const SHARED = new Set(['GET /api/auth/me', 'POST /api/auth/me', 'POST /api/auth/change-password'])

const isWebhook = path => path.startsWith('/webhooks/')
const isPanelFile = path => path === '/admin' || path.startsWith('/admin/')
const isAdminApi = path => path.startsWith('/api/admin/')

function kindOf(method, path) {
  if (PUBLIC.has(`${method} ${path}`)) return 'public'
  if (isWebhook(path)) return 'webhook'
  if (isPanelFile(path)) return 'panel'
  if (SHARED.has(`${method} ${path}`)) return 'shared'
  if (isAdminApi(path)) return 'admin'
  return 'user'
}

const entries = () => routes.flatMap(r => r.methods.map(method => ({ method, path: r.path, kind: kindOf(method, r.path) })))
  .filter(e => !['HEAD', 'OPTIONS'].includes(e.method))

const send = (e, token, body) => {
  const json = e.method !== 'GET' ? (body ?? {}) : undefined
  return stack.api(e.method, e.path, { token, body: json })
}
const label = e => `${e.method} ${e.path}`

test('the app registers the routes this matrix expects (a guard against the inventory silently shrinking)', () => {
  const all = entries()
  assert.ok(all.length >= 85, `only ${all.length} routes were found`)
  assert.ok(all.some(e => e.kind === 'admin') && all.some(e => e.kind === 'user') && all.some(e => e.kind === 'public'))
  assert.ok(all.some(e => e.kind === 'webhook') && all.some(e => e.kind === 'panel') && all.some(e => e.kind === 'shared'))
})

// ── Routes that need an app session ──────────────────────────────────────────

test('every app endpoint refuses a caller with no session, a made-up token, an admin session or an admin\'s stale app session', async () => {
  const wrong = []
  for (const e of entries().filter(x => x.kind === 'user')) {
    for (const [who, token] of [['nobody', undefined], ['a made-up token', 'definitely-not-a-session-token'], ['an admin panel session', boss.token], ['an admin\'s app session', staleBoss.token]]) {
      const res = await send(e, token)
      if (res.status !== 401 || res.body?.code !== 'NOT_AUTHENTICATED') wrong.push(`${label(e)} as ${who} -> ${res.status} ${res.body?.code ?? ''}`)
    }
  }
  assert.deepEqual(wrong, [])
})

test('a suspended account is refused by every app endpoint', async () => {
  const wrong = []
  for (const e of entries().filter(x => x.kind === 'user' || x.kind === 'shared')) {
    const res = await send(e, suspended.token)
    if (res.status !== 403 || res.body?.code !== 'ACCOUNT_SUSPENDED') wrong.push(`${label(e)} -> ${res.status} ${res.body?.code ?? ''}`)
  }
  assert.deepEqual(wrong, [])
})

test('an ordinary account\'s app session gets past the guard on every app endpoint, and none of them fails with a 5xx on an empty request', async () => {
  const wrong = []
  for (const e of entries().filter(x => x.kind === 'user' || x.kind === 'shared')) {
    const res = await send(e, ordinary.token)
    const refused = res.status === 401 || res.body?.code === 'NOT_AUTHENTICATED' || res.body?.code === 'NOT_ADMIN'
    if (refused) wrong.push(`${label(e)} refused the account's own session: ${res.status} ${res.body?.code ?? ''}`)
    if (res.status >= 500 && ![501, 502, 503].includes(res.status)) wrong.push(`${label(e)} -> ${res.status} ${JSON.stringify(res.body)?.slice(0, 120)}`)
  }
  assert.deepEqual(wrong, [])
})

// ── Routes about the caller's own account ────────────────────────────────────

test('the profile endpoints take an app session or an admin session, and refuse the rest', async () => {
  const wrong = []
  for (const e of entries().filter(x => x.kind === 'shared')) {
    for (const [who, token, okExpected] of [
      ['an ordinary app session', ordinary.token, true],
      ['an admin panel session', boss.token, true],
      ['nobody', undefined, false],
      ['an admin\'s stale app session', staleBoss.token, false],
    ]) {
      const res = await send(e, token)
      const refused = res.status === 401
      if (okExpected === refused) wrong.push(`${label(e)} as ${who} -> ${res.status} ${res.body?.code ?? ''}`)
    }
  }
  assert.deepEqual(wrong, [])
})

// ── Routes for administrators ────────────────────────────────────────────────

test('every admin endpoint: 401 with no session or a made-up one, 403 for an ordinary account, 401 for an admin\'s stale app session', async () => {
  const wrong = []
  for (const e of entries().filter(x => x.kind === 'admin')) {
    const cases = [
      ['nobody', undefined, 401, 'NOT_AUTHENTICATED'],
      ['a made-up token', 'definitely-not-a-session-token', 401, 'NOT_AUTHENTICATED'],
      ['an ordinary account', ordinary.token, 403, 'NOT_ADMIN'],
      ['an admin\'s stale app session', staleBoss.token, 401, 'NOT_AUTHENTICATED'],
      ['a suspended account', suspended.token, 403, 'ACCOUNT_SUSPENDED'],
    ]
    for (const [who, token, status, code] of cases) {
      const res = await send(e, token)
      if (res.status !== status || res.body?.code !== code) wrong.push(`${label(e)} as ${who} -> ${res.status} ${res.body?.code ?? ''} (wanted ${status} ${code})`)
    }
  }
  assert.deepEqual(wrong, [])
})

test('an administrator\'s panel session gets past the guard on every admin endpoint, and none of them fails with a 5xx on an empty request', async () => {
  const wrong = []
  for (const e of entries().filter(x => x.kind === 'admin')) {
    const res = await send(e, boss.token)
    if (res.status === 401 || res.status === 403) wrong.push(`${label(e)} refused an administrator: ${res.status} ${res.body?.code ?? ''}`)
    if (res.status >= 500) wrong.push(`${label(e)} -> ${res.status} ${JSON.stringify(res.body)?.slice(0, 120)}`)
  }
  assert.deepEqual(wrong, [])
})

test('an admin endpoint called with the wrong method does nothing: 404 for an administrator, and for nobody the same refusal as for anything else under /api', async () => {
  const wrong = []
  const flip = { GET: 'POST', POST: 'GET' }
  for (const e of entries().filter(x => x.kind === 'admin')) {
    for (const token of [undefined, boss.token]) {
      const res = await stack.api(flip[e.method], e.path, { token, body: flip[e.method] === 'POST' ? {} : undefined })
      // A write from nobody is refused before its body is read (requireSessionBeforeBody), so it is the
      // same 401 whether or not the route exists. A read from nobody finds no route for it: 404.
      const want = !token && flip[e.method] === 'POST' ? 401 : 404
      if (res.status !== want) wrong.push(`${flip[e.method]} ${e.path} (${token ? 'admin' : 'anonymous'}) -> ${res.status}, wanted ${want}`)
    }
  }
  assert.deepEqual(wrong, [])
})

test('HEAD on an admin or app endpoint is guarded exactly like GET', async () => {
  const wrong = []
  for (const e of entries().filter(x => x.method === 'GET' && (x.kind === 'admin' || x.kind === 'user'))) {
    const res = await fetch(`${stack.base}${e.path}`, { method: 'HEAD' })
    if (res.status !== 401) wrong.push(`HEAD ${e.path} -> ${res.status}`)
  }
  assert.deepEqual(wrong, [])
})

// ── Public routes, the panel's files and the webhooks ────────────────────────

test('the public routes answer a bare request without a server error and without leaking anything', async () => {
  const wrong = []
  for (const e of entries().filter(x => x.kind === 'public')) {
    const res = await send(e, undefined)
    if (res.status >= 500) wrong.push(`${label(e)} -> ${res.status}`)
    if (/at .*\.js:\d+|node_modules|stack/i.test(res.text || '')) wrong.push(`${label(e)} leaks a stack trace`)
  }
  assert.deepEqual(wrong, [])
})

test('the panel\'s files are public static files carrying the full set of security headers', async () => {
  for (const e of entries().filter(x => x.kind === 'panel')) {
    const res = await stack.api('GET', e.path)
    assert.equal(res.status, 200, e.path)
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/, e.path)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', e.path)
    assert.equal(res.headers.get('x-frame-options'), 'DENY', e.path)
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', e.path)
    assert.match(res.headers.get('strict-transport-security'), /^max-age=\d{7,}/, e.path)
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin', e.path)
    assert.match(res.headers.get('permissions-policy'), /camera=\(\)/, e.path)
    assert.ok(!res.headers.has('x-powered-by'), 'the framework is not announced')
  }
})

test('the webhooks refuse a request that proves nothing: no signature, a wrong one, the wrong method', async () => {
  const wrong = []
  for (const path of ['/webhooks/kie', '/webhooks/revenuecat']) {
    for (const [what, init] of [
      ['GET', { method: 'GET' }],
      ['PUT', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }],
      ['POST with nothing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
      ['POST with a wrong credential', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'nope', 'x-webhook-signature': 'nope', 'x-webhook-timestamp': String(Math.floor(Date.now() / 1000)) }, body: JSON.stringify({ data: { taskId: 't' }, event: { id: 'e', type: 'TEST' } }) }],
    ]) {
      const res = await fetch(`${stack.base}${path}`, init)
      if (![401, 405].includes(res.status)) wrong.push(`${path} ${what} -> ${res.status}`)
    }
  }
  assert.deepEqual(wrong, [])
})

test('an unknown path is a plain JSON 404, not a framework page', async () => {
  for (const path of ['/', '/api', '/api/', '/nope', '/.env', '/api/admin', '/admin/index.html']) {
    const res = await fetch(`${stack.base}${path}`)
    assert.equal(res.status, 404, path)
    assert.match(res.headers.get('content-type') || '', /application\/json/, path)
  }
})

/** A request line sent exactly as written: fetch() would tidy `..` away before it ever left. */
function rawGet(path) {
  const { port } = new URL(stack.base)
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: Number(port), path, method: 'GET' }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] || '' }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('the panel\'s file server cannot be walked out of: traversal, encoding tricks and look-alike paths are all 404', async () => {
  const tries = [
    '/admin/../.env', '/admin/lib/../app.css', '/admin/./app.css', '/admin//app.css', '/admin/app.css/', '/admin/APP.CSS',
    '/admin/%2e%2e/%2e%2e/etc/passwd', '/admin/%2e%2e%2f.env', '/admin/..%2f..%2f.env', '/admin/..%5c..%5c.env',
    '/admin/lib/..%2fapp.css', '/admin/app.css%00.png', '/admin/app.css%00', '/admin/views/', '/admin/views/users.js/..',
    '/admin/fonts/', '/admin/index.html', '/admin/package.json', '/admin/README.md', '/admin/test/helpers.js',
    '/admin/node_modules/happy-dom/package.json', '/admin/%252e%252e/app.css', '/admin;/app.css', '/admin?/app.css',
  ]
  // The only 200s allowed are one of the panel's own files, however the router spells the match
  // (a trailing slash, another letter case, a query string): an alias of the same file is not a leak.
  const served = new Set(ADMIN_UI_PATHS.map(p => p.toLowerCase().replace(/\/$/, '') || '/'))
  const isOneOfThePanelsFiles = path => served.has(path.split('?')[0].toLowerCase().replace(/\/$/, '') || '/')

  const leaked = []
  for (const path of tries) {
    const res = await rawGet(path)
    if (res.status === 200 && !isOneOfThePanelsFiles(path)) leaked.push(`${path} -> 200 (${res.type})`)
    assert.ok(!/root:|DATABASE_URL|POSTGRES_PASSWORD|sk-/.test(res.body), `${path} leaked something`)
  }
  assert.deepEqual(leaked, [])
})
