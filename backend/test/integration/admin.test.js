// The admin panel's API: who may use it, what each action does, and what it leaves behind.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { startStack, jpeg } from '../helpers/stack.js'
import { PANEL_FILES, adminUiDir, adminUiAvailable } from '../../api/admin/ui.js'

// The panel is its own folder (admin-panel/, beside backend/). A checkout without it can still run
// everything else, so the tests that read it say why they were skipped instead of failing on a path.
const UI_DIR = adminUiDir()
const PANEL_PRESENT = adminUiAvailable()
const panelTest = (name, fn) => test(name, { skip: PANEL_PRESENT ? false : 'admin-panel/ is not checked out' }, fn)

/** Every file under dir, as paths relative to it with forward slashes. */
function walk(dir, base = dir) {
  return readdirSync(dir).filter(name => name !== 'node_modules').flatMap(name => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full).split(sep).join('/')]
  })
}

let stack
let admin
const realFetch = globalThis.fetch

before(async () => {
  stack = await startStack()
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://tempfile.aiquickdraw.com/')) {
      const body = jpeg(url.includes('bad') ? 'IMG-EXPLICIT' : 'IMG-OK')
      return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) } })
    }
    return realFetch(input, init)
  }
})
after(async () => { globalThis.fetch = realFetch; await stack?.stop() })
beforeEach(async () => {
  await stack.reset()
  admin = await stack.createUser({ email: 'boss@test.example', role: 'admin' })
})

const get = (path, who = admin) => stack.api('GET', path, { token: who?.token })
const post = (path, body, who = admin) => stack.api('POST', path, { token: who?.token, body })
const auditActions = () => stack.sql('select action, target_type, target_id, details, admin_email from admin_audit_log order by id').then(r => r.map(x => x.action))

let n = 0
async function makeJob(user, { state = 'success', model = 'kling-3.0/video', credits = null, kind = 'video', failMsg = null } = {}) {
  return stack.one(
    `insert into generation_jobs (user_id, kie_task_id, kind, label, model, state, fail_msg, kie_credits, completed_at)
     values ($1, $2, $3, 'Video', $4, $5, $6, $7, case when $5 in ('success', 'fail') then now() end) returning *`,
    [user.id, `job-${++n}`, kind, model, state, failMsg, credits],
  )
}
const influencerFor = async user => (await stack.one(`insert into influencers (user_id, name) values ($1, 'Mia') returning id`, [user.id])).id

// ── Who may come in ──────────────────────────────────────────────────────────

const READS = [
  '/api/admin/stats', '/api/admin/usage', '/api/admin/audit', '/api/admin/config', '/api/admin/users',
  '/api/admin/jobs', '/api/admin/moderation', '/api/admin/prices',
]
const WRITES = [
  '/api/admin/users/suspend', '/api/admin/users/unsuspend', '/api/admin/users/set-role', '/api/admin/users/delete',
  '/api/admin/moderation/resolve', '/api/admin/prices/upsert', '/api/admin/prices/delete', '/api/admin/billing/grant',
]

test('every admin route needs a session, then an administrator', async () => {
  const user = await stack.createUser()
  for (const path of READS) {
    assert.equal((await get(path, null)).status, 401, `${path} with no session`)
    const asUser = await get(path, user)
    assert.equal(asUser.status, 403, `${path} as a user`)
    assert.equal(asUser.body.code, 'NOT_ADMIN')
    assert.equal((await get(path)).status, 200, `${path} as an admin`)
  }
  assert.equal((await get('/api/admin/moderation/media?eventId=x', null)).status, 401)
  assert.equal((await get('/api/admin/moderation/media?eventId=x', user)).status, 403)
  // The ledger needs an account to read, so it cannot be in the list above (an empty query is a 400 even for an admin).
  assert.equal((await get('/api/admin/billing/ledger?userId=x', null)).status, 401)
  assert.equal((await get('/api/admin/billing/ledger?userId=x', user)).status, 403)
  for (const path of WRITES) {
    assert.equal((await post(path, {}, null)).status, 401, `${path} with no session`)
    assert.equal((await post(path, {}, user)).status, 403, `${path} as a user`)
    assert.equal((await post(path, {})).status, 400, `${path} as an admin, with an empty body, is a validation error — not a crash`)
  }
})

test('a garbage token is a 401, never a 500', async () => {
  for (const token of ['nope', 'x'.repeat(500), '', 'Bearer']) {
    assert.equal((await stack.api('GET', '/api/admin/stats', { token })).status, 401)
  }
})

test('the role is read on every request: a demoted admin is out immediately', async () => {
  assert.equal((await get('/api/admin/stats')).status, 200)
  await stack.sql(`update users set role = 'user' where id = $1`, [admin.id])
  assert.equal((await get('/api/admin/stats')).status, 403)
})

test('a suspended admin is out too', async () => {
  await stack.sql(`update users set status = 'suspended' where id = $1`, [admin.id])
  const res = await get('/api/admin/stats')
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'ACCOUNT_SUSPENDED')
})

// ── Users ────────────────────────────────────────────────────────────────────

test('the user list carries counts, and never a password hash', async () => {
  const u = await stack.createUser({ email: 'mia@test.example' })
  await makeJob(u, { credits: 20 }); await makeJob(u, { credits: 5.5 }); await makeJob(u, { state: 'fail', credits: 0 })
  await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK') })
  await stack.sql(`insert into moderation_events (user_id, source, action) values ($1, 'prompt', 'review')`, [u.id])

  const res = await get('/api/admin/users?q=mia')
  assert.equal(res.status, 200)
  assert.equal(res.body.total, 1)
  const row = res.body.users[0]
  assert.equal(row.email, 'mia@test.example')
  assert.equal(row.jobs, 3)
  assert.equal(row.kieCredits, 25.5)
  assert.equal(row.openEvents, 1)
  assert.ok(row.storageBytes > 0)
  assert.equal(row.role, 'user')
  assert.ok(!/password|hash|token/i.test(res.text), 'nothing secret in the list')
})

