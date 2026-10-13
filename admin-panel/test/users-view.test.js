// The accounts page: the list, its filters, sorting and paging; the side panel; and
// every action — each checked for what it sends, what it says, and what it refuses.

import test, { beforeEach, mock } from 'node:test'
import assert from './assert.js'

import {
  installDom, reset, click, type, change, submit, settle, microtasks, text, all, byText, fakeApi, viewContext, apiError, user, event, ID,
} from './helpers.js'

// The page words times against the real clock, so times asserted in words are made against it too.
const recent = seconds => new Date(Date.now() - seconds * 1000).toISOString()

installDom()
const { renderUsers } = await import('../views/users.js')
const { parseRoute } = await import('../lib/router.js')

beforeEach(reset)

const ME = { id: ID(900), email: 'boss@test.example' }
const list = (users, extra = {}) => ({ users, total: users.length, page: 1, pageSize: 25, sort: 'created', dir: 'desc', ...extra })

const detail = (u, over = {}) => ({
  user: u,
  strikes: { count: 1, limit: 5, windowDays: 30 },
  devices: { active: 2, lastUsedAt: recent(120) },
  influencers: 3,
  credits: {
    balance: 1234.5, enforced: false,
    recent: [
      { id: '9', kind: 'purchase', delta: 1500, note: 'credits_1500', model: null, taskId: null, by: null, createdAt: recent(600) },
      { id: '8', kind: 'spend', delta: -18, note: 'Generation started', model: 'nano-banana-pro', taskId: 't1', by: null, createdAt: recent(300) },
      { id: '7', kind: 'grant', delta: 250, note: 'Play review test account', model: null, taskId: null, by: 'boss@test.example', createdAt: recent(7200) },
    ],
  },
  assets: { byStatus: { unchecked: 1, clear: 4, blocked: 0 }, total: 5 },
  recentJobs: [
    { id: 'j1', taskId: 't1', kind: 'video', model: 'kling-3.0/video', state: 'success', failMessage: null, kieCredits: 27, createdAt: recent(300) },
    { id: 'j2', taskId: 't2', kind: 'video', model: 'veo-3-1', state: 'fail', failMessage: 'Your prompt was flagged.', kieCredits: null, createdAt: recent(900) },
  ],
  recentEvents: [{ id: ID(101), source: 'prompt', action: 'blocked', categories: ['sexual'], status: 'open', excerpt: 'a refused prompt', createdAt: recent(60) }],
  ...over,
})

/** Mount the page with a scripted API. `users` is what the list returns. */
function open({ hash = '#/users', users = [user(1), user(2)], routes = {}, me = ME } = {}) {
  const api = fakeApi({
    'GET /api/admin/users': () => list(users),
    'GET /api/admin/users/detail': ({ userId }) => detail(users.find(u => u.id === userId) ?? users[0]),
    'POST /api/admin/users/suspend': { ok: true, changed: true },
    'POST /api/admin/users/unsuspend': { ok: true, changed: true },
    'POST /api/admin/users/set-role': { ok: true, changed: true },
    'POST /api/admin/users/delete': { ok: true, deletedObjects: 2 },
    'POST /api/admin/billing/grant': { ok: true, balance: 1734.5 },
    ...routes,
  }, { user: me })
  const { ctx, navigations } = viewContext(api, parseRoute(hash))
  document.body.append(ctx.container)
  const controller = renderUsers(ctx)
  return { api, ctx, navigations, controller, root: ctx.container }
}

const lastListQuery = api => api.of('GET', '/api/admin/users').at(-1).input
const rowFor = (root, email) => all(root, 'tbody tr').find(r => r.textContent.includes(email))
const openRowMenu = (root, email) => click(rowFor(root, email).querySelector('[aria-haspopup=menu]'))
const menuItem = label => byText(document, '.menu [role=menuitem]', label)
const dialog = () => document.querySelector('dialog')

// ── The list ─────────────────────────────────────────────────────────────────

test('the list shows each account with its status, numbers and flags', async () => {
  const people = [
    user(1, { displayName: 'Mia', openEvents: 2, storageBytes: 4_200_000, kieCredits: 1234.5, jobs: 12 }),
    user(2, { status: 'suspended', suspendedReason: 'spam' }),
    user(3, { role: 'admin', emailConfirmed: false }),
    { ...user(900), email: ME.email },
  ]
  const { root } = open({ users: people })
  await settle()

  assert.equal(all(root, 'tbody tr').length, 4)
  const first = text(rowFor(root, 'user1@test.example'))
  assert.match(first, /Mia/)
  assert.match(first, /Active/)
  assert.match(first, /12/)
  assert.match(first, /4\.0 MB/)
  assert.match(first, /1,234\.5/)
  assert.equal(rowFor(root, 'user1@test.example').querySelectorAll('.badge-warning').length >= 1, true, 'open flags shown')

  assert.match(text(rowFor(root, 'user2@test.example')), /Suspended/)
  assert.match(text(rowFor(root, 'user3@test.example')), /Admin/)
  assert.match(text(rowFor(root, 'user3@test.example')), /Unverified/)
  assert.match(text(rowFor(root, ME.email)), /You/)
  assert.equal(rowFor(root, 'user2@test.example').querySelector('.badge-warning'), null, 'no flags, no badge')
  assert.match(text(root), /4 accounts/)
})

