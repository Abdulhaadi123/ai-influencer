// The corners of the pages: an action declined, an action that fails, a record with
// fields missing, an answer for something you have already moved away from.

import test, { beforeEach } from 'node:test'
import assert from './assert.js'

import {
  installDom, reset, click, submit, settle, text, all, byText, fakeApi, viewContext, apiError, user, event, config, ID,
} from './helpers.js'

installDom()
const { renderUsers } = await import('../views/users.js')
const { renderModeration } = await import('../views/moderation.js')
const { renderPrices } = await import('../views/prices.js')
const { renderAudit, describeDetails } = await import('../views/audit.js')
const { parseRoute } = await import('../lib/router.js')

beforeEach(reset)

const recent = seconds => new Date(Date.now() - seconds * 1000).toISOString()
const ME = { id: ID(900), email: 'boss@test.example' }
const dialog = () => document.querySelector('dialog')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

// ── Accounts ─────────────────────────────────────────────────────────────────

const detailOf = (u, over = {}) => ({
  user: u,
  strikes: { count: 0, limit: 5, windowDays: 30 },
  devices: { active: 1, lastUsedAt: recent(60) },
  influencers: 0,
  credits: { balance: 0, enforced: false, recent: [] },
  assets: { byStatus: { unchecked: 0, clear: 0, blocked: 0 }, total: 0 },
  recentJobs: [], recentEvents: [],
  ...over,
})

function openUsers({ hash = '#/users', users = [user(1), user(2)], routes = {} } = {}) {
  const api = fakeApi({
    'GET /api/admin/users': () => ({ users, total: users.length, page: 1, pageSize: 25, sort: 'created', dir: 'desc' }),
    'GET /api/admin/users/detail': ({ userId }) => detailOf(users.find(u => u.id === userId) ?? users[0]),
    'POST /api/admin/users/suspend': { ok: true, changed: true },
    'POST /api/admin/users/unsuspend': { ok: true, changed: true },
    'POST /api/admin/users/set-role': { ok: true, changed: true },
    'POST /api/admin/users/delete': { ok: true },
    ...routes,
  }, { user: ME })
  const { ctx, navigations } = viewContext(api, parseRoute(hash))
  document.body.append(ctx.container)
  const controller = renderUsers(ctx)
  return { api, navigations, controller, root: ctx.container }
}
const rowMenuOf = (root, email) => click(all(root, 'tbody tr').find(r => r.textContent.includes(email)).querySelector('[aria-haspopup=menu]'))
const menuItem = label => byText(document, '.menu [role=menuitem]', label)
const drawerButton = label => byText(document.querySelector('.drawer'), 'button', label)

test('"View details" in a row\'s menu opens that account, keeping the filters', async () => {
  const { root, navigations } = openUsers({ hash: '#/users?q=user' })
  await settle()
  rowMenuOf(root, 'user2@test.example')
  click(menuItem('View details'))
  assert.deepEqual(navigations, [`#/users/${ID(2)}?q=user`])
})

test('saying no to "Restore account" sends nothing', async () => {
  const { root, api } = openUsers({ users: [user(1, { status: 'suspended' })] })
  await settle()
  rowMenuOf(root, 'user1@test.example')
  click(menuItem('Restore account'))
  await settle()
  click(dialog().querySelector('button[type=button]'))
  await settle()
  assert.equal(api.of('POST', '/api/admin/users/unsuspend').length, 0)
  assert.equal(document.querySelector('.toast'), null)
})

test('a role change the server refuses is reported, and nothing is refreshed as if it had worked', async () => {
  const { root, api } = openUsers({ routes: { 'POST /api/admin/users/set-role': () => { throw apiError('Not now.', 403, 'FORBIDDEN') } } })
  await settle()
  rowMenuOf(root, 'user1@test.example')
  click(menuItem('Make administrator…'))
  await settle()
  submit(dialog().querySelector('form'))
  await settle()
  const toast = document.querySelector('.toast-error')
  assert.match(text(toast), /Could not change the role/)
  assert.match(text(toast), /Not now\./)
  assert.equal(api.of('GET', '/api/admin/users').length, 1)
})

test('the panel\'s own buttons do what the row menu does: restore, promote and demote, each asking first', async () => {
  const people = [user(1, { status: 'suspended' }), user(2), user(3, { role: 'admin' })]
  const { api } = openUsers({ hash: `#/users/${ID(1)}`, users: people })
  await settle()
  click(drawerButton('Restore account'))
  await settle()
  assert.match(text(dialog()), /Restore user1@test\.example\?/)
  submit(dialog().querySelector('form')); await settle()
  assert.deepEqual(api.of('POST', '/api/admin/users/unsuspend')[0].input, { userId: ID(1) })
  assert.match(text(document.querySelector('.toast-success')), /can sign in again/)
})