test('searching treats % and _ as plain characters, and is case-insensitive', async () => {
  await stack.createUser({ email: 'a_b@test.example' })
  await stack.createUser({ email: 'axb@test.example' })
  await stack.createUser({ email: 'Zed@Test.Example' })
  assert.deepEqual((await get('/api/admin/users?q=a_b')).body.users.map(u => u.email), ['a_b@test.example'])
  assert.equal((await get('/api/admin/users?q=%25')).body.total, 0, '"%" is not a wildcard')
  assert.equal((await get('/api/admin/users?q=ZED')).body.total, 1)
  assert.equal((await get('/api/admin/users?q=' + encodeURIComponent("'; drop table users; --"))).status, 200)
})

test('filtering by status, and paging, are bounded and exact', async () => {
  for (let i = 0; i < 6; i++) await stack.createUser({ status: i < 2 ? 'suspended' : 'active' })
  assert.equal((await get('/api/admin/users?status=suspended')).body.total, 2)
  assert.equal((await get('/api/admin/users?status=bogus')).body.total, 7, 'an unknown status is ignored, not an error')

  const p1 = await get('/api/admin/users?pageSize=3&page=1')
  const p3 = await get('/api/admin/users?pageSize=3&page=3')
  assert.equal(p1.body.users.length, 3)
  assert.equal(p3.body.users.length, 1)
  assert.equal(p1.body.total, 7)
  const ids = [...p1.body.users, ...(await get('/api/admin/users?pageSize=3&page=2')).body.users, ...p3.body.users].map(u => u.id)
  assert.equal(new Set(ids).size, 7, 'no account is skipped or repeated across pages')
  assert.equal((await get('/api/admin/users?pageSize=100000')).body.pageSize, 100)
})

test('suspending: needs a reason, refuses yourself and other admins, signs the user out, is audited', async () => {
  const u = await stack.createUser()
  const other = await stack.createUser({ role: 'admin' })

  assert.equal((await post('/api/admin/users/suspend', { userId: u.id })).status, 400, 'no reason')
  assert.equal((await post('/api/admin/users/suspend', { userId: u.id, reason: 'x'.repeat(301) })).status, 400)
  assert.equal((await post('/api/admin/users/suspend', { userId: 'not-a-uuid', reason: 'r' })).status, 400)
  assert.equal((await post('/api/admin/users/suspend', { userId: '00000000-0000-4000-8000-000000000000', reason: 'r' })).status, 404)
  assert.equal((await post('/api/admin/users/suspend', { userId: admin.id, reason: 'r' })).body.code, 'SELF_ACTION')
  assert.equal((await post('/api/admin/users/suspend', { userId: other.id, reason: 'r' })).body.code, 'TARGET_IS_ADMIN')

  const ok = await post('/api/admin/users/suspend', { userId: u.id, reason: 'spam' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.changed, true)
  const row = await stack.one('select status, suspended_reason, suspended_at from users where id = $1', [u.id])
  assert.equal(row.status, 'suspended')
  assert.equal(row.suspended_reason, 'By boss@test.example: spam')
  assert.ok(row.suspended_at)
  assert.equal((await get('/api/auth/me', u)).status, 401, 'signed out everywhere')
  assert.equal((await post('/api/admin/users/suspend', { userId: u.id, reason: 'again' })).body.changed, false, 'already suspended')
  assert.deepEqual((await auditActions()).filter(a => a === 'user.suspend').length, 2)
})

test('restoring lets them sign in again', async () => {
  const u = await stack.createUser()
  await post('/api/admin/users/suspend', { userId: u.id, reason: 'spam' })
  assert.equal((await stack.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } })).status, 403)

  const res = await post('/api/admin/users/unsuspend', { userId: u.id })
  assert.equal(res.body.changed, true)
  const login = await stack.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } })
  assert.equal(login.status, 200)
  const row = await stack.one('select status, suspended_at, suspended_reason from users where id = $1', [u.id])
  assert.deepEqual([row.status, row.suspended_at, row.suspended_reason], ['active', null, null])
  assert.equal((await post('/api/admin/users/unsuspend', { userId: u.id })).body.changed, false)
})

test('roles: a user is promoted and demoted at once; nobody changes their own', async () => {
  const u = await stack.createUser()
  assert.equal((await post('/api/admin/users/set-role', { userId: u.id, role: 'owner' })).status, 400)
  assert.equal((await post('/api/admin/users/set-role', { userId: admin.id, role: 'user' })).body.code, 'SELF_ACTION')

  assert.equal((await get('/api/admin/stats', u)).status, 403)
  assert.equal((await post('/api/admin/users/set-role', { userId: u.id, role: 'admin' })).body.changed, true)
  assert.equal((await get('/api/admin/stats', u)).status, 200, 'effective on their next call')

  assert.equal((await post('/api/admin/users/set-role', { userId: u.id, role: 'user' })).body.changed, true)
  assert.equal((await get('/api/admin/stats', u)).status, 403)
  assert.equal((await post('/api/admin/users/set-role', { userId: u.id, role: 'user' })).body.changed, false, 'no-op')

  const log = await stack.sql(`select details from admin_audit_log where action = 'user.set-role' order by id`)
  assert.deepEqual(log.map(l => [l.details.from, l.details.to]), [['user', 'admin'], ['admin', 'user'], ['user', 'user']])
})

