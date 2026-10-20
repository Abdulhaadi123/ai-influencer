// Security: the administrator's side, as a whole.
//
// admin.test.js and admin-depth.test.js say what each panel action does and what it leaves behind, one at a
// time. This looks across all of them for the things that must hold for every route, including the ones
// that do not exist yet:
//
//   • every action that changes something is in the audit log, with who did it — and a new admin write
//     route that nobody added to this list fails the test, so it cannot be forgotten;
//   • no answer from anywhere in the API contains a secret: not a password hash, not a token or its hash,
//     not any key the server holds;
//   • the role is exactly "admin" or "user" and nothing an administrator sends along changes anything else;
//   • an administrator cannot be acted on by another one, nor by themselves, through any route that could
//     lock someone out.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack, jpeg } from '../helpers/stack.js'

const SECRETS = {
  KIE_API_KEY: 'kie-key-DO-NOT-LEAK-7f3a9c',
  OPENAI_API_KEY: 'sk-openai-DO-NOT-LEAK-b81e44',
  AWS_SECRET_ACCESS_KEY: 'aws-secret-DO-NOT-LEAK-52d0aa91',
  SMTP_USER: 'smtp-user-DO-NOT-LEAK',
  SMTP_PASS: 'smtp-pass-DO-NOT-LEAK-c4410e',
  KIE_WEBHOOK_SECRET: 'kie-hook-DO-NOT-LEAK-9b2271',
  REVENUECAT_WEBHOOK_AUTH: 'rc-auth-DO-NOT-LEAK-0e6f13',
  PUBLIC_BASE_URL: 'https://api.test.example',
  ADMIN_EMAILS: 'boss@test.example',
}

let stack
let routes
let admin

before(async () => {
  stack = await startStack({ env: SECRETS })
  const { createApp } = await stack.load('server/index.js')
  routes = listRoutes(createApp())
})
after(async () => { await stack?.stop() })
beforeEach(async () => {
  await stack.reset()
  admin = await stack.createUser({ email: 'boss@test.example', role: 'admin' })
})

function listRoutes(app) {
  const layers = (app.router || app._router).stack
  const found = []
  for (const layer of layers) {
    if (!layer.route) continue
    const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]).map(m => m.toUpperCase())
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]
    for (const path of paths) if (typeof path === 'string') for (const method of methods) found.push({ method, path })
  }
  return found
}

const get = (path, who = admin) => stack.api('GET', path, { token: who?.token })
const post = (path, body, who = admin) => stack.api('POST', path, { token: who?.token, body })
const auditRows = () => stack.sql('select admin_id, admin_email, action, target_type, target_id, details from admin_audit_log order by id')

async function fixture() {
  const mia = await stack.createUser({ email: 'mia@test.example' })
  const asset = await stack.putAsset({ userId: mia.id, bytes: jpeg('IMG-OK'), moderationStatus: 'clear' })
  const influencer = await stack.one(`insert into influencers (user_id, name) values ($1, 'Mia') returning id`, [mia.id])
  await stack.sql(`insert into generations (user_id, influencer_id, asset_id, kind, label) values ($1, $2, $3, 'image', 'x')`, [mia.id, influencer.id, asset.id])
  await stack.sql(`insert into generation_jobs (user_id, influencer_id, kie_task_id, kind, label, model, state, kie_credits) values ($1, $2, 'sec-task-1', 'image', 'x', 'nano-banana-pro', 'success', 12)`, [mia.id, influencer.id])
  const event = await stack.one(`insert into moderation_events (user_id, source, action, asset_id, excerpt) values ($1, 'image', 'review', $2, 'an excerpt') returning id`, [mia.id, asset.id])
  await stack.sql(`insert into credit_ledger (user_id, kind, delta, ref, note) values ($1, 'grant', 25, 'sec:1', 'welcome')`, [mia.id])
  await stack.sql(`insert into billing_events (id, type, product_id, environment, transaction_id, outcome, user_id, credits) values ('evt-sec-1', 'NON_RENEWING_PURCHASE', 'credits_500', 'PRODUCTION', 'GPA.1', 'credited', $1, 500)`, [mia.id])
  await stack.sql(`insert into model_prices (model, label, unit, credits, enabled, updated_by) values ('nano-banana-pro', 'Image', 'per_image', 5, true, $1)`, [admin.id])
  return { mia, asset, influencer: influencer.id, event: event.id }
}