test('the first request asks for the defaults', async () => {
  const { api } = open()
  await settle()
  assert.deepEqual(lastListQuery(api), { q: '', status: '', sort: 'created', dir: 'desc', page: 1, pageSize: 25 })
})

test('the address\'s filters become the request, and nonsense in the address becomes the defaults', async () => {
  const good = open({ hash: '#/users?q=mia&status=suspended&sort=jobs&dir=asc&page=3&pageSize=50' })
  await settle()
  assert.deepEqual(lastListQuery(good.api), { q: 'mia', status: 'suspended', sort: 'jobs', dir: 'asc', page: 3, pageSize: 50 })

  reset()
  const bad = open({ hash: '#/users?q=&status=bogus&sort=password_hash&dir=sideways&page=abc&pageSize=7' })
  await settle()
  assert.deepEqual(lastListQuery(bad.api), { q: '', status: '', sort: 'created', dir: 'desc', page: 1, pageSize: 25 })
})

test('the summary counts accounts, and says "match" when a filter is on', async () => {
  const { root, api } = open({ hash: '#/users?q=zz', routes: { 'GET /api/admin/users': () => list([user(1)], { total: 1 }) } })
  await settle()
  assert.match(text(root), /1 account match/)
  void api
})

test('an empty list says why: nobody yet, or nobody matching with a way to clear the filters', async () => {
  const none = open({ users: [] })
  await settle()
  assert.match(text(none.root), /No accounts yet/)
  assert.equal(none.root.querySelector('.empty button'), null)

  reset()
  const filtered = open({ hash: '#/users?q=zzz&status=active', users: [] })
  await settle()
  assert.match(text(filtered.root), /No accounts match/)
  click(filtered.root.querySelector('.empty button'))
  assert.deepEqual(filtered.navigations, ['#/users'])
})

test('a failed load shows the error, and Try again loads again', async () => {
  let n = 0
  const { root, api } = open({ routes: { 'GET /api/admin/users': () => { if (++n === 1) throw apiError('The database is down.', 503, 'UPSTREAM_UNAVAILABLE'); return list([user(1)]) } } })
  await settle()
  assert.match(text(root), /The database is down/)
  click(byText(root, 'button', 'Try again'))
  await settle()
  assert.equal(all(root, 'tbody tr').length, 1)
  assert.equal(api.of('GET', '/api/admin/users').length, 2)
})

test('everything from the server is text: a hostile email or name builds no elements', async () => {
  const evil = user(1, { email: '<img src=x onerror=alert(1)>@x.test', displayName: '<script>alert(2)</script>', suspendedReason: '<b>x</b>' })
  const { root } = open({ users: [evil] })
  await settle()
  assert.equal(root.querySelectorAll('img, script, b').length, 0)
  assert.match(text(root), /<img src=x/)
})

// ── Searching, filtering, sorting, paging ────────────────────────────────────

test('typing in the search waits for a pause, then puts the term in the address and goes back to page 1', async () => {
  const { root, navigations } = open({ hash: '#/users?page=4&status=active' })
  await settle()
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const input = root.querySelector('input[type=search]')
    type(input, 'm'); mock.timers.tick(100)
    type(input, 'mi'); mock.timers.tick(100)
    type(input, '  mia b  ')
    mock.timers.tick(299)
    assert.deepEqual(navigations, [], 'nothing until the typing stops')
    mock.timers.tick(1)
    assert.deepEqual(navigations, ['#/users?status=active&q=mia+b'], 'trimmed; page dropped; other filters kept')

    type(input, '   ')
    mock.timers.tick(300)
    assert.equal(navigations.at(-1), '#/users?status=active&page=4'.replace('&page=4', ''), 'clearing the term removes it')
  } finally { mock.timers.reset() }
})

test('the status filter changes the address and resets the page; "All" removes it', async () => {
  const { root, navigations } = open({ hash: '#/users?page=2' })
  await settle()
  click(byText(root, '[role=radio]', 'Suspended'))
  click(byText(root, '[role=radio]', 'Active'))
  assert.deepEqual(navigations, ['#/users?status=suspended', '#/users?status=active'])

  reset()
  const withStatus = open({ hash: '#/users?status=active' })
  await settle()
  assert.equal(byText(withStatus.root, '[role=radio]', 'Active').getAttribute('aria-checked'), 'true')
  click(byText(withStatus.root, '[role=radio]', 'All'))
  assert.deepEqual(withStatus.navigations, ['#/users'])
})

