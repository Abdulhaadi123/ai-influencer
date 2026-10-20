// The whole panel, from the sign-in screen: the real API client and the real views
// talking to a scripted server. This is the layer where the pieces have to agree —
// who is signed in, which page is showing, what happens when the session dies.

import test, { beforeEach, afterEach, mock } from 'node:test'
import assert from './assert.js'

import {
  installDom, reset, click, type, submit, press, settle, text, all, byText, dom, stats, creditsSummary, config, user, event, ID,
} from './helpers.js'

installDom()
const { start, VIEW_DEFS } = await import('../main.js')

const ME = { id: ID(900), email: 'admin@test.example' }
const PASSWORD = 'throwaway-test-password' // a made-up value for a fake server; it exists nowhere else

const recent = seconds => new Date(Date.now() - seconds * 1000).toISOString()

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code }
}

let log = []
let routes = {}
const realFetch = globalThis.fetch

function scriptServer(over = {}) {
  log = []
  const session = (n = 1) => ({ session: { accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresIn: 3600, user: ME } })
  routes = {
    'POST /api/auth/login': () => session(1),
    'POST /api/auth/logout': () => ({ ok: true }),
    'POST /api/auth/refresh': () => session(2),
    'GET /api/admin/stats': () => stats(),
    'GET /api/admin/usage': () => ({ days: 30, rows: [] }),
    'GET /api/admin/config': () => config(),
    'GET /api/admin/audit': () => ({ entries: [], total: 0, page: 1, pageSize: 50 }),
    'GET /api/admin/users': () => ({ users: [user(1), user(2)], total: 2, page: 1, pageSize: 25, sort: 'created', dir: 'desc' }),
    'GET /api/admin/jobs': () => ({ jobs: [], total: 0, page: 1, pageSize: 25 }),
    'GET /api/admin/prices': () => ({ prices: [], unpriced: [], units: ['per_video'] }),
    'GET /api/admin/billing/summary': () => creditsSummary(),
    'GET /api/admin/billing/activity': () => ({ entries: [], total: 0, page: 1, pageSize: 25 }),
    'GET /api/admin/billing/store-events': () => ({ events: [], total: 0, page: 1, pageSize: 25 }),
    'GET /api/admin/moderation': () => ({ events: [event(1)], total: 1, page: 1, pageSize: 25, counts: { open: 1, dismissed: 0, confirmed: 0 } }),
    ...over,
  }
  globalThis.fetch = async (url, init = {}) => {
    const [path, query = ''] = String(url).split('?')
    const method = init.method || 'GET'
    const entry = {
      method, path, query: Object.fromEntries(new URLSearchParams(query)), body: init.body ? JSON.parse(init.body) : undefined,
      auth: init.headers?.Authorization, signal: init.signal,
    }
    log.push(entry)
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    const handler = routes[`${method} ${path}`]
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => json })
    if (!handler) return reply(404, { error: 'Not found.', code: 'NOT_FOUND' })
    try { return reply(200, await handler(entry.body, entry.query)) } catch (e) {
      if (e instanceof HttpError) return reply(e.status, { error: e.message, code: e.code })
      throw e
    }
  }
}

const requests = (method, path) => log.filter(r => r.method === method && r.path === path)

let root = null
let app = null

/** Start the panel on a fresh page. */
function boot(over = {}) {
  scriptServer(over)
  root = document.createElement('div')
  root.id = 'app'
  document.body.append(root)
  app = start({ root, win: dom() })
  return app
}

async function signIn({ email = ME.email, password = PASSWORD } = {}) {
  type(root.querySelector('input[type=email]'), email)
  type(root.querySelector('input[id^=password]'), password)
  submit(root.querySelector('form'))
  await settle(10)
}

async function bootSignedIn(hash = '', over = {}) {
  dom().location.hash = hash
  boot(over)
  await signIn()
}