test('deleting an account: the email must be typed, admins and yourself are refused, and every file goes', async () => {
  const victim = await stack.createUser({ email: 'gone@test.example' })
  const bystander = await stack.createUser()
  const mine = await stack.putAsset({ userId: victim.id, bytes: jpeg('IMG-OK') })
  const theirs = await stack.putAsset({ userId: bystander.id, bytes: jpeg('IMG-OK') })
  const peer = await stack.createUser({ role: 'admin' })

  assert.equal((await post('/api/admin/users/delete', { userId: victim.id })).body.code, 'CONFIRMATION_MISMATCH')
  assert.equal((await post('/api/admin/users/delete', { userId: victim.id, confirmEmail: 'someone@else.example' })).status, 400)
  assert.equal((await post('/api/admin/users/delete', { userId: admin.id, confirmEmail: admin.email })).body.code, 'SELF_ACTION')
  assert.equal((await post('/api/admin/users/delete', { userId: peer.id, confirmEmail: peer.email })).body.code, 'TARGET_IS_ADMIN')
  assert.ok(stack.s3.objects.has(mine.key), 'nothing was touched by the refusals')

  const res = await post('/api/admin/users/delete', { userId: victim.id, confirmEmail: '  GONE@test.example ' })
  assert.equal(res.status, 200)
  assert.equal(res.body.deletedObjects, 1)
  assert.equal(await stack.one('select 1 from users where id = $1', [victim.id]), null)
  assert.equal(stack.s3.objects.has(mine.key), false)
  assert.equal(stack.s3.objects.has(theirs.key), true, 'someone else\'s files are untouched')
  assert.equal((await get('/api/auth/me', victim)).status, 401)
  const entry = (await stack.sql(`select details from admin_audit_log where action = 'user.delete'`))[0]
  assert.equal(entry.details.email, 'gone@test.example')
})

// ── Jobs ─────────────────────────────────────────────────────────────────────

test('the jobs list filters, shows what KIE charged, and tells unknown from zero', async () => {
  const a = await stack.createUser({ email: 'aa@test.example' })
  const b = await stack.createUser({ email: 'bb@test.example' })
  const first = await makeJob(a, { credits: 27, model: 'kling-3.0/video' })
  await makeJob(a, { state: 'fail', credits: 0, model: 'veo-3-1', failMsg: 'flagged' })
  await makeJob(b, { credits: null, model: 'kling-3.0/video' })
  await makeJob(b, { state: 'generating', model: 'veo-3-1' })

  const all = await get('/api/admin/jobs')
  assert.equal(all.body.total, 4)
  assert.equal(all.body.jobs.find(j => j.failMessage === 'flagged').kieCredits, 0)
  assert.equal(all.body.jobs.filter(j => j.kieCredits === null).length, 2)

  assert.equal((await get('/api/admin/jobs?state=fail')).body.total, 1)
  assert.equal((await get('/api/admin/jobs?model=veo-3-1')).body.total, 2)
  assert.equal((await get(`/api/admin/jobs?userId=${b.id}`)).body.total, 2)
  assert.equal((await get('/api/admin/jobs?q=bb@')).body.total, 2)
  const byTask = await get(`/api/admin/jobs?q=${first.kie_task_id}`)
  assert.deepEqual(byTask.body.jobs.map(j => j.taskId), [first.kie_task_id], 'by task id')
  assert.equal((await get('/api/admin/jobs?state=bogus')).status, 400)
  assert.equal((await get('/api/admin/jobs?userId=bogus')).status, 400)
})

// ── The moderation queue ─────────────────────────────────────────────────────

async function eventFor(user, extra = {}) {
  const { source = 'prompt', action = 'blocked', assetId = null, excerpt = 'some text' } = extra
  return stack.one(
    `insert into moderation_events (user_id, source, action, categories, scores, excerpt, asset_id)
     values ($1, $2, $3, '{sexual}', '{"sexual":0.9}', $4, $5) returning id`,
    [user.id, source, action, excerpt, assetId],
  )
}

/** A result the checker blocked on its way into a gallery, the way collect leaves it. */
async function quarantinedResult(user, influencerId) {
  const url = 'https://tempfile.aiquickdraw.com/results/bad-one.jpg'
  const job = await stack.one(
    `insert into generation_jobs (user_id, influencer_id, kie_task_id, kind, label, model, state, result_url)
     values ($1, $2, $3, 'image', 'Image', 'nano-banana-pro', 'success', $4) returning *`,
    [user.id, influencerId, `q-${++n}`, url],
  )
  const { collect } = await stack.load('api/_lib/collect.js')
  await collect(job, '[test]')
  const { asset_id: assetId } = await stack.one('select asset_id from generation_jobs where id = $1', [job.id])
  const { id: eventId } = await stack.one('select id from moderation_events where asset_id = $1', [assetId])
  return { jobId: job.id, assetId, eventId }
}