test('sorting: the first click on a column uses its natural direction, a second flips it, and the default sort leaves the address clean', async () => {
  const { root, navigations } = open()
  await settle()
  const header = label => byText(root, 'th button', label)

  click(header('Jobs'))
  assert.equal(navigations.at(-1), '#/users?sort=jobs', 'numbers: biggest first, which is the default direction, so no dir')
  click(header('Account'))
  assert.equal(navigations.at(-1), '#/users?sort=email&dir=asc', 'names: A to Z first')

  reset()
  const sorted = open({ hash: '#/users?sort=email&dir=asc' })
  await settle()
  assert.equal(byText(sorted.root, 'th', 'Account').getAttribute('aria-sort'), 'ascending')
  click(byText(sorted.root, 'th button', 'Account'))
  assert.equal(sorted.navigations.at(-1), '#/users?sort=email')

  reset()
  const created = open({ hash: '#/users?sort=jobs' })
  await settle()
  click(byText(created.root, 'th button', 'Joined'))
  assert.equal(created.navigations.at(-1), '#/users', 'newest first is the default, so nothing is added')
})

test('paging: next goes to page 2, back to page 1 leaves the address clean, and a new page size starts over', async () => {
  const many = Array.from({ length: 25 }, (_, i) => user(i + 1))
  const { root, navigations } = open({ hash: '#/users?q=a', users: many, routes: { 'GET /api/admin/users': () => list(many, { total: 130 }) } })
  await settle()
  click(root.querySelector('[aria-label="Next page"]'))
  assert.equal(navigations.at(-1), '#/users?q=a&page=2')
  change(root.querySelector('select[aria-label="Rows per page"]'), '100')
  assert.equal(navigations.at(-1), '#/users?q=a&pageSize=100')
  assert.match(text(root), /1–25 of 130/)
})

test('clicking a row opens that account, keeping the filters', async () => {
  const { root, navigations } = open({ hash: '#/users?q=user&sort=jobs' })
  await settle()
  click(rowFor(root, 'user2@test.example').querySelector('td'))
  assert.deepEqual(navigations, [`#/users/${ID(2)}?q=user&sort=jobs`])
})

// ── Following the address ────────────────────────────────────────────────────

test('update: a changed filter reloads the list; an unchanged one does not; opening a record only opens the panel', async () => {
  const { api, controller } = open()
  await settle()
  assert.equal(api.of('GET', '/api/admin/users').length, 1)

  controller.update(parseRoute('#/users'))
  await settle()
  assert.equal(api.of('GET', '/api/admin/users').length, 1, 'same filters: no reload')

  controller.update(parseRoute('#/users?q=mia'))
  await settle()
  assert.equal(api.of('GET', '/api/admin/users').length, 2)
  assert.equal(lastListQuery(api).q, 'mia')

  controller.update(parseRoute(`#/users/${ID(1)}?q=mia`))
  await settle()
  assert.equal(api.of('GET', '/api/admin/users').length, 2, 'opening a record does not refetch the list')
  assert.equal(api.of('GET', '/api/admin/users/detail').length, 1)
  assert.ok(document.querySelector('.drawer'))
})

test('an older request is cancelled when a newer one replaces it', async () => {
  const { api, controller } = open()
  await settle()
  controller.update(parseRoute('#/users?q=a'))
  controller.update(parseRoute('#/users?q=ab'))
  await settle()
  const calls = api.of('GET', '/api/admin/users')
  assert.equal(calls[1].signal.aborted, true, 'the stale one was aborted')
  assert.equal(calls[2].signal.aborted, false)
})

test('the search box follows Back and Forward, but never overwrites what is being typed', async () => {
  const { root, controller } = open({ hash: '#/users?q=mia' })
  await settle()
  const input = root.querySelector('input[type=search]')
  assert.equal(input.value, 'mia')
  controller.update(parseRoute('#/users?q=bob'))
  await settle()
  assert.equal(input.value, 'bob')

  input.focus()
  type(input, 'bobby')
  controller.update(parseRoute('#/users?q=zed'))
  await settle()
  assert.equal(input.value, 'bobby', 'a field with focus is left alone')
})

test('destroy cancels what is in flight and closes the panel', async () => {
  const { api, controller } = open({ hash: `#/users/${ID(1)}` })
  await settle()
  assert.ok(document.querySelector('.drawer'))
  controller.destroy()
  assert.equal(document.querySelector('.drawer'), null)
  assert.equal(api.of('GET', '/api/admin/users')[0].signal.aborted, true)
})

// ── Row menu: who may be offered what ────────────────────────────────────────