test('from the panel: make an account an administrator, and take it away from another', async () => {
  const people = [user(2), user(3, { role: 'admin' })]
  const first = openUsers({ hash: `#/users/${ID(2)}`, users: people })
  await settle()
  click(drawerButton('Make administrator…'))
  await settle()
  submit(dialog().querySelector('form')); await settle()
  assert.deepEqual(first.api.of('POST', '/api/admin/users/set-role')[0].input, { userId: ID(2), role: 'admin' })

  reset()
  const second = openUsers({ hash: `#/users/${ID(3)}`, users: people })
  await settle()
  click(drawerButton('Remove admin role…'))
  await settle()
  assert.match(text(dialog()), /lose access to this panel/)
  submit(dialog().querySelector('form')); await settle()
  assert.deepEqual(second.api.of('POST', '/api/admin/users/set-role')[0].input, { userId: ID(3), role: 'user' })
})

test('a record with fields missing says so in words, never "undefined" or a blank', async () => {
  const bare = user(1, { displayName: null, status: 'suspended', suspendedAt: recent(60), suspendedReason: null, emailConfirmed: false })
  openUsers({
    hash: `#/users/${ID(1)}`, users: [bare],
    routes: { 'GET /api/admin/users/detail': () => detailOf(bare, { devices: { active: 0, lastUsedAt: null } }) },
  })
  await settle()
  const panel = document.querySelector('.drawer')
  assert.equal(text(panel.querySelector('.drawer-subtitle')), 'No display name')
  assert.match(text(panel.querySelector('.callout-danger')), /No reason recorded\./)
  const facts = text(panel)
  assert.match(facts, /Last activeNever/)
  assert.match(facts, /EmailNot verified/)
  assert.match(facts, /Signed in on0 devices/)
  assert.match(facts, /Nothing has been flagged for this account\./)
  assert.match(facts, /No generations yet\./)
  assert.doesNotMatch(facts, /undefined|null|NaN/)
})

test('flags and jobs in the panel: decided ones show their outcome, empty fields show a dash, running jobs are not red', async () => {
  const u = user(1, { displayName: null })
  openUsers({
    hash: `#/users/${ID(1)}`, users: [u],
    routes: {
      'GET /api/admin/users/detail': () => detailOf(u, {
        recentEvents: [
          { id: ID(101), source: 'report', action: 'review', categories: [], status: 'dismissed', excerpt: null, createdAt: recent(60) },
          { id: ID(102), source: 'prompt', action: 'blocked', categories: ['sexual'], status: 'open', excerpt: 'words', createdAt: recent(120) },
        ],
        recentJobs: [
          { id: 'j1', taskId: 't1', kind: 'video', model: null, state: 'generating', failMessage: null, kieCredits: null, createdAt: recent(30) },
          { id: 'j2', taskId: 't2', kind: 'video', model: 'm', state: 'fail', failMessage: 'It failed.', kieCredits: 0, createdAt: recent(60) },
        ],
      }),
    },
  })
  await settle()
  const panel = document.querySelector('.drawer')
  const flags = all(panel, 'a.mini-row')
  assert.match(text(flags[0]), /dismissed/)
  assert.match(text(flags[0]), /—/, 'no categories')
  assert.equal(flags[0].querySelector('.quote-line'), null, 'no excerpt, no quote')
  assert.match(text(flags[1]), /words/)
  assert.doesNotMatch(text(flags[1]), /open|dismissed|confirmed/i, 'an open item has no outcome badge')

  const jobs = all(panel, '.mini-row-flat')
  assert.match(text(jobs[0]), /—/)
  assert.match(text(jobs[0]), /KIE cost —/)
  assert.ok(jobs[0].querySelector('.badge-info'), 'a running job is blue')
  assert.ok(jobs[1].querySelector('.badge-danger'))
  assert.match(text(jobs[1]), /KIE cost 0/)
  assert.match(text(jobs[1]), /It failed\./)
})

test('an account that no longer exists offers a Close that returns to the list', async () => {
  const { navigations } = openUsers({ hash: `#/users/${ID(1)}?q=a`, routes: { 'GET /api/admin/users/detail': () => { throw apiError('Gone.', 404, 'NOT_FOUND') } } })
  await settle()
  click(byText(document.querySelector('.drawer'), 'button', 'Close'))
  assert.equal(navigations.at(-1), '#/users?q=a')
})

