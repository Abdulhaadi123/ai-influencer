// The audit log page: read-only, filterable, and readable by someone who was not there.

import test, { beforeEach, mock } from 'node:test'
import assert from './assert.js'

import {
  installDom, reset, click, type, change, settle, microtasks, text, all, byText, fakeApi, viewContext, apiError, ID,
} from './helpers.js'

installDom()
const { renderAudit } = await import('../views/audit.js')
const { parseRoute } = await import('../lib/router.js')

beforeEach(() => { reset(); navigator.clipboard.written.length = 0 })

const recent = seconds => new Date(Date.now() - seconds * 1000).toISOString()

const entry = (n, over = {}) => ({
  id: n, at: recent(600 * n), admin: 'boss@test.example', action: 'user.suspend', targetType: 'user', targetId: ID(n),
  details: { email: `user${n}@test.example`, reason: 'spam', changed: true }, ...over,
})
const page = (entries, extra = {}) => ({ entries, total: entries.length, page: 1, pageSize: 50, ...extra })

function open({ hash = '#/audit', entries = [entry(1), entry(2)], routes = {} } = {}) {
  const api = fakeApi({ 'GET /api/admin/audit': () => page(entries), ...routes })
  const { ctx, navigations } = viewContext(api, parseRoute(hash))
  document.body.append(ctx.container)
  const controller = renderAudit(ctx)
  return { api, ctx, navigations, controller, root: ctx.container }
}

const lastQuery = api => api.of('GET', '/api/admin/audit').at(-1).input

test('each entry shows when, who, what, on what, and the details in words', async () => {
  const { root } = open()
  await settle()
  const rows = all(root, 'tbody tr')
  assert.equal(rows.length, 2)
  const first = text(rows[0])
  assert.match(first, /10 min ago/)
  assert.match(first, /boss@test\.example/)
  assert.match(first, /user\.suspend/, 'the exact code is kept beside the friendly name')
  assert.match(first, /user/)
  assert.match(first, /Account.*user1@test\.example/)
  assert.match(first, /Reason.*spam/)
  assert.ok(rows[0].querySelector('dl.detail-pairs'))
})

test('the target shows its kind and a shortened id with a copy button that copies all of it', async () => {
  const { root } = open()
  await settle()
  const cell = all(root, 'tbody tr')[0].querySelectorAll('td')[3]
  assert.match(text(cell), /user/)
  assert.ok(text(cell).includes('…') || text(cell).length < ID(1).length + 10, 'shortened')
  click(cell.querySelector('button'))
  await settle()
  assert.deepEqual(navigator.clipboard.written, [ID(1)])
})

test('an entry with no target or no details shows a dash, not a blank or "undefined"', async () => {
  const { root } = open({ entries: [entry(1, { targetId: null, targetType: null, details: null, action: 'price.delete' })] })
  await settle()
  const cells = all(root, 'tbody tr')[0].querySelectorAll('td')
  assert.equal(text(cells[3]), '—')
  assert.equal(text(cells[4]), '—')
  assert.doesNotMatch(text(root), /undefined|null/)
})

test('an action the page has never heard of still shows all its details', async () => {
  const { root } = open({ entries: [entry(1, { action: 'future.thing', details: { a: 1, nested: { b: 2 }, empty: '', nothing: null } })] })
  await settle()
  const t = text(root)
  assert.match(t, /future\.thing/)
  assert.match(t, /a.*1/)
  assert.match(t, /nested.*\{"b":2\}/)
  assert.doesNotMatch(t, /empty|nothing/, 'empty values are left out')
})

test('the first request asks for everything, 50 at a time; filters in the address are passed on; nonsense is dropped', async () => {
  const plain = open()
  await settle()
  assert.deepEqual(lastQuery(plain.api), { action: '', admin: '', page: 1, pageSize: 50 })

  reset()
  const filtered = open({ hash: '#/audit?action=moderation.&admin=boss&page=2&pageSize=100' })
  await settle()
  assert.deepEqual(lastQuery(filtered.api), { action: 'moderation.', admin: 'boss', page: 2, pageSize: 100 })

  reset()
  const bad = open({ hash: '#/audit?action=DROP+TABLE&page=-1&pageSize=3' })
  await settle()
  assert.deepEqual(lastQuery(bad.api), { action: '', admin: '', page: 1, pageSize: 50 })
})

test('the action filter offers the families of actions and navigates from page 1; "all" removes it', async () => {
  const { root, navigations } = open({ hash: '#/audit?page=3' })
  await settle()
  const select = root.querySelector('select[aria-label=Action]')
  assert.deepEqual(all(select, 'option').map(o => o.value), ['', 'user.', 'moderation.', 'price.', 'billing.'])
  change(select, 'price.')
  assert.equal(navigations.at(-1), '#/audit?action=price.')

  reset()
  const on = open({ hash: '#/audit?action=user.' })
  await settle()
  assert.equal(on.root.querySelector('select[aria-label=Action]').value, 'user.')
  change(on.root.querySelector('select[aria-label=Action]'), '')
  assert.equal(on.navigations.at(-1), '#/audit')
})