test('the row menu offers the right things — and disables, with a reason, what cannot be done', async () => {
  const people = [user(1), user(2, { status: 'suspended' }), user(3, { role: 'admin' }), { ...user(900), email: ME.email, role: 'admin' }]
  const { root } = open({ users: people })
  await settle()

  openRowMenu(root, 'user1@test.example')
  assert.ok(menuItem('Suspend…') && !menuItem('Suspend…').disabled)
  assert.ok(menuItem('Make administrator…') && !menuItem('Make administrator…').disabled)
  assert.ok(menuItem('Delete account…') && !menuItem('Delete account…').disabled)
  assert.equal(menuItem('Restore account'), null)
  click(document.body)

  openRowMenu(root, 'user2@test.example')
  assert.ok(menuItem('Restore account'))
  assert.equal(menuItem('Suspend…'), null)
  click(document.body)

  openRowMenu(root, 'user3@test.example')
  assert.equal(menuItem('Suspend…').disabled, true)
  assert.match(menuItem('Suspend…').title, /admin role first/)
  assert.ok(menuItem('Remove admin role…') && !menuItem('Remove admin role…').disabled)
  assert.equal(menuItem('Delete account…').disabled, true)
  click(document.body)

  openRowMenu(root, ME.email)
  assert.equal(menuItem('Suspend…').disabled, true)
  assert.match(menuItem('Suspend…').title, /your own account/)
  assert.equal(menuItem('Remove admin role…'), null, 'you cannot offer to demote yourself: the item reads "Make administrator"')
  assert.equal(menuItem('Make administrator…').disabled, true)
  assert.equal(menuItem('Delete account…').disabled, true)
})

// ── Suspend ──────────────────────────────────────────────────────────────────

async function startSuspend(env) {
  openRowMenu(env.root, 'user1@test.example')
  click(menuItem('Suspend…'))
  await settle()
  return { d: dialog(), reason: dialog().querySelector('textarea') }
}

test('suspending asks for a reason, sends it trimmed, says so, and refreshes the list and the sidebar', async () => {
  const env = open()
  await settle()
  const { d, reason } = await startSuspend(env)
  assert.match(text(d), /signed out on every device/)
  type(reason, '  repeated explicit prompts  ')
  assert.match(text(d), /29 \/ 300/, 'the counter follows what is typed')
  submit(d.querySelector('form'))
  await settle()

  assert.deepEqual(env.api.of('POST', '/api/admin/users/suspend')[0].input, { userId: ID(1), reason: 'repeated explicit prompts' })
  assert.equal(dialog(), null)
  assert.match(text(document.querySelector('.toast-success')), /user1@test.example was suspended/)
  assert.equal(env.api.of('GET', '/api/admin/users').length, 2, 'the list was reloaded')
  assert.equal(env.navigations.refreshed, 1, 'the sidebar count was refreshed')
})

test('suspending without a reason, or with too long a one, is explained in the dialog and sends nothing', async () => {
  const env = open()
  await settle()
  const { d, reason } = await startSuspend(env)
  submit(d.querySelector('form')); await settle()
  assert.match(text(d.querySelector('.form-error')), /Give a reason/)
  type(reason, '   '); submit(d.querySelector('form')); await settle()
  assert.match(text(d.querySelector('.form-error')), /Give a reason/)
  type(reason, 'x'.repeat(301)); submit(d.querySelector('form')); await settle()
  assert.match(text(d.querySelector('.form-error')), /at most 300/)
  assert.equal(env.api.of('POST', '/api/admin/users/suspend').length, 0)
  assert.ok(dialog(), 'still open')
})

test('if the server refuses the suspension, its reason is shown in the dialog and what was typed is kept', async () => {
  const env = open({ routes: { 'POST /api/admin/users/suspend': () => { throw apiError('Remove their admin role before you suspend them.', 403, 'TARGET_IS_ADMIN') } } })
  await settle()
  const { d, reason } = await startSuspend(env)
  type(reason, 'because')
  submit(d.querySelector('form')); await settle()
  assert.match(text(d.querySelector('.form-error')), /admin role before/)
  assert.equal(reason.value, 'because')
  assert.equal(env.api.of('GET', '/api/admin/users').length, 1, 'nothing refreshed after a failure')
  assert.equal(document.querySelector('.toast-success'), null)
})

test('cancelling the suspension sends nothing', async () => {
  const env = open()
  await settle()
  const { d } = await startSuspend(env)
  click(d.querySelector('button[type=button]'))
  await settle()
  assert.equal(env.api.of('POST', '/api/admin/users/suspend').length, 0)
  assert.equal(dialog(), null)
})

// ── Restore, roles ───────────────────────────────────────────────────────────