// ═════════════════════════ Every change is in the audit log ═══════════════════

test('every admin action that changes something is audited — and a write route nobody listed here fails this test', async () => {
  const f = await fixture()
  const victim = await stack.createUser({ email: 'victim@test.example' })
  const sleeper = await stack.createUser({ email: 'sleeper@test.example', status: 'suspended' })
  const promoted = await stack.createUser({ email: 'promoted@test.example' })
  const doomed = await stack.createUser({ email: 'doomed@test.example' })

  // method path → [a request that succeeds, the audit action it must leave]
  const WRITES = {
    'POST /api/admin/users/suspend': [() => ({ userId: victim.id, reason: 'testing the log' }), 'user.suspend'],
    'POST /api/admin/users/unsuspend': [() => ({ userId: sleeper.id }), 'user.unsuspend'],
    'POST /api/admin/users/set-role': [() => ({ userId: promoted.id, role: 'admin' }), 'user.set-role'],
    'POST /api/admin/users/delete': [() => ({ userId: doomed.id, confirmEmail: doomed.email }), 'user.delete'],
    'POST /api/admin/moderation/resolve': [() => ({ eventId: f.event, resolution: 'dismiss', note: 'fine' }), 'moderation.dismiss'],
    'POST /api/admin/prices/upsert': [() => ({ model: 'sec-model', unit: 'per_image', credits: 3, enabled: true }), 'price.upsert'],
    'POST /api/admin/prices/delete': [() => ({ model: 'nano-banana-pro' }), 'price.delete'],
    'POST /api/admin/billing/grant': [() => ({ userId: f.mia.id, credits: 10, note: 'a gift' }), 'billing.grant'],
  }
  // Reads that are themselves audited, because looking at someone's file is an act.
  const AUDITED_READS = {
    'GET /api/admin/moderation/media': [() => `?eventId=${f.event}`, 'moderation.view-media'],
  }

  const adminWrites = routes.filter(r => r.path.startsWith('/api/admin/') && r.method === 'POST').map(r => `${r.method} ${r.path}`)
  assert.deepEqual(adminWrites.filter(key => !WRITES[key]).sort(), [], 'these admin write routes are not covered by the audit test — add them to WRITES')
  assert.deepEqual(Object.keys(WRITES).filter(key => !adminWrites.includes(key)), [], 'WRITES names a route that no longer exists')

  for (const [key, [makeBody, action]] of Object.entries(WRITES)) {
    const path = key.split(' ')[1]
    const before = (await auditRows()).length
    const res = await post(path, makeBody())
    assert.ok(res.status >= 200 && res.status < 300, `${key} → ${res.status} ${res.text.slice(0, 100)}`)
    const added = (await auditRows()).slice(before)
    assert.equal(added.length, 1, `${key} left ${added.length} audit entries`)
    assert.equal(added[0].action, action, key)
    assert.equal(added[0].admin_id, admin.id, `${key}: the entry names who did it`)
    assert.equal(added[0].admin_email, admin.email, key)
  }
  for (const [key, [query, action]] of Object.entries(AUDITED_READS)) {
    const before = (await auditRows()).length
    const res = await get(`${key.split(' ')[1]}${query()}`)
    assert.equal(res.status, 200, `${key} → ${res.status}`)
    const added = (await auditRows()).slice(before)
    assert.deepEqual(added.map(a => a.action), [action], key)
  }
})