test('the queue shows open items by default, newest first, with the file they point at', async () => {
  const u = await stack.createUser({ email: 'mia@test.example' })
  const img = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK') })
  const open = await eventFor(u, { source: 'image', assetId: img.id })
  const done = await eventFor(u)
  await stack.sql(`update moderation_events set status = 'dismissed' where id = $1`, [done.id])

  const res = await get('/api/admin/moderation')
  assert.equal(res.body.total, 1)
  const e = res.body.events[0]
  assert.equal(e.id, open.id)
  assert.equal(e.email, 'mia@test.example')
  assert.equal(e.assetKind, 'image')
  assert.equal(e.assetStatus, 'unchecked')
  assert.deepEqual(e.categories, ['sexual'])
  assert.equal(e.scores.sexual, 0.9)

  assert.equal((await get('/api/admin/moderation?status=all')).body.total, 2)
  assert.equal((await get('/api/admin/moderation?status=dismissed')).body.total, 1)
  assert.equal((await get('/api/admin/moderation?source=image')).body.total, 1)
  assert.equal((await get('/api/admin/moderation?source=prompt')).body.total, 0, 'its only open prompt event was dismissed')
  assert.equal((await get('/api/admin/moderation?action=review')).body.total, 0)
  for (const bad of ['status=nope', 'source=nope', 'action=nope']) assert.equal((await get(`/api/admin/moderation?${bad}`)).status, 400, bad)
})

