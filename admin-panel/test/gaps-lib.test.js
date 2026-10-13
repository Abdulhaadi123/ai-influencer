// The odd corners of the panel's building blocks — what a coverage report showed no
// other test reached: a session ending in the middle of a request, things with no
// title, a browser without showModal, a window that reports no size.

import test, { beforeEach } from 'node:test'
import assert from './assert.js'

import { installDom, reset, click, press, settle, text, all, byText, submit, dom } from './helpers.js'
import { createApi, ApiError, SESSION_ENDED } from '../lib/api.js'

installDom()
const C = await import('../lib/components.js')
const { h, svg } = await import('../lib/dom.js')
const { icon, ICONS } = await import('../lib/icons.js')
const { byModel, niceMax, initials } = await import('../lib/format.js')

beforeEach(reset)

// ── api.js: the session ends while a request is on its way ──────────────────

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const issued = { accessToken: 'a1', refreshToken: 'r1', expiresIn: 3600, user: { id: 'u', email: 'boss@test.example' } }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('an api made with no callback for "session ended" still ends the session quietly', async () => {
  const api = createApi({
    fetchImpl: async url => (url === '/api/auth/login' ? json(200, { session: issued }) : json(401, { error: 'Gone.', code: 'NOT_AUTHENTICATED' })),
  })
  await api.login('boss@test.example', 'x')
  await assert.rejects(api.get('/api/admin/stats'), e => e instanceof ApiError && e.status === 401)
  assert.equal(api.isSignedIn(), false, 'ended, and nothing threw because nobody was listening')
})

test('signing out while the session is being renewed ends the request with "session ended", not with a half-revived session', async () => {
  const refreshing = deferred()
  const calls = []
  const api = createApi({
    fetchImpl: async (url, init) => {
      calls.push(`${init.method} ${url}`)
      if (url === '/api/auth/login') return json(200, { session: issued })
      if (url === '/api/auth/refresh') { await refreshing.promise; return json(200, { session: { ...issued, accessToken: 'a2', refreshToken: 'r2' } }) }
      if (url === '/api/auth/logout') return json(204, undefined)
      return json(401, { error: 'Expired.', code: 'NOT_AUTHENTICATED' })   // the first attempt is refused…
    },
  })
  await api.login('boss@test.example', 'x')
  const request = api.get('/api/admin/stats')
  await settle(2)
  assert.ok(calls.includes('POST /api/auth/refresh'), '…so it asks for a renewal')

  await api.logout()                       // the person signs out while that is pending
  refreshing.resolve()
  await assert.rejects(request, e => e.status === 401 && e.code === 'NOT_AUTHENTICATED' && e.message === SESSION_ENDED)
  assert.equal(api.isSignedIn(), false, 'the late renewal did not bring the session back')
  assert.equal(calls.filter(c => c === 'GET /api/admin/stats').length, 1, 'and the request was not sent again')
})

// ── components ──────────────────────────────────────────────────────────────

test('a card with actions but no title still has a header for them', () => {
  const node = C.card({ actions: h('button', { type: 'button' }, 'Do it'), body: 'x' })
  const header = node.querySelector('.card-header')
  assert.ok(header)
  assert.equal(header.querySelector('.card-title'), null)
  assert.ok(byText(header, 'button', 'Do it'))
  assert.equal(C.card({ body: 'x' }).querySelector('.card-header'), null, 'and with neither, no header')
})

test('an empty state needs only a title', () => {
  const node = C.emptyState({ title: 'Nothing here' })
  assert.equal(text(node.querySelector('.empty-title')), 'Nothing here')
  assert.equal(node.querySelector('.empty-body'), null)
  assert.equal(node.querySelector('button'), null)
})

test('a select with no value chosen shows its first empty option; options without a value are not "selected" by accident', () => {
  const select = C.selectControl({ label: 'Pick', onChange() {}, options: [{ value: '', label: 'Any' }, { value: 'a', label: 'A' }] })
  assert.equal(select.value, '')
  assert.equal(all(select, 'option').find(o => o.selected).textContent, 'Any')
  const undefinedValue = C.selectControl({ label: 'Pick', value: null, onChange() {}, options: [{ label: 'Nothing' }, { value: 'a', label: 'A' }] })
  assert.equal(all(undefinedValue, 'option').length, 2)
})

test('a dialog cancelled twice resolves once and never errors', async () => {
  const outcome = C.openDialog({ title: 'Sure?' })
  await settle(1)
  const cancel = byText(document.querySelector('dialog'), 'button', 'Cancel')
  click(cancel)
  click(cancel)                                // the second finds it already finished
  assert.equal(await outcome, null)
  assert.equal(document.querySelector('dialog'), null)
})

test('where the browser has no showModal the dialog is still opened', async () => {
  const proto = dom().HTMLDialogElement.prototype
  const real = proto.showModal
  proto.showModal = undefined
  try {
    const outcome = C.openDialog({ title: 'Plain' })
    await settle(1)
    const d = document.querySelector('dialog')
    assert.ok(d.hasAttribute('open'), 'opened the old way')
    click(byText(d, 'button', 'Cancel'))
    assert.equal(await outcome, null)
  } finally { proto.showModal = real }
})

test('Shift+Tab with focus on the drawer itself goes to its last control', async () => {
  const drawer = C.openDrawer({ title: 'Panel', content: [h('button', { type: 'button', id: 'first' }, 'First'), h('button', { type: 'button', id: 'last' }, 'Last')] })
  drawer.el.focus()
  assert.equal(document.activeElement, drawer.el)
  const event = press(drawer.el, 'Tab', { shiftKey: true })
  assert.equal(event.defaultPrevented, true)
  assert.equal(document.activeElement.id, 'last')
  drawer.close()
})