test('a panel that fails to load for an account you have since moved away from stays quiet', async () => {
  const first = deferred()
  const { controller } = openUsers({
    hash: `#/users/${ID(1)}`,
    routes: { 'GET /api/admin/users/detail': ({ userId }) => (userId === ID(1) ? first.promise : detailOf(user(2))) },
  })
  await settle()
  controller.update(parseRoute(`#/users/${ID(2)}`))
  await settle()
  first.reject(apiError('Late failure.', 500, 'X'))
  await settle()
  assert.doesNotMatch(text(document.querySelector('.drawer')), /Late failure/)
  assert.equal(text(document.querySelector('.drawer .drawer-title')), 'user2@test.example')
})

test('files the checker blocked are counted in red in the panel; none blocked is calm', async () => {
  const u = user(1)
  openUsers({
    hash: `#/users/${ID(1)}`, users: [u],
    routes: { 'GET /api/admin/users/detail': () => detailOf(u, { assets: { byStatus: { unchecked: 1, clear: 3, blocked: 2 }, total: 6 } }) },
  })
  await settle()
  const badges = all(document.querySelector('.drawer'), '.drawer-section .badges .badge')
  assert.match(text(badges.find(b => /blocked/.test(b.textContent))), /2 blocked/)
  assert.ok(badges.find(b => /blocked/.test(b.textContent)).classList.contains('badge-danger'))
  assert.ok(!badges.find(b => /unchecked/.test(b.textContent)).classList.contains('badge-danger'))
})

test('Back (the address losing the account) closes its panel without asking anyone', async () => {
  const { controller, navigations } = openUsers({ hash: `#/users/${ID(1)}` })
  await settle()
  assert.ok(document.querySelector('.drawer'))
  controller.update(parseRoute('#/users'))
  assert.equal(document.querySelector('.drawer'), null)
  assert.deepEqual(navigations, [], 'the address is already where it should be, so nothing navigates')
  assert.equal(document.body.classList.contains('no-scroll'), false, 'and the page can scroll again')
})

test('an account with no display name shows a dash in the list', async () => {
  const { root } = openUsers({ users: [user(1, { displayName: null })] })
  await settle()
  assert.match(text(root.querySelector('tbody tr .user-cell-text')), /user1@test\.example—/)
})

// ── Moderation ───────────────────────────────────────────────────────────────

function openModeration({ hash = '#/moderation', events = [event(1), event(2)], routes = {}, total } = {}) {
  window.matchMedia = () => ({ matches: false })
  const api = fakeApi({
    'GET /api/admin/moderation': q => ({ events, total: total ?? events.length, page: q.page, pageSize: q.pageSize, counts: { open: events.length, dismissed: 0, confirmed: 0 } }),
    'GET /api/admin/moderation/item': q => ({ event: events.find(e => e.id === q.eventId) ?? events[0] }),
    'GET /api/admin/moderation/media': { url: 'https://files.test/x', kind: 'image', expiresIn: 60 },
    'GET /api/admin/config': config(),
    ...routes,
  })
  const { ctx, navigations } = viewContext(api, parseRoute(hash))
  document.body.append(ctx.container)
  const controller = renderModeration(ctx)
  return { api, navigations, controller, root: ctx.container }
}
const idOf = n => ID(100 + n)

test('going back a page in a long queue returns to the first without writing "page 1" in the address', async () => {
  const many = Array.from({ length: 25 }, (_, i) => event(i + 1))
  const { root, navigations } = openModeration({ hash: '#/moderation?page=2', events: many, total: 60 })
  await settle()
  click(root.querySelector('[aria-label="Previous page"]'))
  assert.equal(navigations.at(-1), '#/moderation')
})

test('an item that fails to load after you have moved on to another is not shown as an error', async () => {
  const slow = deferred()
  const { controller, root } = openModeration({ hash: `#/moderation/${idOf(77)}`, routes: { 'GET /api/admin/moderation/item': q => (q.eventId === idOf(77) ? slow.promise : { event: event(2) }) } })
  await settle()
  await controller.update(parseRoute(`#/moderation/${idOf(2)}`))
  await settle()
  slow.reject(apiError('Late.', 500, 'X'))
  await settle()
  assert.doesNotMatch(text(root.querySelector('.mod-detail')), /Late\./)
  assert.match(text(root.querySelector('.mod-detail')), /user2@test\.example/)
})

test('an item with no scores, no categories and no words still shows what it is', async () => {
  const { root } = openModeration({ hash: `#/moderation/${idOf(1)}`, events: [event(1, { categories: [], scores: null, excerpt: null })] })
  await settle()
  const detail = root.querySelector('.mod-detail')
  assert.equal(text(detail.querySelector('.mod-detail-title')), 'Flagged')
  assert.equal(detail.querySelector('.scores'), null)
  assert.equal(detail.querySelector('blockquote'), null)
  assert.ok(detail.querySelector('form.decision'), 'it can still be decided')
})