test('restoring asks first, then sends, then says so; a failure is reported and the list is not refreshed', async () => {
  const env = open({ users: [user(1, { status: 'suspended' })] })
  await settle()
  openRowMenu(env.root, 'user1@test.example')
  click(menuItem('Restore account'))
  await settle()
  assert.match(text(dialog()), /Restore user1@test.example\?/)
  submit(dialog().querySelector('form'))
  await settle()
  assert.deepEqual(env.api.of('POST', '/api/admin/users/unsuspend')[0].input, { userId: ID(1) })
  assert.match(text(document.querySelector('.toast-success')), /can sign in again/)

  reset()
  const failing = open({ users: [user(1, { status: 'suspended' })], routes: { 'POST /api/admin/users/unsuspend': () => { throw apiError('Boom', 500, 'INTERNAL') } } })
  await settle()
  openRowMenu(failing.root, 'user1@test.example')
  click(menuItem('Restore account'))
  await settle()
  submit(dialog().querySelector('form'))
  await settle()
  assert.match(text(document.querySelector('.toast-error')), /Could not restore the account/)
  assert.match(text(document.querySelector('.toast-error')), /Boom/)
})

test('changing a role: the question says what it means, and a "no" sends nothing', async () => {
  const env = open({ users: [user(1), user(2, { role: 'admin' })] })
  await settle()

  openRowMenu(env.root, 'user1@test.example')
  click(menuItem('Make administrator…'))
  await settle()
  assert.match(text(dialog()), /Make user1@test.example an administrator\?/)
  assert.match(text(dialog()), /suspend and delete accounts/)
  click(dialog().querySelector('button[type=button]'))
  await settle()
  assert.equal(env.api.of('POST', '/api/admin/users/set-role').length, 0)

  openRowMenu(env.root, 'user1@test.example')
  click(menuItem('Make administrator…'))
  await settle()
  submit(dialog().querySelector('form'))
  await settle()
  assert.deepEqual(env.api.of('POST', '/api/admin/users/set-role')[0].input, { userId: ID(1), role: 'admin' })
  assert.match(text(document.querySelector('.toast-success')), /is now an administrator/)

  openRowMenu(env.root, 'user2@test.example')
  click(menuItem('Remove admin role…'))
  await settle()
  assert.match(text(dialog()), /lose access to this panel/)
  assert.ok(dialog().querySelector('.btn-danger-solid'), 'demoting is styled as the serious thing it is')
  submit(dialog().querySelector('form'))
  await settle()
  assert.deepEqual(env.api.of('POST', '/api/admin/users/set-role')[1].input, { userId: ID(2), role: 'user' })
})

// ── Delete ───────────────────────────────────────────────────────────────────

async function startDelete(env, email = 'user1@test.example') {
  openRowMenu(env.root, email)
  click(menuItem('Delete account…'))
  await settle()
  return { d: dialog(), typed: dialog().querySelector('input') }
}

test('deleting needs the account\'s email typed; a mismatch is explained and sends nothing', async () => {
  const env = open()
  await settle()
  const { d, typed } = await startDelete(env)
  assert.match(text(d), /permanently deletes the account/)
  type(typed, 'someone@else.test')
  submit(d.querySelector('form')); await settle()
  assert.match(text(d.querySelector('.form-error')), /not the account’s email/)
  type(typed, ''); submit(d.querySelector('form')); await settle()
  assert.equal(env.api.of('POST', '/api/admin/users/delete').length, 0)
  assert.ok(dialog())
})

test('typing the email (any case, any padding) deletes: what is sent is what was typed, and the list refreshes', async () => {
  const env = open()
  await settle()
  const { d, typed } = await startDelete(env)
  type(typed, '  USER1@test.example ')
  submit(d.querySelector('form')); await settle()
  assert.deepEqual(env.api.of('POST', '/api/admin/users/delete')[0].input, { userId: ID(1), confirmEmail: '  USER1@test.example ' })
  assert.match(text(document.querySelector('.toast-success')), /user1@test.example was deleted/)
  assert.equal(env.api.of('GET', '/api/admin/users').length, 2)
  assert.equal(dialog(), null)
})

test('a failed deletion keeps the dialog and shows the server\'s reason', async () => {
  const env = open({ routes: { 'POST /api/admin/users/delete': () => { throw apiError('Remove their admin role before you delete them.', 403, 'TARGET_IS_ADMIN') } } })
  await settle()
  const { d, typed } = await startDelete(env)
  type(typed, 'user1@test.example')
  submit(d.querySelector('form')); await settle()
  assert.match(text(d.querySelector('.form-error')), /admin role before/)
  assert.ok(dialog())
})

// ── The side panel ───────────────────────────────────────────────────────────