test('a refused admin action — wrong person, wrong password, wrong kind of account — leaves nothing in the log and changes nothing', async () => {
  const other = await stack.createUser({ email: 'other-admin@test.example', role: 'admin' })
  const user = await stack.createUser({ email: 'user@test.example' })
  const stranger = await stack.createUser({ email: 'stranger@test.example' })   // an ordinary account trying admin routes
  const before = await stack.sql('select id, email, role, status, password_hash from users order by id')

  const refused = [
    ['suspend another admin', () => post('/api/admin/users/suspend', { userId: other.id, reason: 'x' })],
    ['suspend yourself', () => post('/api/admin/users/suspend', { userId: admin.id, reason: 'x' })],
    ['delete another admin', () => post('/api/admin/users/delete', { userId: other.id, confirmEmail: other.email })],
    ['delete yourself', () => post('/api/admin/users/delete', { userId: admin.id, confirmEmail: admin.email })],
    ['change your own role', () => post('/api/admin/users/set-role', { userId: admin.id, role: 'user' })],
    ['delete without the email', () => post('/api/admin/users/delete', { userId: user.id })],
    ['delete with the wrong email', () => post('/api/admin/users/delete', { userId: user.id, confirmEmail: 'nope@test.example' })],
    ['suspend without a reason', () => post('/api/admin/users/suspend', { userId: user.id })],
    ['grant to nobody', () => post('/api/admin/billing/grant', { userId: '00000000-0000-4000-8000-000000000000', credits: 5, note: 'x' })],
    ['grant zero', () => post('/api/admin/billing/grant', { userId: user.id, credits: 0, note: 'x' })],
    ['grant without a note', () => post('/api/admin/billing/grant', { userId: user.id, credits: 5 })],
    ['grant a billion', () => post('/api/admin/billing/grant', { userId: user.id, credits: 1e9, note: 'x' })],
    ['price a model negatively', () => post('/api/admin/prices/upsert', { model: 'm', unit: 'per_image', credits: -1, enabled: true })],
    ['an ordinary account suspending', () => post('/api/admin/users/suspend', { userId: user.id, reason: 'x' }, stranger)],
    ['an ordinary account promoting itself', () => post('/api/admin/users/set-role', { userId: stranger.id, role: 'admin' }, stranger)],
    ['an ordinary account granting itself credits', () => post('/api/admin/billing/grant', { userId: stranger.id, credits: 999, note: 'x' }, stranger)],
    ['nobody at all', () => post('/api/admin/users/set-role', { userId: user.id, role: 'admin' }, null)],
  ]
  for (const [what, act] of refused) {
    const res = await act()
    assert.ok(res.status >= 400 && res.status < 500, `${what} → ${res.status}`)
  }
  assert.deepEqual(await auditRows(), [], 'nothing refused was logged as done')
  assert.deepEqual(await stack.sql('select id, email, role, status, password_hash from users order by id'), before, 'and no account changed')
  assert.equal((await stack.sql(`select count(*)::int as n from credit_ledger`))[0].n, 0, 'and no credits moved')
})

// ═════════════════════════ Roles are exact; extra fields change nothing ═══════

test('a role is exactly "admin" or "user": every other spelling or shape is refused, and extra fields in the body change nothing', async () => {
  const target = await stack.createUser({ email: 'target@test.example' })
  const snapshot = () => stack.one('select id, email, role, status, display_name, password_hash, email_confirmed_at from users where id = $1', [target.id])
  const before = await snapshot()

  for (const role of ['Admin', 'ADMIN', ' admin', 'admin ', 'admin\n', 'administrator', 'root', 'superadmin', 'owner', 'moderator', 'staff', '', null, undefined, true, 1, ['admin'], { role: 'admin' }, { toString: 'admin' }]) {
    const res = await post('/api/admin/users/set-role', { userId: target.id, role })
    assert.equal(res.status, 400, `role ${JSON.stringify(role)} → ${res.status}`)
    assert.equal(res.body.code, 'BAD_REQUEST')
  }
  assert.deepEqual(await snapshot(), before)

  // The real thing, with a body full of things it must not obey.
  const res = await post('/api/admin/users/set-role', {
    userId: target.id, role: 'admin',
    status: 'suspended', email: 'changed@test.example', password: 'new-password-1', password_hash: 'x', display_name: 'Changed', email_confirmed_at: null,
    id: admin.id, scope: 'app', is_admin: false, __proto__: { role: 'user' },
  })
  assert.equal(res.status, 200)
  const after = await snapshot()
  assert.equal(after.role, 'admin')
  assert.deepEqual({ ...after, role: before.role }, before, 'only the role changed')

  // And the same for suspending: a reason, and nothing else is read.
  await post('/api/admin/users/set-role', { userId: target.id, role: 'user' })
  const suspended = await post('/api/admin/users/suspend', { userId: target.id, reason: 'because', role: 'admin', email: 'x@test.example', password_hash: 'x' })
  assert.equal(suspended.status, 200)
  const now = await snapshot()
  assert.equal(now.status, 'suspended')
  assert.deepEqual({ ...now, status: before.status }, before)
})