// Does this browser fire `hashchange` by itself? If so, the helper below must not add a second one.
const fires = await (async () => {
  let fired = false
  const w = dom()
  const probe = () => { fired = true }
  w.addEventListener('hashchange', probe)
  w.location.hash = '#/probe'
  await new Promise(r => setTimeout(r, 20))
  w.removeEventListener('hashchange', probe)
  w.location.hash = ''
  await new Promise(r => setTimeout(r, 20))
  return fired
})()

async function goTo(hash) {
  dom().location.hash = hash
  if (!fires) dom().dispatchEvent(new (dom().Event)('hashchange'))
  await settle(10)
}

beforeEach(() => { reset() })

afterEach(async () => {
  // Leave nothing running: the sign-out button stops the poll and the hash listener.
  document.querySelector('.sidebar-foot button')?.click()
  await settle(4)
  app = null
  root = null
  globalThis.fetch = realFetch
  mock.timers.reset()
  try { Object.defineProperty(document, 'hidden', { value: false, configurable: true }) } catch { /* fine */ }
})

const navLink = view => document.querySelector(`a.nav-link[data-view=${view}]`)
const current = () => document.querySelector('a.nav-link[aria-current=page]')?.dataset.view
const badgeNode = () => document.querySelector('.nav-badge')

// ── Signing in and out ───────────────────────────────────────────────────────

test('the panel starts on the sign-in screen and nothing else', () => {
  boot()
  assert.equal(document.title, 'Sign in · Influenza Admin')
  assert.ok(root.querySelector('form'))
  assert.equal(document.querySelector('.sidebar'), null)
  assert.equal(log.length, 0, 'no request before anyone signs in')
})

test('signing in sends the credentials once, checks the admin area with the token it was given, then shows the panel', async () => {
  boot()
  await signIn()
  const login = requests('POST', '/api/auth/login')
  assert.equal(login.length, 1)
  assert.deepEqual(login[0].body, { email: ME.email, password: PASSWORD, scope: 'admin' })
  assert.equal(login[0].auth, undefined, 'no token on the login itself')
  assert.ok(requests('GET', '/api/admin/stats').every(r => r.auth === 'Bearer access-1'))
  assert.ok(document.querySelector('.sidebar'))
  assert.equal(root.querySelector('input[type=password]'), null, 'the sign-in form is gone')
})

test('the session lives in memory only: nothing is written to storage or cookies', async () => {
  await bootSignedIn()
  const w = dom()
  assert.equal(w.sessionStorage.length, 0)
  assert.deepEqual(Object.keys(w.localStorage), [], 'the panel keeps nothing at all')
  assert.equal(w.document.cookie, '')
  for (const key of Object.keys(w.localStorage)) {
    assert.doesNotMatch(w.localStorage.getItem(key), /access-1|refresh-1|throwaway/)
  }
})

test('a person who is not an administrator is turned away and signed out again', async () => {
  boot({ 'GET /api/admin/stats': () => { throw new HttpError(403, 'This area is for administrators.', 'NOT_ADMIN') } })
  await signIn()
  assert.equal(document.querySelector('.sidebar'), null)
  assert.match(text(root.querySelector('[role=alert]')), /not an administrator/)
  assert.equal(requests('POST', '/api/auth/logout').length, 1)
  assert.deepEqual(requests('POST', '/api/auth/logout')[0].body, { refreshToken: 'refresh-1' })
})

test('wrong credentials stay on the sign-in screen with the server\'s message', async () => {
  boot({ 'POST /api/auth/login': () => { throw new HttpError(401, 'Incorrect email or password.', 'INVALID_CREDENTIALS') } })
  await signIn()
  assert.match(text(root.querySelector('[role=alert]')), /Incorrect email or password/)
  assert.equal(document.querySelector('.sidebar'), null)
  assert.equal(requests('GET', '/api/admin/stats').length, 0)
})