test('filtering by admin waits for a pause in typing, trims, and starts from page 1', async () => {
  const { root, navigations } = open({ hash: '#/audit?page=4' })
  await settle()
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const input = root.querySelector('input[type=search]')
    type(input, 'bo'); mock.timers.tick(200)
    type(input, ' boss@ ')
    mock.timers.tick(299)
    assert.deepEqual(navigations, [])
    mock.timers.tick(1)
    assert.deepEqual(navigations, ['#/audit?admin=boss%40'])
  } finally { mock.timers.reset() }
  await microtasks()
})

test('the admin box follows Back and Forward, but is left alone while you are typing in it', async () => {
  const { root, controller } = open({ hash: '#/audit?admin=one' })
  await settle()
  const input = root.querySelector('input[type=search]')
  assert.equal(input.value, 'one')
  controller.update(parseRoute('#/audit?admin=two'))
  await settle()
  assert.equal(input.value, 'two')
  controller.update(parseRoute('#/audit'))
  await settle()
  assert.equal(input.value, '')

  input.focus()
  type(input, 'typing')
  controller.update(parseRoute('#/audit?admin=other'))
  await settle()
  assert.equal(input.value, 'typing')
})

test('paging: the default size and page 1 stay out of the address', async () => {
  const many = Array.from({ length: 50 }, (_, i) => entry(i + 1))
  const { root, navigations } = open({ entries: many, routes: { 'GET /api/admin/audit': () => page(many, { total: 130 }) } })
  await settle()
  assert.match(text(root), /1–50 of 130/)
  click(root.querySelector('[aria-label="Next page"]'))
  assert.equal(navigations.at(-1), '#/audit?page=2')
  change(root.querySelector('select[aria-label="Rows per page"]'), '25')
  assert.equal(navigations.at(-1), '#/audit?pageSize=25')
  change(root.querySelector('select[aria-label="Rows per page"]'), '50')
  assert.equal(navigations.at(-1), '#/audit')
})

test('an empty log says nothing has happened; an empty filter result says to try others', async () => {
  const none = open({ entries: [] })
  await settle()
  assert.match(text(none.root), /Nothing recorded yet/)

  reset()
  const filtered = open({ hash: '#/audit?action=price.', entries: [] })
  await settle()
  assert.match(text(filtered.root), /No entries match/)
  assert.match(text(filtered.root), /Try different filters/)
})

test('a failed load shows the error and Try again loads again', async () => {
  let n = 0
  const { root, api } = open({ routes: { 'GET /api/admin/audit': () => { if (++n === 1) throw apiError('Offline.', 0, 'NETWORK'); return page([entry(1)]) } } })
  await settle()
  assert.match(text(root), /Offline\./)
  click(byText(root, 'button', 'Try again'))
  await settle()
  assert.equal(all(root, 'tbody tr').length, 1)
  assert.equal(api.of('GET', '/api/admin/audit').length, 2)
})

test('update: only a changed filter reloads; an older request is cancelled', async () => {
  const { api, controller } = open()
  await settle()
  controller.update(parseRoute('#/audit'))
  await settle()
  assert.equal(api.of('GET', '/api/admin/audit').length, 1)
  controller.update(parseRoute('#/audit?action=user.'))
  controller.update(parseRoute('#/audit?action=price.'))
  await settle()
  const calls = api.of('GET', '/api/admin/audit')
  assert.equal(calls.length, 3)
  assert.equal(calls[1].signal.aborted, true)
  assert.equal(calls[2].signal.aborted, false)
})

test('destroy cancels what is in flight', async () => {
  const { api, controller } = open()
  await settle()
  controller.destroy()
  assert.equal(api.of('GET', '/api/admin/audit')[0].signal.aborted, true)
})

test('the page is only ever a way to read: it makes no changes, and has no buttons that act', async () => {
  const { root, api } = open()
  await settle()
  for (const b of all(root, 'tbody button')) click(b)
  await settle()
  assert.equal(api.calls.filter(c => c.method === 'POST').length, 0)
  assert.equal(byText(root, 'button', 'Delete'), null)
  assert.equal(byText(root, 'button', 'Edit'), null)
})

test('hostile text in any field is text', async () => {
  const evil = '<img src=x onerror=1><script>1</script>'
  const { root } = open({ entries: [entry(1, { admin: evil, targetType: evil, targetId: evil, details: { email: evil, reason: evil } })] })
  await settle()
  assert.equal(root.querySelectorAll('tbody img, tbody script').length, 0)
})

test('a change of credits is described in words: who, how many (with a sign), whether given or taken back, and why', async () => {
  const { describeDetails } = await import('../views/audit.js')
  assert.deepEqual(describeDetails('billing.grant', { email: 'mia@test.example', credits: 50, kind: 'grant', note: 'support goodwill' }), [
    ['Account', 'mia@test.example'], ['Credits', '+50 (given)'], ['Reason', 'support goodwill'],
  ])
  assert.deepEqual(describeDetails('billing.grant', { email: 'mia@test.example', credits: -120, kind: 'adjust', note: 'refund fix' }), [
    ['Account', 'mia@test.example'], ['Credits', '−120 (taken back)'], ['Reason', 'refund fix'],
  ])
  assert.deepEqual(describeDetails('billing.grant', {}), [], 'nothing known, nothing invented')
})