test('looking at a file gives a short-lived link, and is itself audited', async () => {
  const u = await stack.createUser()
  const img = await stack.putAsset({ userId: u.id, bytes: jpeg('IMG-OK') })
  const ev = await eventFor(u, { source: 'image', assetId: img.id })

  const res = await get(`/api/admin/moderation/media?eventId=${ev.id}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.kind, 'image')
  assert.equal(res.body.expiresIn, 120)
  const url = new URL(res.body.url)
  assert.ok(url.searchParams.has('X-Amz-Signature'))
  assert.equal(url.searchParams.get('X-Amz-Expires'), '120')
  const file = await realFetch(res.body.url)
  assert.equal(file.status, 200)

  const [entry] = await stack.sql(`select details, target_id from admin_audit_log where action = 'moderation.view-media'`)
  assert.equal(entry.target_id, img.id)
  assert.equal(entry.details.ownerId, u.id)

  const noFile = await eventFor(u)
  assert.equal((await get(`/api/admin/moderation/media?eventId=${noFile.id}`)).status, 404)
  assert.equal((await get('/api/admin/moderation/media?eventId=nope')).status, 400)
})

test('dismissing a refusal withdraws the strike', async () => {
  const u = await stack.createUser()
  const ev = await eventFor(u)
  const { countStrikes } = await stack.load('api/_lib/moderation/events.js')
  assert.equal(await countStrikes(u.id, 30), 1)

  const res = await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'dismiss', note: 'was a recipe' })
  assert.equal(res.status, 200)
  assert.equal(await countStrikes(u.id, 30), 0)
  const row = await stack.one('select status, reviewed_by, review_note, reviewed_at from moderation_events where id = $1', [ev.id])
  assert.deepEqual([row.status, row.reviewed_by, row.review_note], ['dismissed', admin.id, 'was a recipe'])
  assert.ok(row.reviewed_at)
})

test('dismissing a quarantined result gives it back: clear, in the gallery, job a success again', async () => {
  const u = await stack.createUser()
  const inf = await influencerFor(u)
  const { jobId, assetId, eventId } = await quarantinedResult(u, inf)
  assert.equal((await stack.sql('select 1 from generations where user_id = $1', [u.id])).length, 0)
  assert.equal((await stack.one('select state from generation_jobs where id = $1', [jobId])).state, 'fail')

  const res = await post('/api/admin/moderation/resolve', { eventId, resolution: 'dismiss' })
  assert.equal(res.body.restored, true)
  assert.equal((await stack.one('select moderation_status from assets where id = $1', [assetId])).moderation_status, 'clear')
  assert.deepEqual((await stack.sql('select asset_id from generations where user_id = $1', [u.id])).map(g => g.asset_id), [assetId])
  const job = await stack.one('select state, fail_msg from generation_jobs where id = $1', [jobId])
  assert.deepEqual([job.state, job.fail_msg], ['success', null])

  const urls = await stack.api('POST', '/api/storage/download-url', { token: u.token, body: { assetIds: [assetId] } })
  assert.deepEqual(Object.keys(urls.body.urls), [assetId], 'handed out again')
})

test('confirming a blocked result can delete the file and suspend its owner', async () => {
  const u = await stack.createUser()
  const inf = await influencerFor(u)
  const { jobId, assetId, eventId } = await quarantinedResult(u, inf)
  const key = (await stack.one('select s3_key from assets where id = $1', [assetId])).s3_key
  assert.ok(stack.s3.objects.has(key))

  const res = await post('/api/admin/moderation/resolve', { eventId, resolution: 'confirm', deleteContent: true, suspendUser: true })
  assert.equal(res.status, 200)
  assert.equal(res.body.deleted, true)
  assert.equal(res.body.suspended, true)
  assert.equal(stack.s3.objects.has(key), false, 'gone from storage')
  assert.equal(await stack.one('select 1 from assets where id = $1', [assetId]), null)
  assert.equal((await stack.one('select asset_id from generation_jobs where id = $1', [jobId])).asset_id, null)
  assert.equal((await stack.one('select status from users where id = $1', [u.id])).status, 'suspended')
})

test('confirming something that was let through for review blocks it and takes it down', async () => {
  const u = await stack.createUser()
  const inf = await influencerFor(u)
  const asset = await stack.putAsset({ userId: u.id, origin: 'generated', influencerId: inf, bytes: jpeg('IMG-OK'), moderationStatus: 'clear' })
  await stack.sql(`insert into generations (user_id, influencer_id, asset_id, kind, label) values ($1, $2, $3, 'image', 'x')`, [u.id, inf, asset.id])
  const job = await stack.one(
    `insert into generation_jobs (user_id, kie_task_id, kind, label, state, asset_id) values ($1, 'rv-1', 'image', 'x', 'success', $2) returning id`, [u.id, asset.id])
  const ev = await eventFor(u, { source: 'output', action: 'review', assetId: asset.id })

  const res = await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'confirm' })
  assert.equal(res.body.blocked, true)
  assert.equal((await stack.one('select moderation_status from assets where id = $1', [asset.id])).moderation_status, 'blocked')
  assert.equal((await stack.sql('select 1 from generations where user_id = $1', [u.id])).length, 0)
  assert.equal((await stack.one('select state from generation_jobs where id = $1', [job.id])).state, 'fail')
  assert.equal(stack.s3.objects.has(asset.key), true, 'quarantined, not deleted, unless asked')
  assert.equal((await stack.one('select status from users where id = $1', [u.id])).status, 'active')
})

test('an admin can be the subject of an event, and is never suspended by confirming it', async () => {
  const peer = await stack.createUser({ role: 'admin' })
  const ev = await eventFor(peer)
  const res = await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'confirm', suspendUser: true })
  assert.equal(res.body.suspended, false)
  assert.equal((await stack.one('select status from users where id = $1', [peer.id])).status, 'active')
})

test('resolving: bad requests are refused, and an event can be decided only once', async () => {
  const u = await stack.createUser()
  const ev = await eventFor(u)
  assert.equal((await post('/api/admin/moderation/resolve', { eventId: 'nope', resolution: 'dismiss' })).status, 400)
  assert.equal((await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'maybe' })).status, 400)
  assert.equal((await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'dismiss', deleteContent: true })).status, 400)
  assert.equal((await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'dismiss', suspendUser: true })).status, 400)
  assert.equal((await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'dismiss', note: 'x'.repeat(501) })).status, 400)
  assert.equal((await stack.one('select status from moderation_events where id = $1', [ev.id])).status, 'open', 'refusals changed nothing')

  assert.equal((await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'dismiss' })).status, 200)
  const again = await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'confirm' })
  assert.equal(again.status, 409)
  assert.equal(again.body.code, 'ALREADY_REVIEWED')
  assert.equal((await post('/api/admin/moderation/resolve', { eventId: '00000000-0000-4000-8000-000000000000', resolution: 'dismiss' })).status, 409)
})

test('two admins deciding the same event at once: exactly one wins', async () => {
  const peer = await stack.createUser({ role: 'admin' })
  const u = await stack.createUser()
  const ev = await eventFor(u)
  const out = await Promise.all([
    post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'dismiss' }, admin),
    post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'confirm' }, peer),
  ])
  assert.deepEqual(out.map(r => r.status).sort(), [200, 409])
})

// ── Prices ───────────────────────────────────────────────────────────────────

test('prices: saved, updated in place, listed, deleted — each one audited', async () => {
  const body = { model: 'kling-3.0/video', unit: 'per_second', credits: 20, enabled: true, label: 'Kling 3.0', note: 'cost + margin' }
  const saved = await post('/api/admin/prices/upsert', body)
  assert.equal(saved.status, 200)
  assert.equal(saved.body.price.credits, 20)
  assert.equal(saved.body.price.updatedBy, 'boss@test.example')

  await post('/api/admin/prices/upsert', { ...body, credits: 22.125, enabled: false })
  const list = await get('/api/admin/prices')
  assert.equal(list.body.prices.length, 1, 'same model: updated, not duplicated')
  assert.equal(list.body.prices[0].credits, 22.125)
  assert.equal(list.body.prices[0].enabled, false)
  assert.deepEqual(list.body.units, ['per_second', 'per_video', 'per_image'])

  assert.equal((await post('/api/admin/prices/delete', { model: 'kling-3.0/video' })).status, 200)
  assert.equal((await post('/api/admin/prices/delete', { model: 'kling-3.0/video' })).status, 404)
  assert.deepEqual(await auditActions(), ['price.upsert', 'price.upsert', 'price.delete'])
})

test('prices: every bad field is refused, and nothing is saved', async () => {
  const good = { model: 'veo-3-1', unit: 'per_video', credits: 65, enabled: true }
  const bad = [
    { model: '' }, { model: 'has space' }, { model: 'semi;colon' }, { model: '.leading' }, { model: 'x'.repeat(201) }, { model: 5 },
    { unit: 'per_century' }, { unit: undefined },
    { credits: -1 }, { credits: '20' }, { credits: null }, { credits: 1e12 }, { credits: Number.NaN },
    { enabled: 'yes' }, { enabled: undefined },
    { label: 'x'.repeat(121) }, { note: 'x'.repeat(301) }, { label: 5 },
  ]
  for (const patch of bad) {
    const res = await post('/api/admin/prices/upsert', { ...good, ...patch })
    assert.equal(res.status, 400, JSON.stringify(patch))
  }
  assert.equal((await get('/api/admin/prices')).body.prices.length, 0)
  assert.equal((await post('/api/admin/prices/upsert', good)).status, 200)
})

test('the price list names models in use that have no price', async () => {
  const u = await stack.createUser()
  await makeJob(u, { model: 'kling-3.0/video', credits: 20 }); await makeJob(u, { model: 'kling-3.0/video', credits: 30 })
  await makeJob(u, { model: 'veo-3-1', credits: 65 })
  await post('/api/admin/prices/upsert', { model: 'veo-3-1', unit: 'per_video', credits: 70, enabled: true })

  const { unpriced } = (await get('/api/admin/prices')).body
  assert.deepEqual(unpriced, [{ model: 'kling-3.0/video', jobs: 2, kieCredits: 50, kind: 'video' }])
})

// ── Overview ─────────────────────────────────────────────────────────────────

test('stats and usage add up what the jobs say', async () => {
  const u = await stack.createUser()
  await stack.createUser({ status: 'suspended' })
  await makeJob(u, { credits: 20, model: 'kling-3.0/video' })
  await makeJob(u, { credits: 30, model: 'kling-3.0/video' })
  await makeJob(u, { state: 'fail', credits: 0, model: 'veo-3-1' })
  await makeJob(u, { credits: null, model: 'veo-3-1' })
  await makeJob(u, { state: 'generating', model: 'veo-3-1' })
  await stack.sql(`insert into moderation_events (user_id, source, action) values ($1, 'prompt', 'blocked'), ($1, 'image', 'review')`, [u.id])

  const s = (await get('/api/admin/stats')).body
  assert.deepEqual([s.users.total, s.users.suspended], [3, 1])
  assert.equal(s.jobs.running, 1)
  assert.equal(s.jobs.started24h, 5)
  assert.equal(s.jobs.failed24h, 1)
  assert.equal(s.jobs.credits24h, 50)
  assert.equal(s.jobs.credits30d, 50)
  assert.equal(s.jobs.chargeUnknown30d, 1, 'the job KIE gave no charge for is counted, not hidden')
  assert.deepEqual([s.moderation.open, s.moderation.openBlocked], [2, 1])

  const usage = (await get('/api/admin/usage?days=7')).body
  const kling = usage.rows.find(r => r.model === 'kling-3.0/video')
  assert.deepEqual([kling.succeeded, kling.failed, kling.credits], [2, 0, 50])
  const veo = usage.rows.find(r => r.model === 'veo-3-1')
  assert.deepEqual([veo.succeeded, veo.failed, veo.credits], [1, 1, 0])
  assert.equal((await get('/api/admin/usage?days=100000')).body.days, 90)
  assert.equal((await get('/api/admin/usage?days=abc')).body.days, 30)
})

test('the audit log is newest first and pages', async () => {
  const u = await stack.createUser()
  for (let i = 0; i < 4; i++) await post('/api/admin/users/suspend', { userId: u.id, reason: `r${i}` })
  const first = (await get('/api/admin/audit?pageSize=3')).body
  assert.equal(first.total, 4)
  assert.equal(first.entries.length, 3)
  assert.equal(first.entries[0].details.reason, 'r3')
  assert.equal(first.entries[0].admin, 'boss@test.example')
  assert.equal((await get('/api/admin/audit?pageSize=3&page=2')).body.entries.length, 1)
})

test('the configuration page says how the server is set up, and never shows a secret', async () => {
  const res = await get('/api/admin/config')
  assert.equal(res.status, 200)
  assert.equal(res.body.moderation.enabled, true)
  assert.equal(res.body.moderation.checkerConfigured, true)
  assert.equal(res.body.moderation.failMode, 'closed')
  assert.equal(res.body.moderation.thresholds['sexual/minors'].block, 0.1)
  assert.equal(res.body.kie.nsfwChecker, true)
  assert.deepEqual(res.body.billing, { enforced: false, webhookConfigured: false, acceptSandbox: true }, 'credits are being watched, not charged, and no webhook secret is set in this stack')
  for (const secret of ['test-openai-key', 'test-kie-key', 'AKIATESTTESTTESTTEST', 'test-secret-test-secret', 'postgres://']) {
    assert.ok(!res.text.includes(secret), `${secret} must not appear`)
  }
})

// ── Reporting ────────────────────────────────────────────────────────────────

async function galleryEntry(user) {
  const inf = await influencerFor(user)
  const asset = await stack.putAsset({ userId: user.id, origin: 'generated', influencerId: inf, bytes: jpeg('IMG-OK'), moderationStatus: 'clear' })
  const g = await stack.one(
    `insert into generations (user_id, influencer_id, asset_id, kind, label) values ($1, $2, $3, 'image', 'x') returning id`, [user.id, inf, asset.id])
  return { generationId: g.id, assetId: asset.id }
}
const report = (user, body) => stack.api('POST', '/api/reports', { token: user.token, body })

test('a person can report a result; it reaches the queue, once, and costs them nothing', async () => {
  const u = await stack.createUser()
  const { generationId, assetId } = await galleryEntry(u)

  const first = await report(u, { generationId, reason: 'sexual', note: 'not what I asked for' })
  assert.equal(first.status, 201)
  assert.equal((await report(u, { generationId, reason: 'violence' })).status, 200, 'the same item again is not a second entry')

  const events = await stack.sql(`select source, action, categories, excerpt, asset_id, status from moderation_events where user_id = $1`, [u.id])
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { source: 'report', action: 'review', categories: ['sexual'], excerpt: 'not what I asked for', asset_id: assetId, status: 'open' })

  const { countStrikes } = await stack.load('api/_lib/moderation/events.js')
  assert.equal(await countStrikes(u.id, 30), 0)
  assert.equal((await get('/api/admin/moderation?source=report')).body.total, 1)
})

test('reporting: only your own items, only known reasons, and not unlimited', async () => {
  const u = await stack.createUser()
  const other = await stack.createUser()
  const mine = await galleryEntry(u)
  const theirs = await galleryEntry(other)

  assert.equal((await report(u, { generationId: theirs.generationId, reason: 'other' })).status, 404, 'someone else\'s item is "not found"')
  assert.equal((await report(u, { generationId: '00000000-0000-4000-8000-000000000000', reason: 'other' })).status, 404)
  assert.equal((await report(u, { generationId: 'nope', reason: 'other' })).status, 400)
  assert.equal((await report(u, { generationId: mine.generationId, reason: 'because' })).status, 400)
  assert.equal((await report(u, { generationId: mine.generationId })).status, 400)
  assert.equal((await report(u, { generationId: mine.generationId, reason: 'other', note: 'x'.repeat(301) })).status, 400)
  assert.equal((await stack.api('POST', '/api/reports', { body: { generationId: mine.generationId, reason: 'other' } })).status, 401)

  // 20 an hour.
  const statuses = []
  for (let i = 0; i < 21; i++) statuses.push((await report(u, { generationId: mine.generationId, reason: 'other' })).status)
  assert.equal(statuses.at(-1), 429)
})

// ── The page itself ──────────────────────────────────────────────────────────

panelTest('the admin page is served with a policy that forbids inline script and framing', async () => {
  const res = await realFetch(`${stack.base}/admin`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  const csp = res.headers.get('content-security-policy')
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /script-src 'self'(;|$)/)
  assert.match(csp, /style-src 'self'(;|$)/)
  assert.match(csp, /font-src 'self'(;|$)/, "the panel's own typeface, and nobody else's")
  assert.match(csp, /connect-src 'self'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'))
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const html = await res.text()
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'no inline script in the page')
  assert.ok(!/\sstyle=|\sonclick=|<style/i.test(html), 'no inline style or handlers in the page')
  assert.equal((await realFetch(`${stack.base}/admin/`)).status, 200)
})

panelTest('every panel file is served with the right type and the security headers — and the list is exactly what is on disk', async () => {
  // The folder also holds what is never served: the panel's own tests, README and package files.
  const NOT_SERVED = ['test/', 'README.md', 'package.json', 'package-lock.json', '.gitignore', 'fonts/OFL.txt']
  const onDisk = walk(UI_DIR).filter(f => !NOT_SERVED.some(n => f === n || f.startsWith(n))).sort()
  assert.deepEqual(Object.keys(PANEL_FILES).sort(), onDisk, 'a file added to admin-panel/ must be added to PANEL_FILES, and the reverse')

  // And none of those can be asked for.
  for (const f of ['/admin/README.md', '/admin/package.json', '/admin/test/api.test.js', '/admin/node_modules/happy-dom/package.json']) {
    assert.equal((await realFetch(`${stack.base}${f}`)).status, 404, f)
  }

  for (const [file, type] of Object.entries(PANEL_FILES)) {
    const url = file === 'index.html' ? '/admin' : `/admin/${file}`
    const res = await realFetch(`${stack.base}${url}`)
    assert.equal(res.status, 200, url)
    assert.equal(res.headers.get('content-type'), type, url)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url)
    // The page and its code are never cached; the typeface, which does not change, may be.
    assert.equal(res.headers.get('cache-control'), file.startsWith('fonts/') ? 'public, max-age=86400' : 'no-store', url)
    assert.equal(res.headers.get('x-frame-options'), 'DENY', url)
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/, url)
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), readFileSync(join(UI_DIR, file)), `${url} is the file on disk`)
  }
})

panelTest('nothing else is reachable under /admin, however it is spelled', async () => {
  // (A literal "/../" or "%2e%2e" segment is resolved by the HTTP client before it is sent, so those
  // spellings would arrive as an ordinary path; the encoded-slash forms below do reach the server.)
  const paths = [
    '/admin/app.js', '/admin/index.html', '/admin/secret', '/admin/lib', '/admin/lib/', '/admin/views', '/admin/views/',
    '/admin/..%2f..%2fserver%2findex.js', '/admin/%2e%2e/package.json', '/admin/lib%2f..%2f..%2f..%2fpackage.json',
    '/admin/main.js/x', '/admin/MAIN.JS', '/admin/Main.js', '/admin/lib/api.js/', '/admin//main.js', '/admin/main.js%00', '/admin/main.js%00.png',
    '/admin/views/users.js/..%2f..%2f.env', '/admin/.env', '/admin/.git/config', '/admin/%5c..%5cpackage.json',
    '/admin/main.js::$DATA', '/admin/main.js%20', '/admins', '/admin-x', '/admin%2fmain.js',
  ]
  for (const path of paths) {
    const res = await realFetch(`${stack.base}${path}`)
    assert.ok([404, 400].includes(res.status), `${path} answered ${res.status}`)
    assert.ok(!/(import |export |createApi|DATABASE_URL)/.test(await res.text()), `${path} must not leak a source file`)
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal((await realFetch(`${stack.base}/admin`, { method })).status, 404, method)
    assert.equal((await realFetch(`${stack.base}/admin/main.js`, { method })).status, 404, method)
  }
})

panelTest('a query string does not change what is served', async () => {
  const res = await realFetch(`${stack.base}/admin/main.js?x=1&y=<script>`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), PANEL_FILES['main.js'])
})

panelTest('the page loads its scripts and styles from this origin only, and each is a panel file that exists', async () => {
  const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8')
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(r => !r.startsWith('data:'))
  assert.ok(refs.length >= 2, "the stylesheet and the script")
  for (const ref of refs) {
    assert.ok(ref.startsWith('/admin/'), `${ref} is served by this origin`)
    const file = ref.slice('/admin/'.length)
    assert.ok(Object.hasOwn(PANEL_FILES, file), `${ref} is a panel file`)
    assert.equal((await realFetch(`${stack.base}${ref}`)).status, 200, ref)
  }
})

panelTest('every module the panel imports is a panel file, so nothing is requested that would 404', () => {
  for (const file of Object.keys(PANEL_FILES).filter(f => f.endsWith('.js'))) {
    const source = readFileSync(join(UI_DIR, file), 'utf8')
    for (const [, spec] of source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${file} imports ${spec}: only the panel's own files may be imported`)
      const target = relative(UI_DIR, resolve(UI_DIR, dirname(file), spec)).split(sep).join('/')
      assert.ok(Object.hasOwn(PANEL_FILES, target), `${file} imports ${spec} → ${target}, which is not in PANEL_FILES`)
    }
  }
})