test('signing out tells the server, forgets the session and shows the sign-in screen again', async () => {
  await bootSignedIn()
  click(byText(document, '.sidebar-foot button', 'Sign out'))
  await settle(6)
  assert.equal(requests('POST', '/api/auth/logout').length, 1)
  assert.equal(document.querySelector('.sidebar'), null)
  assert.ok(root.querySelector('input[type=password]'))
  assert.equal(document.title, 'Sign in · Influenza Admin')
  assert.equal(app.api.isSignedIn(), false)
  assert.equal(app.api.user, null)
})

test('after signing out, moving the address does nothing — no request is made for a page nobody can see', async () => {
  await bootSignedIn()
  click(byText(document, '.sidebar-foot button', 'Sign out'))
  await settle(6)
  const before = log.length
  await goTo('#/users')
  assert.equal(log.length, before)
})

test('the panel listens to the address only while someone is signed in — no listener is left behind by signing out', async () => {
  const w = dom()
  const active = new Set()
  const add = w.addEventListener
  const remove = w.removeEventListener
  w.addEventListener = function (type, fn, ...rest) { if (type === 'hashchange') active.add(fn); return add.call(this, type, fn, ...rest) }
  w.removeEventListener = function (type, fn, ...rest) { if (type === 'hashchange') active.delete(fn); return remove.call(this, type, fn, ...rest) }
  try {
    boot()
    assert.equal(active.size, 0, 'not while signing in')
    await signIn()
    assert.equal(active.size, 1)
    click(byText(document, '.sidebar-foot button', 'Sign out'))
    await settle(6)
    assert.equal(active.size, 0)
    await signIn()
    assert.equal(active.size, 1, 'signing in again adds exactly one')
  } finally { w.addEventListener = add; w.removeEventListener = remove }
})

test('signing in again as someone else starts clean', async () => {
  await bootSignedIn('#/users')
  click(byText(document, '.sidebar-foot button', 'Sign out'))
  await settle(6)
  await signIn()
  assert.ok(document.querySelector('.sidebar'))
  assert.equal(requests('POST', '/api/auth/login').length, 2)
  assert.equal(document.querySelectorAll('.sidebar').length, 1, 'one shell, not two')
})

// ── The shell ────────────────────────────────────────────────────────────────

test('the sidebar lists every page in order, links to each, and names who is signed in', async () => {
  await bootSignedIn()
  const links = all(document, 'a.nav-link')
  assert.deepEqual(links.map(l => text(l).replace(/\d+\+?$/, '')), ['Overview', 'Accounts', 'Generations', 'Moderation', 'Credits', 'Pricing', 'Audit log', 'Settings'])
  assert.deepEqual(links.map(l => l.getAttribute('href')), ['#/overview', '#/users', '#/jobs', '#/moderation', '#/credits', '#/prices', '#/audit', '#/settings'])
  assert.deepEqual(VIEW_DEFS.map(v => v.id), links.map(l => l.dataset.view))
  assert.equal(text(document.querySelector('.me-email')), ME.email)
  assert.match(text(document.querySelector('.me')), /Administrator/)
  assert.equal(document.querySelector('nav').getAttribute('aria-label'), 'Main')
  assert.equal(document.querySelectorAll('main').length, 1)
})

test('with no address it opens the overview; an unknown address does too', async () => {
  await bootSignedIn('')
  assert.equal(current(), 'overview')
  assert.equal(document.title, 'Overview · Influenza Admin')
  assert.equal(text(document.querySelector('.crumb')), 'Overview')
  assert.ok(requests('GET', '/api/admin/usage').length >= 1)

  click(byText(document, '.sidebar-foot button', 'Sign out')); await settle(6)
  reset()
  await bootSignedIn('#/nonsense/here')
  assert.equal(current(), 'overview')
})