test('opening an account shows its panel: who, how they are doing, strikes, flags and jobs', async () => {
  const target = user(1, { displayName: 'Mia', jobs: 12, kieCredits: 99, storageBytes: 4_200_000 })
  const { api } = open({ hash: `#/users/${ID(1)}`, users: [target, user(2)] })
  await settle()

  const panel = document.querySelector('.drawer')
  assert.equal(text(panel.querySelector('.drawer-title')), 'user1@test.example')
  assert.equal(text(panel.querySelector('.drawer-subtitle')), 'Mia')
  assert.deepEqual(api.of('GET', '/api/admin/users/detail')[0].input, { userId: ID(1) })

  const body = text(panel)
  assert.match(body, /Signed in on2 devices/)
  assert.match(body, /Influencers3/)
  assert.match(body, /4\.0 MB/)
  assert.match(body, /Verified/)
  assert.match(body, /1 \/ 5/)
  assert.match(body, /last 30 days/)
  assert.match(body, /1 unchecked/)
  assert.match(body, /4 clear/)

  const flags = panel.querySelector('a[href*="#/moderation/"]')
  assert.equal(flags.getAttribute('href'), `#/moderation/${ID(101)}?status=all`)
  assert.match(text(flags), /Prompt/)
  assert.match(text(flags), /Refused/)
  assert.match(text(flags), /a refused prompt/)

  assert.match(body, /kling-3\.0\/video/)
  assert.match(body, /27 credits/)
  assert.match(body, /— credits/, 'a job KIE gave no charge for says so')
  assert.match(body, /Your prompt was flagged/)
  assert.ok(panel.querySelector('a[href="#/jobs?userId=' + ID(1) + '"]'))
})

test('the selected row is highlighted while its panel is open', async () => {
  const { root } = open({ hash: `#/users/${ID(2)}` })
  await settle()
  assert.ok(rowFor(root, 'user2@test.example').classList.contains('row-selected'))
  assert.ok(!rowFor(root, 'user1@test.example').classList.contains('row-selected'))
})

test('strikes: calm below the limit, a warning when there are some, danger at the limit (and admins are exempt)', async () => {
  const cases = [
    [{ count: 0, limit: 5, windowDays: 30 }, 'badge-success', 'meter-success'],
    [{ count: 2, limit: 5, windowDays: 30 }, 'badge-warning', 'meter-warning'],
    [{ count: 5, limit: 5, windowDays: 30 }, 'badge-danger', 'meter-danger'],
    [{ count: 9, limit: 5, windowDays: 30 }, 'badge-danger', 'meter-danger'],
  ]
  for (const [strikes, badgeClass, meterClass] of cases) {
    reset()
    open({ hash: `#/users/${ID(1)}`, routes: { 'GET /api/admin/users/detail': () => detail(user(1), { strikes }) } })
    await settle()
    const panel = document.querySelector('.drawer')
    assert.ok(panel.querySelector(`.section-head .${badgeClass}`), `${strikes.count}: ${badgeClass}`)
    assert.ok(panel.querySelector(`.${meterClass}`), `${strikes.count}: ${meterClass}`)
  }
  reset()
  open({ hash: `#/users/${ID(3)}`, routes: { 'GET /api/admin/users/detail': () => detail(user(3, { role: 'admin' })) } })
  await settle()
  assert.match(text(document.querySelector('.drawer')), /except administrators, who never are/)
})

test('a suspended account\'s panel says since when and why, and offers Restore instead of Suspend', async () => {
  open({ hash: `#/users/${ID(1)}`, routes: { 'GET /api/admin/users/detail': () => detail(user(1, { status: 'suspended', suspendedAt: recent(7200), suspendedReason: 'By boss: spam' })) } })
  await settle()
  const panel = document.querySelector('.drawer')
  assert.match(text(panel.querySelector('.callout-danger')), /Suspended 2 h ago/)
  assert.match(text(panel.querySelector('.callout-danger')), /By boss: spam/)
  assert.ok(byText(panel, 'button', 'Restore account'))
  assert.equal(byText(panel, 'button', 'Suspend…'), null)
})

test('the panel\'s actions are disabled for yourself and for other admins, with the reason on hover', async () => {
  open({ hash: `#/users/${ME.id}`, users: [{ ...user(900), role: 'admin' }], routes: { 'GET /api/admin/users/detail': () => detail({ ...user(900), role: 'admin', email: ME.email }) } })
  await settle()
  let panel = document.querySelector('.drawer')
  for (const label of ['Suspend…', 'Make administrator…', 'Delete…']) {
    const b = byText(panel, 'button', label)
    assert.equal(b.disabled, true, label)
    assert.match(b.title, /your own account/, label)
  }

  reset()
  open({ hash: `#/users/${ID(3)}`, routes: { 'GET /api/admin/users/detail': () => detail(user(3, { role: 'admin' })) } })
  await settle()
  panel = document.querySelector('.drawer')
  assert.equal(byText(panel, 'button', 'Suspend…').disabled, true)
  assert.match(byText(panel, 'button', 'Suspend…').title, /admin role first/)
  assert.ok(byText(panel, 'button', 'Remove admin role…') && !byText(panel, 'button', 'Remove admin role…').disabled)
})