test('choosing a menu item twice (a double click) acts once', async () => {
  let chosen = 0
  const menu = C.menuButton({ items: [{ label: 'Go', onSelect: () => { chosen++ } }] })
  document.body.append(menu)
  click(menu)
  const item = document.querySelector('[role=menuitem]')
  click(item)
  click(item)
  assert.equal(chosen, 2, 'the item\'s own handler runs per click…')
  assert.equal(document.querySelector('.menu'), null, '…but the menu is closed and stays closed')
  assert.equal(menu.getAttribute('aria-expanded'), 'false')
})

test('a window that reports no size still gets a menu on the page', () => {
  const w = dom()
  const realWidth = Object.getOwnPropertyDescriptor(w, 'innerWidth')
  const realHeight = Object.getOwnPropertyDescriptor(w, 'innerHeight')
  Object.defineProperty(w, 'innerWidth', { value: 0, configurable: true })
  Object.defineProperty(w, 'innerHeight', { value: 0, configurable: true })
  try {
    const menu = C.menuButton({ items: [{ label: 'One' }, { label: 'Two' }] })
    document.body.append(menu)
    click(menu)
    const open = document.querySelector('.menu')
    assert.ok(open)
    assert.match(open.style.top, /^\d+(\.\d+)?px$/)
    assert.match(open.style.right, /^\d+(\.\d+)?px$/)
  } finally {
    if (realWidth) Object.defineProperty(w, 'innerWidth', realWidth); else delete w.innerWidth
    if (realHeight) Object.defineProperty(w, 'innerHeight', realHeight); else delete w.innerHeight
  }
})

test('a bar chart is the same whether it has data or none', () => {
  const none = C.barChart({ data: [], label: 'Empty' })
  assert.equal(none.querySelectorAll('g.chart-col').length, 0)
  assert.equal(none.querySelector('svg').getAttribute('viewBox'), '0 0 10 100')
  const some = C.barChart({ data: [{ key: 'a', value: 5, title: 'A' }, { key: 'b', value: 0, title: 'B' }], label: 'Some' })
  assert.equal(some.querySelectorAll('rect.chart-bar').length, 1)
})

// ── dom.js, icons.js, format.js ─────────────────────────────────────────────

test('an svg element can be made with no attributes at all', () => {
  const node = svg('g')
  assert.equal(node.localName, 'g')
  assert.equal(node.attributes.length, 0)
  assert.equal(svg('g', null).attributes.length, 0)
  assert.equal(svg('g', { a: false, b: null, c: undefined, d: 0 }).attributes.length, 1, 'only a real value is written (0 is one)')
})

test('an icon that does not exist is drawn as the info icon rather than as nothing', () => {
  const unknown = icon('no-such-icon')
  const info = icon('info')
  assert.equal(unknown.innerHTML ?? unknown.outerHTML, info.innerHTML ?? info.outerHTML)
  assert.ok(!('no-such-icon' in ICONS))
  assert.equal(icon('info', { size: 30 }).getAttribute('width'), '30')
  assert.equal(unknown.getAttribute('aria-hidden'), 'true')
})

test('every icon the panel names exists', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const files = ['main.js', ...readdirSync(join(root, 'views')).map(f => `views/${f}`), ...readdirSync(join(root, 'lib')).map(f => `lib/${f}`)]
  const missing = []
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8')
    for (const [, name] of source.matchAll(/(?:iconName|icon):\s*'([a-z-]+)'/g)) if (!(name in ICONS)) missing.push(`${file}: ${name}`)
    for (const [, name] of source.matchAll(/\bicon\('([a-z-]+)'/g)) if (!(name in ICONS)) missing.push(`${file}: ${name}`)
    for (const [, name] of source.matchAll(/iconName = '([a-z-]+)'/g)) if (!(name in ICONS)) missing.push(`${file}: ${name}`)
  }
  assert.deepEqual(missing, [], 'an icon that is not drawn would silently show as "info"')
})

test('usage rows missing their numbers count as zero, never NaN', () => {
  const folded = byModel([
    { model: 'a', credits: 'x' }, { model: 'a', succeeded: null, failed: undefined }, { model: 'a', credits: 5, succeeded: 2, failed: 1 },
  ])
  assert.deepEqual(folded, [{ model: 'a', credits: 5, succeeded: 2, failed: 1 }])
})

test('niceMax rounds up to 1, 2, 2.5, 5 or 10 of its power of ten, at any size', () => {
  for (const [value, expected] of [[0.06, 0.1], [0.04, 0.05], [1, 1], [1.1, 2], [2.2, 2.5], [3, 5], [5, 5], [5.1, 10], [6, 10], [10, 10], [11, 20], [60, 100], [137.4, 200], [999, 1000], [1000, 1000], [1e9 + 1, 2e9], [0, 1], [-5, 1], [NaN, 1], [Infinity, 1]]) {
    assert.equal(niceMax(value), expected, String(value))
  }
})

test('initials: one word, many words, emoji and nothing', () => {
  assert.equal(initials('mia'), 'MI')
  assert.equal(initials('mia.brown@test.example'), 'MB')
  assert.equal(initials('😀smile'), '😀S')
  assert.equal(initials('---'), '--')
  assert.equal(initials(''), '?')
  assert.equal(initials(null), '?')
})