test('an address names the page it opens on, including a record and filters', async () => {
  await bootSignedIn(`#/users/${ID(1)}?q=user`)
  assert.equal(current(), 'users')
  assert.equal(document.title, 'Accounts · Influenza Admin')
  assert.equal(requests('GET', '/api/admin/users')[0].query.q, 'user')
})

test('the sidebar badge shows how many moderation items are waiting, and hides at zero', async () => {
  await bootSignedIn('', { 'GET /api/admin/stats': () => stats({ moderation: { open: 3, openBlocked: 1, events24h: 3 } }) })
  assert.equal(text(badgeNode()), '3')
  assert.equal(badgeNode().hidden, false)
  assert.equal(badgeNode().getAttribute('aria-label'), '3 items to review')

  click(byText(document, '.sidebar-foot button', 'Sign out')); await settle(6)
  reset()
  await bootSignedIn('', { 'GET /api/admin/stats': () => stats({ moderation: { open: 0, openBlocked: 0, events24h: 0 } }) })
  assert.equal(badgeNode().hidden, true)

  click(byText(document, '.sidebar-foot button', 'Sign out')); await settle(6)
  reset()
  await bootSignedIn('', { 'GET /api/admin/stats': () => stats({ moderation: { open: 250, openBlocked: 0, events24h: 0 } }) })
  assert.equal(text(badgeNode()), '99+')
})

test('the badge is refreshed every minute while the tab is showing, and not while it is hidden', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  let open = 1
  await bootSignedIn('#/settings', { 'GET /api/admin/stats': () => stats({ moderation: { open, openBlocked: 0, events24h: 0 } }) })
  assert.equal(text(badgeNode()), '1')
  const before = requests('GET', '/api/admin/stats').length

  open = 4
  mock.timers.tick(60_000)
  await settle(6)
  assert.equal(requests('GET', '/api/admin/stats').length, before + 1)
  assert.equal(text(badgeNode()), '4')

  Object.defineProperty(document, 'hidden', { value: true, configurable: true })
  open = 9
  mock.timers.tick(60_000)
  await settle(6)
  assert.equal(requests('GET', '/api/admin/stats').length, before + 1, 'hidden: no request')
  assert.equal(text(badgeNode()), '4')
})

test('signing out stops the minute-by-minute refresh', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  await bootSignedIn('#/settings')
  click(byText(document, '.sidebar-foot button', 'Sign out')); await settle(6)
  const before = log.length
  mock.timers.tick(5 * 60_000)
  await settle(6)
  assert.equal(log.length, before)
})

test('a failed badge refresh is silent and leaves the old number', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  let fail = false
  await bootSignedIn('#/settings', { 'GET /api/admin/stats': () => { if (fail) throw new HttpError(503, 'Down.', 'X'); return stats({ moderation: { open: 5, openBlocked: 0, events24h: 0 } }) } })
  fail = true
  mock.timers.tick(60_000)
  await settle(6)
  assert.equal(text(badgeNode()), '5')
  assert.equal(document.querySelector('.toast-error'), null)
})

// ── Moving between pages ─────────────────────────────────────────────────────

test('changing the address changes the page: new view, new title, the right link marked, focus moved to the content', async () => {
  await bootSignedIn('#/settings')
  assert.equal(current(), 'settings')
  await goTo('#/prices')
  assert.equal(current(), 'prices')
  assert.equal(document.title, 'Pricing · Influenza Admin')
  assert.equal(text(document.querySelector('.crumb')), 'Pricing')
  assert.equal(document.querySelectorAll('.view').length, 1, 'the old page is gone')
  assert.match(text(document.querySelector('#content')), /Add a price/)
  assert.equal(document.activeElement, document.querySelector('#content'))
  assert.equal(all(document, 'a[aria-current=page]').length, 1)
})