test('using the panel\'s Suspend button works the same as the menu, and the panel refreshes afterwards', async () => {
  const env = open({ hash: `#/users/${ID(1)}` })
  await settle()
  click(byText(document.querySelector('.drawer'), 'button', 'Suspend…'))
  await settle()
  type(dialog().querySelector('textarea'), 'spam')
  submit(dialog().querySelector('form')); await settle()
  assert.deepEqual(env.api.of('POST', '/api/admin/users/suspend')[0].input, { userId: ID(1), reason: 'spam' })
  assert.equal(env.api.of('GET', '/api/admin/users/detail').length, 2, 'the panel reloaded to show the new state')
})

test('deleting from the panel closes it and returns to the list', async () => {
  const env = open({ hash: `#/users/${ID(1)}?q=a` })
  await settle()
  click(byText(document.querySelector('.drawer'), 'button', 'Delete…'))
  await settle()
  type(dialog().querySelector('input'), 'user1@test.example')
  submit(dialog().querySelector('form')); await settle()
  assert.equal(document.querySelector('.drawer'), null)
  assert.equal(env.navigations.at(-1), '#/users?q=a')
})

test('closing the panel returns to the list with the same filters', async () => {
  const env = open({ hash: `#/users/${ID(1)}?q=user&sort=jobs` })
  await settle()
  click(document.querySelector('.drawer [aria-label=Close]'))
  assert.equal(env.navigations.at(-1), '#/users?q=user&sort=jobs')
  // …and when the address changes to the list, the panel is gone.
  env.controller.update(parseRoute('#/users?q=user&sort=jobs'))
  assert.equal(document.querySelector('.drawer'), null)
})

test('an account that no longer exists is said so kindly, with a way out; other failures can be retried', async () => {
  open({ hash: `#/users/${ID(1)}`, routes: { 'GET /api/admin/users/detail': () => { throw apiError('That account does not exist.', 404, 'NOT_FOUND') } } })
  await settle()
  assert.match(text(document.querySelector('.drawer')), /no longer exists/)
  assert.ok(byText(document.querySelector('.drawer'), 'button', 'Close'))

  reset()
  let n = 0
  const env = open({ hash: `#/users/${ID(1)}`, routes: { 'GET /api/admin/users/detail': () => { if (++n === 1) throw apiError('Slow database.', 503, 'X'); return detail(user(1)) } } })
  await settle()
  assert.match(text(document.querySelector('.drawer')), /Slow database/)
  click(byText(document.querySelector('.drawer'), 'button', 'Try again'))
  await settle()
  assert.equal(text(document.querySelector('.drawer .drawer-title')), 'user1@test.example')
  assert.equal(env.api.of('GET', '/api/admin/users/detail').length, 2)
})

test('switching quickly from one account to another shows the second, never the first arriving late', async () => {
  let releaseFirst
  const env = open({
    users: [user(1), user(2)],
    routes: {
      'GET /api/admin/users/detail': ({ userId }) => (userId === ID(1)
        ? new Promise(r => { releaseFirst = () => r(detail(user(1))) })
        : detail(user(2))),
    },
  })
  await settle()
  env.controller.update(parseRoute(`#/users/${ID(1)}`))
  await settle()
  env.controller.update(parseRoute(`#/users/${ID(2)}`))
  await settle()
  releaseFirst()
  await settle()
  assert.equal(text(document.querySelector('.drawer .drawer-title')), 'user2@test.example')
})

test('hostile text in the panel (flags, jobs, reasons) is text', async () => {
  open({
    hash: `#/users/${ID(1)}`,
    routes: {
      'GET /api/admin/users/detail': () => detail(user(1, { email: '<i>e</i>@x.test', displayName: '<u>n</u>' }), {
        recentEvents: [{ id: ID(101), source: 'prompt', action: 'blocked', categories: ['sexual'], status: 'open', excerpt: '<img src=x onerror=1>', createdAt: recent(1) }],
        recentJobs: [{ id: 'j', taskId: 't', kind: 'video', model: '<b>m</b>', state: 'fail', failMessage: '<script>1</script>', kieCredits: 0, createdAt: recent(1) }],
      }),
    },
  })
  await settle()
  assert.equal(document.querySelectorAll('.drawer img, .drawer script, .drawer b, .drawer i, .drawer u').length, 0)
})

void microtasks; void event


// ── Credits ──────────────────────────────────────────────────────────────────

const credits = (balance, over = {}) => ({ credits: { balance, enforced: false, recent: [], ...over } })
const openCreditsDialog = async () => {
  click(byText(document.querySelector('.drawer'), 'button', 'Add or remove credits'))
  await settle()
  const d = dialog()
  return { d, amount: d.querySelector('input[type=number]'), reason: d.querySelector('textarea') }
}