test('promoting an account moves it from the app to the panel, and demoting moves it back — at the next request, never later', async () => {
  const u = await stack.createUser({ email: 'mover@test.example' })
  assert.equal((await get('/api/billing/me', u)).status, 200, 'an ordinary account uses the app')
  assert.equal((await get('/api/admin/stats', u)).status, 403)

  await post('/api/admin/users/set-role', { userId: u.id, role: 'admin' })
  assert.equal((await get('/api/billing/me', u)).status, 401, 'its app session stops working at once')
  assert.equal((await get('/api/admin/stats', u)).status, 401, 'and is not an admin session either — it must sign in to the panel')

  const login = await stack.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password, scope: 'admin' } })
  assert.equal(login.status, 200)
  const panel = login.body.session.accessToken
  assert.equal((await stack.api('GET', '/api/admin/stats', { token: panel })).status, 200)
  assert.equal((await stack.api('GET', '/api/billing/me', { token: panel })).status, 401, 'a panel session is never an app session')

  await post('/api/admin/users/set-role', { userId: u.id, role: 'user' })
  assert.equal((await stack.api('GET', '/api/admin/stats', { token: panel })).status, 401, 'the panel session dies with the role')
  assert.equal((await stack.api('POST', '/api/auth/refresh', { body: { refreshToken: login.body.session.refreshToken } })).status, 401, 'and cannot be renewed')
  assert.equal((await stack.sql('select count(*)::int as n from sessions where user_id = $1', [u.id]))[0].n, 0, 'nothing of it is left')
  assert.equal((await stack.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } })).status, 200, 'and the account is an app account again')
})

test('a role changed behind the API\'s back (a database edit) is honoured on the very next call all the same', async () => {
  const u = await stack.createUser({ email: 'direct@test.example' })
  assert.equal((await get('/api/billing/me', u)).status, 200)
  await stack.sql(`update users set role = 'admin' where id = $1`, [u.id])
  assert.equal((await get('/api/billing/me', u)).status, 401)
  assert.equal((await get('/api/admin/stats', u)).status, 401)

  const login = await stack.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password, scope: 'admin' } })
  const panel = { token: login.body.session.accessToken }
  assert.equal((await get('/api/admin/stats', panel)).status, 200)
  await stack.sql(`update users set role = 'user' where id = $1`, [u.id])
  assert.ok([401, 403].includes((await get('/api/admin/stats', panel)).status), 'the panel session is no way in')
  assert.equal((await get('/api/billing/me', panel)).status, 401, 'nor is it an app session')
  assert.equal((await get('/api/auth/me', panel)).status, 401, 'nor may it use the profile endpoints any more')
})

// ═════════════════════════ Nothing secret is ever sent ════════════════════════