test('every page can be reached and draws something', async () => {
  await bootSignedIn('')
  for (const [hash, expected] of [
    ['#/users', /Accounts/], ['#/jobs', /Generations/], ['#/moderation', /Moderation/], ['#/credits', /Credits/], ['#/prices', /Pricing/],
    ['#/audit', /Audit log/], ['#/settings', /Settings/], ['#/overview', /Overview/],
  ]) {
    await goTo(hash)
    assert.match(text(document.querySelector('#content h1')), expected, hash)
  }
})

test('only the details of an address changing (a filter) updates the same page in place — the page is not rebuilt', async () => {
  await bootSignedIn('#/users')
  const view = document.querySelector('.view')
  const searchBox = view.querySelector('input[type=search]')
  await goTo('#/users?q=mia')
  assert.equal(document.querySelector('.view'), view, 'same page element')
  assert.equal(view.querySelector('input[type=search]'), searchBox, 'the search box keeps its place')
  assert.equal(requests('GET', '/api/admin/users').at(-1).query.q, 'mia')
})

test('leaving a page cancels what it still had on its way', async () => {
  let release
  await bootSignedIn('#/settings', { 'GET /api/admin/jobs': () => new Promise(r => { release = () => r({ jobs: [], total: 0, page: 1, pageSize: 25 }) }) })
  await goTo('#/jobs')
  const pending = requests('GET', '/api/admin/jobs')[0]
  await goTo('#/settings')
  assert.equal(pending.signal.aborted, true)
  release?.()
  await settle(4)
  assert.doesNotMatch(text(document.querySelector('#content')), /No generations yet/)
})

test('menus, dialogs and panels open on one page do not follow you to the next', async () => {
  await bootSignedIn('#/users')
  click(document.querySelector('tbody [aria-haspopup=menu]'))
  assert.ok(document.querySelector('.menu'))
  document.body.classList.add('no-scroll')
  await goTo('#/jobs')
  assert.equal(document.querySelector('.menu'), null)
  assert.equal(document.body.classList.contains('no-scroll'), false)
})

test('a page that fails to start shows an error with Try again, and Try again starts it again', async () => {
  await bootSignedIn('#/settings')
  const def = VIEW_DEFS.find(v => v.id === 'prices')
  const original = def.render
  let attempts = 0
  def.render = ctx => { if (++attempts === 1) throw new Error('This page broke.'); return original(ctx) }
  try {
    await goTo('#/prices')
    assert.match(text(document.querySelector('#content')), /This page broke\./)
    click(byText(document.querySelector('#content'), 'button', 'Try again'))
    await settle(8)
    assert.match(text(document.querySelector('#content')), /Add a price/)
    assert.equal(attempts, 2)
  } finally { def.render = original }
})

test('a page whose start-up is asynchronous and fails is handled the same way', async () => {
  await bootSignedIn('#/settings')
  const def = VIEW_DEFS.find(v => v.id === 'audit')
  const original = def.render
  def.render = async () => { throw new Error('Async break.') }
  try {
    await goTo('#/audit')
    assert.match(text(document.querySelector('#content')), /Async break\./)
  } finally { def.render = original }
})

test('Refresh on the overview draws it again even though the address is the same', async () => {
  await bootSignedIn('#/overview')
  const before = requests('GET', '/api/admin/usage').length
  click(byText(document, 'button', 'Refresh'))
  await settle(10)
  assert.equal(requests('GET', '/api/admin/usage').length, before + 1)
})

test('choosing another period on the overview reloads the figures for it', async () => {
  await bootSignedIn('#/overview')
  click(byText(document, '[role=radio]', '90 days'))
  await settle(10)
  assert.equal(requests('GET', '/api/admin/usage').at(-1).query.days, '90')
})

test('a decision on the moderation page refreshes the number in the sidebar', async () => {
  let open = 2
  await bootSignedIn(`#/moderation/${ID(101)}`, {
    'GET /api/admin/stats': () => stats({ moderation: { open, openBlocked: 0, events24h: 0 } }),
    'GET /api/admin/config': () => config(),
    'POST /api/admin/moderation/resolve': () => { open = 1; return { ok: true } },
  })
  assert.equal(text(badgeNode()), '2')
  submit(document.querySelector('form.decision'))
  await settle(12)
  assert.equal(text(badgeNode()), '1')
})