test('the panel shows the balance, what is behind it in words, and that nothing is being charged yet', async () => {
  open({ hash: `#/users/${ID(1)}` })
  await settle()
  const body = text(document.querySelector('.drawer'))
  assert.match(body, /Credits1,234\.5 credits/)
  assert.match(body, /not being charged yet/)
  assert.match(body, /Bought a pack/)
  assert.match(body, /\+1,500/)
  assert.match(body, /Used for a generation/)
  assert.match(body, /-18/)
  assert.match(body, /Credits given/)
  assert.match(body, /Play review test account · boss@test\.example/, 'who gave them, and why')
})

test('once charging is on the note about it goes away; a negative balance is flagged; an empty history says so', async () => {
  open({ hash: `#/users/${ID(1)}`, routes: { 'GET /api/admin/users/detail': () => detail(user(1), credits(-50, { enforced: true })) } })
  await settle()
  const panel = text(document.querySelector('.drawer'))
  assert.doesNotMatch(panel, /not being charged yet/)
  assert.match(panel, /-50 credits/)
  assert.match(panel, /No credit activity yet/)
  assert.ok(document.querySelector('.drawer .section-head .badge-danger'), 'a balance below zero is a warning')
})

test('adding credits asks for an amount and a reason, sends both, says what the balance is now, and refreshes the panel', async () => {
  const env = open({ hash: `#/users/${ID(1)}` })
  await settle()
  const { d, amount, reason } = await openCreditsDialog()
  assert.match(text(d), /1,234\.5 credits now/)
  type(amount, '500')
  type(reason, '  Reviewer test account  ')
  submit(d.querySelector('form'))
  await settle()

  assert.deepEqual(env.api.of('POST', '/api/admin/billing/grant')[0].input, { userId: ID(1), credits: 500, note: 'Reviewer test account' })
  assert.equal(dialog(), null)
  assert.match(text(document.querySelector('.toast-success')), /user1@test\.example now has 1,734\.5 credits/)
  assert.equal(env.api.of('GET', '/api/admin/users/detail').length, 2, 'the panel was reloaded')
})

test('taking credits back is a negative number, sent as it is', async () => {
  const env = open({ hash: `#/users/${ID(1)}` })
  await settle()
  const { d, amount, reason } = await openCreditsDialog()
  type(amount, '-100.5'); type(reason, 'Chargeback')
  submit(d.querySelector('form')); await settle()
  assert.deepEqual(env.api.of('POST', '/api/admin/billing/grant')[0].input, { userId: ID(1), credits: -100.5, note: 'Chargeback' })
})

test('no amount, zero, or no reason is explained in the dialog and sends nothing', async () => {
  const env = open({ hash: `#/users/${ID(1)}` })
  await settle()
  const { d, amount, reason } = await openCreditsDialog()
  submit(d.querySelector('form')); await settle()
  assert.match(text(d.querySelector('.form-error')), /number of credits other than 0/)
  type(amount, '0'); submit(d.querySelector('form')); await settle()
  assert.match(text(d.querySelector('.form-error')), /number of credits other than 0/)
  type(amount, '25'); type(reason, '   '); submit(d.querySelector('form')); await settle()
  assert.match(text(d.querySelector('.form-error')), /Give a reason/)
  assert.equal(env.api.of('POST', '/api/admin/billing/grant').length, 0)
  assert.ok(dialog(), 'still open')
})

test('if the server refuses, its reason is shown in the dialog and what was typed is kept', async () => {
  const env = open({ hash: `#/users/${ID(1)}`, routes: { 'POST /api/admin/billing/grant': () => { throw apiError('That account does not exist.', 404, 'NOT_FOUND') } } })
  await settle()
  const { d, amount, reason } = await openCreditsDialog()
  type(amount, '10'); type(reason, 'because')
  submit(d.querySelector('form')); await settle()
  assert.match(text(d.querySelector('.form-error')), /does not exist/)
  assert.equal(amount.value, '10')
  assert.equal(reason.value, 'because')
  assert.equal(document.querySelector('.toast-success'), null)
  assert.equal(env.api.of('GET', '/api/admin/users/detail').length, 1, 'nothing refreshed after a failure')
})

test('cancelling the credits dialog sends nothing', async () => {
  const env = open({ hash: `#/users/${ID(1)}` })
  await settle()
  const { d } = await openCreditsDialog()
  click(d.querySelector('button[type=button]'))
  await settle()
  assert.equal(dialog(), null)
  assert.equal(env.api.of('POST', '/api/admin/billing/grant').length, 0)
})

test('what a ledger row is called on screen is covered for every kind the server writes', async () => {
  const { creditKind } = await import('../views/users.js')
  for (const kind of ['purchase', 'grant', 'adjust', 'spend', 'refund', 'clawback']) assert.notEqual(creditKind(kind), kind, kind)
  assert.equal(creditKind('something-new'), 'something-new')
})