test('a report with scores but no category names still lists its scores', async () => {
  const { root } = openModeration({ hash: `#/moderation/${idOf(1)}`, events: [event(1, { source: 'report', categories: [], scores: { violence: 0.7 } })] })
  await settle()
  assert.equal(root.querySelectorAll('.score-row').length, 1)
  assert.doesNotMatch(text(root.querySelector('.mod-detail')), /Reported as/)
})

test('a file that was still loading when you moved on does not leave an error behind', async () => {
  const media = deferred()
  const { controller } = openModeration({
    hash: `#/moderation/${idOf(1)}`,
    events: [event(1, { assetId: ID(50), assetKind: 'image', assetStatus: 'blocked' }), event(2)],
    routes: { 'GET /api/admin/moderation/media': () => media.promise },
  })
  await settle()
  click(byText(document, '.reveal button', 'Reveal file'))
  await settle()
  await controller.update(parseRoute(`#/moderation/${idOf(2)}`))
  await settle()
  media.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  await settle()
  assert.doesNotMatch(document.body.textContent, /Try again|aborted/)
})

// ── Prices ───────────────────────────────────────────────────────────────────

const price = (model, over = {}) => ({ model, unit: 'per_video', credits: 20, enabled: true, label: null, note: null, updatedAt: recent(3600), updatedBy: 'boss@test.example', ...over })

function openPrices(payload, routes = {}) {
  const api = fakeApi({ 'GET /api/admin/prices': () => structuredClone(payload), 'POST /api/admin/prices/upsert': body => ({ ok: true, price: body }), ...routes })
  const { ctx } = viewContext(api, { name: 'prices', id: null, query: {} })
  document.body.append(ctx.container)
  renderPrices(ctx)
  return { api, root: ctx.container }
}

test('a unit the page does not know is shown as the server named it, in the list and in the form', async () => {
  const { root } = openPrices({ prices: [price('m', { unit: 'per_minute' })], unpriced: [], units: ['per_video', 'per_minute'] })
  await settle()
  assert.match(text(root.querySelector('tbody tr')), /credits \/ per_minute/)
  click(byText(root.querySelector('tbody tr'), 'button', 'Edit'))
  await settle()
  const options = all(dialog(), 'select option').map(o => o.value)
  assert.deepEqual(options, ['per_video', 'per_minute'])
  assert.equal(dialog().querySelector('select').value, 'per_minute')
})

test('a price whose editor was deleted shows no "updated by" line', async () => {
  const { root } = openPrices({ prices: [price('m', { updatedBy: null })], unpriced: [], units: ['per_video'] })
  await settle()
  const cell = all(root, 'tbody tr td').find(td => /ago/.test(td.textContent))
  assert.doesNotMatch(text(cell), /@/)
})

test('the empty list\'s own "Add a price" button opens the same form as the one in the header', async () => {
  const { root } = openPrices({ prices: [], unpriced: [], units: ['per_video'] })
  await settle()
  click(byText(root.querySelector('.empty'), 'button', 'Add a price'))
  await settle()
  assert.match(text(dialog()), /Add a price/)
  assert.equal(dialog().querySelector('input[readonly]'), null, 'the model id is editable for a new price')
})

// ── Audit log ────────────────────────────────────────────────────────────────

test('details the log can only partly describe are described as far as they go', () => {
  assert.deepEqual(describeDetails('moderation.view-media', {}), [])
  assert.deepEqual(describeDetails('price.upsert', {}), [])
  assert.deepEqual(describeDetails('price.upsert', { credits: 0, enabled: false }), [['Price', '0 credits'], ['Allowed', 'Off']])
  assert.deepEqual(describeDetails('price.upsert', { enabled: true, unit: 'per_video', credits: 3 }), [['Price', '3 credits per video'], ['Allowed', 'On']])
  assert.deepEqual(describeDetails('user.delete', {}), [])
  assert.deepEqual(describeDetails('user.set-role', { email: 'a@b.c', from: 'user', to: 'admin' }), [['Account', 'a@b.c'], ['Role', 'user → admin']])
  assert.deepEqual(describeDetails('anything', undefined), [])
  assert.deepEqual(describeDetails('anything', 'text'), [])
})

test('an entry with a target but no kind of target says "item"', async () => {
  const api = fakeApi({ 'GET /api/admin/audit': () => ({ entries: [{ id: '1', at: recent(60), admin: 'boss@test.example', action: 'x.y', targetType: null, targetId: 'abc-123', details: {} }], total: 1, page: 1, pageSize: 50 }) })
  const { ctx } = viewContext(api, parseRoute('#/audit'))
  document.body.append(ctx.container)
  renderAudit(ctx)
  await settle()
  const target = all(ctx.container, 'tbody tr td')[3]
  assert.match(text(target), /item/)
  assert.match(text(target), /abc-123/)
})