// ── When the session ends ───────────────────────────────────────────────────

test('if the server stops accepting the session, you land on the sign-in screen with the reason, and the page is torn down', async () => {
  await bootSignedIn('#/settings')
  routes['GET /api/admin/users'] = () => { throw new HttpError(401, 'Sign in again.', 'NOT_AUTHENTICATED') }
  routes['POST /api/auth/refresh'] = () => { throw new HttpError(401, 'Refresh token rejected.', 'INVALID_REFRESH') }
  await goTo('#/users')
  assert.equal(document.querySelector('.sidebar'), null)
  assert.ok(root.querySelector('input[type=password]'))
  assert.match(text(root.querySelector('[role=alert]')), /Your session ended\. Please sign in again\./)
  assert.equal(document.title, 'Sign in · Influenza Admin')
})

test('a quiet renewal keeps a long session going without the person noticing', async () => {
  await bootSignedIn('#/settings')
  let first = true
  routes['GET /api/admin/users'] = () => {
    if (first) { first = false; throw new HttpError(401, 'Expired.', 'NOT_AUTHENTICATED') }
    return { users: [user(1)], total: 1, page: 1, pageSize: 25, sort: 'created', dir: 'desc' }
  }
  await goTo('#/users')
  assert.equal(requests('POST', '/api/auth/refresh').length, 1)
  assert.ok(document.querySelector('.sidebar'), 'still signed in')
  assert.equal(all(document, 'tbody tr').length, 1)
  assert.equal(requests('GET', '/api/admin/users').at(-1).auth, 'Bearer access-2', 'retried with the new token')
})

test('an administrator who is suspended while working is signed out with the server\'s message', async () => {
  await bootSignedIn('#/settings')
  routes['GET /api/admin/users'] = () => { throw new HttpError(403, 'Your account has been suspended.', 'ACCOUNT_SUSPENDED') }
  await goTo('#/users')
  assert.equal(document.querySelector('.sidebar'), null)
  assert.match(text(root.querySelector('[role=alert]')), /Your account has been suspended/)
})

test('losing the network does not sign anyone out: the page shows the problem and can be retried', async () => {
  await bootSignedIn('#/settings')
  let down = true
  routes['GET /api/admin/jobs'] = () => { if (down) throw new TypeError('Failed to fetch'); return { jobs: [], total: 0, page: 1, pageSize: 25 } }
  await goTo('#/jobs')
  assert.ok(document.querySelector('.sidebar'), 'still signed in')
  assert.match(text(document.querySelector('#content')), /Could not reach the server/)
  down = false
  click(byText(document.querySelector('#content'), 'button', 'Try again'))
  await settle(8)
  assert.match(text(document.querySelector('#content')), /No generations yet/)
})

// ── Small screens ────────────────────────────────────────────────

test('the menu button opens the sidebar; choosing a page, the scrim or Escape closes it', async () => {
  await bootSignedIn('')
  const frame = document.querySelector('.app-shell')
  const toggle = document.querySelector('.nav-toggle')
  assert.equal(toggle.getAttribute('aria-controls'), 'sidebar')
  click(toggle)
  assert.ok(frame.classList.contains('nav-open'))
  click(toggle)
  assert.ok(!frame.classList.contains('nav-open'), 'it toggles')

  click(toggle)
  click(document.querySelector('.sidebar-scrim'))
  assert.ok(!frame.classList.contains('nav-open'))

  click(toggle)
  press(frame, 'Escape')
  assert.ok(!frame.classList.contains('nav-open'))

  click(toggle)
  await goTo('#/jobs')
  assert.ok(!frame.classList.contains('nav-open'), 'going somewhere closes it')
})