test('no answer from any endpoint — app, panel or public — contains a password hash, a token, a token\'s hash or a key the server holds', async () => {
  const f = await fixture()
  const other = await stack.createUser({ email: 'other@test.example' })
  await stack.sql(`insert into email_tokens (user_id, purpose, token_hash, expires_at) values ($1, 'reset_password', 'EMAIL-TOKEN-HASH-DO-NOT-LEAK', now() + interval '1 hour')`, [f.mia.id])

  // Everything that would be a leak if it appeared anywhere.
  const forbidden = new Set(Object.values(SECRETS).filter(v => v.includes('DO-NOT-LEAK')))
  forbidden.add('EMAIL-TOKEN-HASH-DO-NOT-LEAK')
  for (const row of await stack.sql('select password_hash from users')) forbidden.add(row.password_hash)
  for (const row of await stack.sql('select access_hash, refresh_hash, previous_refresh_hash from sessions')) for (const h of Object.values(row)) if (h) forbidden.add(h)
  for (const u of [admin, f.mia, other]) { forbidden.add(u.token); forbidden.add(u.refreshToken) }
  const marks = [...forbidden].filter(Boolean)
  assert.ok(marks.length >= 14)

  const leaks = []
  const scan = (label, res) => {
    for (const mark of marks) if (res.text.includes(mark)) leaks.push(`${label} → contains ${mark.slice(0, 18)}…`)
    if (/\$argon2/.test(res.text)) leaks.push(`${label} → contains an argon2 hash`)
    if (/DATABASE_URL|postgres:\/\//.test(res.text)) leaks.push(`${label} → mentions the database url`)
  }

  const params = { assetId: f.asset.id, influencerId: f.influencer, userId: f.mia.id, eventId: f.event, taskId: 'sec-task-1', model: 'nano-banana-pro' }
  const qs = path => (/(by-asset)$/.test(path) ? `?assetId=${params.assetId}`
    : /(by-influencer|active-count|studio-settings|creation-params)$/.test(path) ? `?influencerId=${params.influencerId}`
    : /(users\/detail|billing\/ledger)$/.test(path) ? `?userId=${params.userId}`
    : /moderation\/(media|item)$/.test(path) ? `?eventId=${params.eventId}`
    : /jobs\/(by-task|sync)$/.test(path) ? `?taskId=${params.taskId}` : '')

  for (const { method, path } of routes.filter(r => r.method === 'GET')) {
    if (path === '/health' || path.startsWith('/admin') || path.startsWith('/auth/') || path === '/api/kie') continue
    const url = `${path}${qs(path)}`
    if (path.startsWith('/api/admin/')) scan(`GET ${url} as admin`, await get(url, admin))
    else scan(`GET ${url} as mia`, await get(url, f.mia))
  }
  // The things people send: the sign-in answer is allowed to carry the caller's OWN tokens and no one else's.
  const signedIn = await stack.api('POST', '/api/auth/login', { body: { email: other.email, password: other.password } })
  assert.equal(signedIn.status, 200)
  for (const mark of marks.filter(m => m !== signedIn.body.session.accessToken)) assert.ok(!signedIn.text.includes(mark), 'sign-in carried a secret')
  const me = await get('/api/auth/me', f.mia)
  scan('GET /api/auth/me', me)
  for (const [label, res] of [
    ['an unknown route', await get('/api/does-not-exist', f.mia)],
    ['a malformed body', await stack.api('POST', '/api/influencers/create', { token: f.mia.token, body: { record: 5 } })],
    ['a failing action', await post('/api/admin/users/suspend', { userId: 'nope', reason: 'x' })],
    ['the admin config page', await get('/api/admin/config')],
    ['the admin stats', await get('/api/admin/stats')],
    ['the audit log', await get('/api/admin/audit')],
  ]) scan(label, res)

  assert.deepEqual(leaks, [])
})

test('the configuration page says what is set up, not what it is set to', async () => {
  const res = await get('/api/admin/config')
  assert.equal(res.status, 200)
  const text = JSON.stringify(res.body)
  for (const value of Object.values(SECRETS)) {
    if (value.startsWith('https://') || value.includes('@')) continue   // the public address and admin email are not secrets
    assert.ok(!text.includes(value), `the configuration page shows ${value.slice(0, 12)}…`)
  }
  assert.ok(!/AKIA[A-Z0-9]{12,}/.test(text), 'nor an AWS access key id')
})