panelTest('the panel scripts never insert server data as HTML, reach out anywhere but the API, or keep anything in storage', () => {
  const code = file => readFileSync(join(UI_DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // comments may name the rules they follow
    .replace(/^\s*\/\/.*$/gm, '')
  const forbidden = [
    'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'sessionStorage', 'document.cookie',
    "setAttribute('style'", 'setAttribute("style"', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'window.open', 'postMessage',
    "createElement('script')", 'createElement("script")', "createElement('iframe')", 'import(', 'importScripts', 'srcdoc',
  ]
  for (const file of Object.keys(PANEL_FILES).filter(f => f.endsWith('.js'))) {
    const source = code(file)
    for (const word of forbidden) assert.ok(!source.includes(word), `${file} must not use ${word}`)
    if (file !== 'lib/api.js') assert.ok(!/\bfetch\(/.test(source), `${file}: only lib/api.js talks to the network`)
    assert.ok(!source.includes('localStorage'), `${file} must not touch storage — the panel keeps nothing in the browser`)
  }
})

panelTest('the panel is light only and carries the app\'s name', () => {
  const css = readFileSync(join(UI_DIR, 'app.css'), 'utf8')
  assert.ok(!/prefers-color-scheme/.test(css) && !/data-theme/.test(css) && !/color-scheme:\s*dark/.test(css), 'no dark mode in the stylesheet')
  assert.match(css, /color-scheme:\s*light/)
  const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8')
  assert.match(html, /<meta name="color-scheme" content="light">/)
  assert.match(html, /<title>Influenza Admin<\/title>/)
  assert.ok(!/Studio Admin/.test(html + readFileSync(join(UI_DIR, 'main.js'), 'utf8') + readFileSync(join(UI_DIR, 'views/login.js'), 'utf8')), 'the old name is gone')
  assert.match(readFileSync(join(UI_DIR, 'lib/brand.js'), 'utf8'), /PANEL_NAME = 'Influenza'/)
})

panelTest('the panel refuses to turn server text into a script link', () => {
  assert.match(readFileSync(join(UI_DIR, 'lib/dom.js'), 'utf8'), /javascript:/)
})

test('where the panel lives: ADMIN_UI_DIR, or admin-panel/ beside backend/', () => {
  assert.equal(adminUiDir({}), resolve(dirname(fileURLToPath(import.meta.url)), '../../../admin-panel'))
  assert.equal(adminUiDir({ ADMIN_UI_DIR: '/srv/panel' }), resolve('/srv/panel'))
})

test('a server without the panel folder says so, instead of failing', async () => {
  const before = process.env.ADMIN_UI_DIR
  process.env.ADMIN_UI_DIR = join(tmpdir(), `no-admin-panel-${Date.now()}`)
  try {
    assert.equal(adminUiAvailable(), false)
    for (const url of ['/admin', '/admin/main.js']) {
      const res = await realFetch(`${stack.base}${url}`)
      assert.equal(res.status, 404, url)
      assert.equal((await res.json()).code, 'ADMIN_UI_MISSING', url)
    }
    // The API behind it is not affected.
    assert.equal((await get('/api/admin/stats')).status, 200)
  } finally {
    if (before === undefined) delete process.env.ADMIN_UI_DIR; else process.env.ADMIN_UI_DIR = before
  }
})

// ── The first admin ──────────────────────────────────────────────────────────

test('ADMIN_EMAILS promotes confirmed accounts that exist, and nothing else', async () => {
  const { promoteConfiguredAdmins } = await stack.load('api/_lib/admin.js')
  const owner = await stack.createUser({ email: 'owner@test.example' })
  await stack.sql(`insert into users (email, password_hash) values ('unconfirmed@test.example', 'x')`)
  const bystander = await stack.createUser({ email: 'bystander@test.example' })

  const env = { ADMIN_EMAILS: ' Owner@Test.Example , unconfirmed@test.example, nobody@test.example, ' }
  assert.equal(await promoteConfiguredAdmins({ env }), 1)
  assert.equal((await stack.one('select role from users where id = $1', [owner.id])).role, 'admin')
  assert.equal((await stack.one(`select role from users where email = 'unconfirmed@test.example'`)).role, 'user', 'an unverified address proves nothing')
  assert.equal((await stack.one('select role from users where id = $1', [bystander.id])).role, 'user')
  assert.equal(await promoteConfiguredAdmins({ env }), 0, 'idempotent')
  assert.equal(await promoteConfiguredAdmins({ env: {} }), 0)
  assert.equal(await promoteConfiguredAdmins({ env: { ADMIN_EMAILS: '' } }), 0)
})

test('with email confirmation off, ADMIN_EMAILS is ignored — anyone could have registered that address', async () => {
  const { promoteConfiguredAdmins } = await stack.load('api/_lib/admin.js')
  const u = await stack.createUser({ email: 'owner2@test.example' })
  const warnings = []
  const n = await promoteConfiguredAdmins({ env: { ADMIN_EMAILS: 'owner2@test.example', REQUIRE_EMAIL_CONFIRMATION: 'false' }, warn: m => warnings.push(m) })
  assert.equal(n, 0)
  assert.equal((await stack.one('select role from users where id = $1', [u.id])).role, 'user')
  assert.match(warnings[0], /ignored/)
})