// ── One theme, and the app's name ───────────────────────────────────────────

test('the panel is light, always: no switch for it, and a dark choice left in storage by an earlier version changes nothing', async () => {
  dom().localStorage.setItem('admin-theme', 'dark')
  await bootSignedIn('')
  const html = document.documentElement
  assert.equal(html.hasAttribute('data-theme'), false)
  assert.equal(document.querySelector('[aria-label*="dark" i], [title*="dark" i]'), null, 'nothing offers dark')
  assert.equal(document.querySelector('.topbar button:not(.nav-toggle)'), null, 'the top bar carries no controls but the menu button')
})

test('the sidebar and the sign-in screen carry the app\'s name, and so does the tab', async () => {
  boot()
  assert.equal(text(root.querySelector('.login-brand .brand-name')), 'Influenza')
  assert.equal(text(root.querySelector('.login-brand .brand-tag')), 'Admin')
  assert.equal(document.title, 'Sign in · Influenza Admin')

  await signIn()
  assert.equal(text(document.querySelector('.sidebar .brand-name')), 'Influenza')
  assert.equal(text(document.querySelector('.sidebar .brand-tag')), 'Admin')
  assert.ok(document.querySelector('.sidebar .brand-mark svg'), 'with its mark')
  assert.match(document.title, /^Overview · Influenza Admin$/)
  assert.ok(!/Studio/.test(document.body.textContent), 'the old name is gone')
})

// ── The corners of navigation and of starting a page ────────────────────────

const { h: el, mount: put } = await import('../lib/dom.js')

test('asking to go where you already are changes nothing; asking for a redraw redraws', async () => {
  await bootSignedIn('#/settings')
  const view = document.querySelector('.view')
  app.navigate('#/settings')
  await settle(4)
  assert.ok(document.querySelector('.view') === view, 'the same page element: nothing was rebuilt')
  app.navigate('#/settings', { force: true })
  await settle(4)
  assert.ok(document.querySelector('.view') !== view, 'a forced one draws it afresh')
})

test('after signing out nothing is drawn for a page you can no longer see, even if asked to', async () => {
  await bootSignedIn('#/settings')
  click(byText(document, '.sidebar-foot button', 'Sign out'))
  await settle(6)
  const before = log.length
  app.navigate('#/settings', { force: true })
  await app.refreshShell()
  await settle(4)
  assert.equal(document.querySelector('.sidebar'), null)
  assert.ok(root.querySelector('input[type=password]'), 'still the sign-in screen')
  assert.equal(log.length, before, 'and not one request was made')
  assert.equal(await app.refreshShell(), null)
})

test('a sidebar count that arrives after you signed out is dropped quietly', async () => {
  let release
  await bootSignedIn('#/settings')
  routes['GET /api/admin/stats'] = () => new Promise(r => { release = () => r(stats({ moderation: { open: 7, openBlocked: 0, events24h: 0 } })) })
  const pending = app.refreshShell()
  await settle(2)
  click(byText(document, '.sidebar-foot button', 'Sign out'))
  await settle(6)
  release()
  assert.ok(await pending !== undefined, 'it settles without throwing')
  assert.equal(document.querySelector('.nav-badge'), null)
})

/** Swap a page's start-up for the length of one test. */
async function withRender(id, render, fn) {
  const def = VIEW_DEFS.find(v => v.id === id)
  const original = def.render
  def.render = render
  try { await fn() } finally { def.render = original }
}

test('a page that starts asynchronously and hands back a controller is updated for a changed filter and told to stop when left', async () => {
  const updates = []
  let destroyed = 0
  await bootSignedIn('#/settings')
  await withRender('audit', async ctx => {
    put(ctx.container, el('p', {}, 'async audit'))
    return { update: route => updates.push(route.query.admin ?? null), destroy: () => { destroyed++ } }
  }, async () => {
    await goTo('#/audit')
    await goTo('#/audit?admin=boss')
    assert.deepEqual(updates, ['boss'], 'the filter change was handed to it rather than the page being rebuilt')
    assert.match(text(document.querySelector('.view')), /async audit/)
    await goTo('#/jobs')
    assert.equal(destroyed, 1)
  })
})

test('a page that finishes starting after you have left it is told to stop at once — it never lingers', async () => {
  let finish
  let destroyed = 0
  await bootSignedIn('#/settings')
  await withRender('audit', ctx => new Promise(resolve => { finish = () => resolve({ destroy: () => { destroyed++ } }) }), async () => {
    await goTo('#/audit')
    await goTo('#/jobs')
    finish()
    await settle(4)
    assert.equal(destroyed, 1, 'its controller was destroyed on arrival')
  })
})

test('a page whose asynchronous start fails can be retried from its error', async () => {
  let attempts = 0
  await bootSignedIn('#/settings')
  await withRender('audit', async ctx => {
    if (++attempts === 1) throw new Error('Not this time.')
    put(ctx.container, el('p', {}, 'recovered'))
  }, async () => {
    await goTo('#/audit')
    assert.match(text(document.querySelector('#content')), /Not this time\./)
    click(byText(document.querySelector('#content'), 'button', 'Try again'))
    await settle(8)
    assert.match(text(document.querySelector('#content')), /recovered/)
    assert.equal(attempts, 2)
  })
})

test('a page that returns nothing is simply redrawn when the address changes — there is nothing to update', async () => {
  let draws = 0
  await bootSignedIn('#/settings')
  await withRender('audit', ctx => { draws++; put(ctx.container, el('p', {}, `draw ${draws}`)) }, async () => {
    await goTo('#/audit')
    await goTo('#/audit?admin=x')
    assert.equal(draws, 2)
    assert.match(text(document.querySelector('.view')), /draw 2/)
  })
})

test('opened by itself on a page that has an #app element, it starts at the sign-in screen', async () => {
  const hadFlag = globalThis.__ADMIN_TEST__
  const holder = document.createElement('div')
  holder.id = 'app'
  document.body.append(holder)
  globalThis.__ADMIN_TEST__ = false
  scriptServer()
  try {
    await import(new URL('../main.js?autostart', import.meta.url).href)
    assert.ok(holder.querySelector('form'), 'the sign-in form was drawn')
    assert.equal(document.title, 'Sign in · Influenza Admin')
    assert.equal(log.length, 0, 'and nothing was asked of the server')
  } finally { globalThis.__ADMIN_TEST__ = hadFlag }
})

test('the Credits page has its own count: store purchases that did not become credits, hidden at zero', async () => {
  await bootSignedIn('', { 'GET /api/admin/stats': () => stats({ billingProblems30d: 2, moderation: { open: 3, openBlocked: 1, events24h: 3 } }) })
  assert.equal(all(document, '.nav-badge').length, 2, 'one beside Moderation, one beside Credits')
  const credits = navLink('credits').querySelector('.nav-badge')
  assert.equal(text(credits), '2')
  assert.equal(credits.hidden, false)
  assert.equal(credits.getAttribute('aria-label'), '2 store purchases to look into')
  assert.equal(text(navLink('moderation').querySelector('.nav-badge')), '3', 'the other count is untouched')

  click(byText(document, '.sidebar-foot button', 'Sign out')); await settle(6)
  reset()
  await bootSignedIn('', { 'GET /api/admin/stats': () => stats({ billingProblems30d: 0 }) })
  assert.equal(navLink('credits').querySelector('.nav-badge').hidden, true)
})

test('the sidebar groups the pages by what they are for: manage, money, system', async () => {
  await bootSignedIn('')
  assert.deepEqual(all(document, '.nav-label').map(l => text(l)), ['Manage', 'Money', 'System'])
})
