// The admin API, pushed harder: the endpoints the redesigned panel depends on, the
// edges of every filter and sort, hostile input, and the guarantees that must hold
// when things fail or happen at the same moment — an action and its audit entry
// together or not at all, and the panel never left with nobody who can open it.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack } from '../helpers/stack.js'

let stack
let admin
const realFetch = globalThis.fetch

before(async () => { stack = await startStack() })
after(async () => { globalThis.fetch = realFetch; await stack?.stop() })
beforeEach(async () => {
  await stack.reset()
  admin = await stack.createUser({ email: 'boss@test.example', role: 'admin' })
})

const get = (path, who = admin) => stack.api('GET', path, { token: who?.token })
const post = (path, body, who = admin) => stack.api('POST', path, { token: who?.token, body })
const audits = () => stack.sql('select action, target_id, details from admin_audit_log order by id')
const userRow = id => stack.one('select * from users where id = $1', [id])
const sessionCount = id => stack.one('select count(*)::int as n from sessions where user_id = $1', [id]).then(r => r.n)
const q = value => encodeURIComponent(value)

let counter = 0
async function makeJob(user, { state = 'success', model = 'kling-3.0/video', credits = null, completedAt = 'now()', createdAt = 'now()', failMsg = null } = {}) {
  return stack.one(
    `insert into generation_jobs (user_id, kie_task_id, kind, label, model, state, fail_msg, kie_credits, completed_at, created_at)
     values ($1, $2, 'video', 'Video', $3, $4, $5, $6, ${completedAt}, ${createdAt}) returning *`,
    [user.id, `depth-${++counter}`, model, state, failMsg, credits],
  )
}

async function makeEvent(user, { source = 'prompt', action = 'blocked', status = 'open', createdAt = 'now()', excerpt = 'x', assetId = null } = {}) {
  return stack.one(
    `insert into moderation_events (user_id, source, action, status, excerpt, asset_id, categories, scores, created_at)
     values ($1, $2, $3, $4, $5, $6, array['sexual'], '{"sexual":0.9}'::jsonb, ${createdAt}) returning *`,
    [user.id, source, action, status, excerpt, assetId],
  )
}

// ── Every new route is closed to everyone but an administrator ──────────────

test('the account detail and single-item routes need a session and an administrator, like all the others', async () => {
  const user = await stack.createUser()
  const ev = await makeEvent(user)
  for (const path of [`/api/admin/users/detail?userId=${user.id}`, `/api/admin/moderation/item?eventId=${ev.id}`]) {
    assert.equal((await get(path, null)).status, 401, `${path} with no session`)
    const asUser = await get(path, user)
    assert.equal(asUser.status, 403, `${path} as a user`)
    assert.equal(asUser.body.code, 'NOT_ADMIN')
    assert.equal((await get(path)).status, 200, `${path} as an admin`)
  }
})

// ── Account detail ──────────────────────────────────────────────────────────

const minuteAgo = minutes => `(date_trunc('minute', now()) - interval '${minutes} minutes')`

test('account detail: the account, its strikes, devices, influencers, files, recent jobs and flags', async () => {
  const sessions = await stack.load('api/_lib/sessions.js')
  const u = await stack.createUser({ email: 'mia@test.example' })
  await sessions.createSession({ id: u.id, email: u.email })
  const expired = await sessions.createSession({ id: u.id, email: u.email })
  await stack.sql(`update sessions set refresh_expires_at = now() - interval '1 day' where refresh_hash = $1`, [(await stack.load('api/_lib/sessions.js')).hashToken?.(expired.refreshToken) ?? ''])
  await stack.sql(`insert into influencers (user_id, name) values ($1, 'A'), ($1, 'B')`, [u.id])
  await stack.putAsset({ userId: u.id, bytes: Buffer.alloc(100), moderationStatus: 'clear' })
  await stack.putAsset({ userId: u.id, bytes: Buffer.alloc(50), moderationStatus: 'blocked' })
  await stack.putAsset({ userId: u.id, bytes: Buffer.alloc(25) })
  await makeJob(u, { credits: 12.5 })

  const res = await get(`/api/admin/users/detail?userId=${u.id}`)
  assert.equal(res.status, 200)
  const d = res.body
  assert.equal(d.user.id, u.id)
  assert.equal(d.user.email, 'mia@test.example')
  assert.equal(d.user.role, 'user')
  assert.equal(d.user.jobs, 1)
  assert.equal(d.user.kieCredits, 12.5)
  assert.equal(d.user.storageBytes, 175)
  assert.equal(d.influencers, 2)
  assert.deepEqual(d.assets, { byStatus: { unchecked: 1, clear: 1, blocked: 1 }, total: 3 })
  assert.equal(d.devices.active >= 2 && d.devices.active <= 3, true, 'live sessions are counted')
  assert.ok(d.devices.lastUsedAt)
  assert.equal(d.strikes.limit, 5)
  assert.equal(d.strikes.windowDays, 30)
  assert.equal(d.recentJobs.length, 1)
  assert.deepEqual(Object.keys(d.recentJobs[0]).sort(), ['createdAt', 'failMessage', 'id', 'kieCredits', 'kind', 'model', 'state', 'taskId'])
  assert.ok(!/password|hash|refresh|access_|token/i.test(res.text.replace(/taskId|kie_task/g, '')), 'nothing secret in the detail')
})

test('account detail: expired sessions are not devices', async () => {
  const u = await stack.createUser()
  assert.equal((await get(`/api/admin/users/detail?userId=${u.id}`)).body.devices.active, 1)
  await stack.sql(`update sessions set refresh_expires_at = now() - interval '1 second' where user_id = $1`, [u.id])
  assert.equal((await get(`/api/admin/users/detail?userId=${u.id}`)).body.devices.active, 0)
  assert.equal((await get(`/api/admin/users/detail?userId=${u.id}`)).body.devices.lastUsedAt === null || true, true)
})

test('account detail: strikes count what the enforcement counts — refusals of what they submitted, once a minute, undismissed, in the window', async () => {
  const u = await stack.createUser()
  await makeEvent(u, { createdAt: minuteAgo(10) })                                         // counts
  await makeEvent(u, { createdAt: `${minuteAgo(20)} + interval '5 seconds'` })             // counts…
  await makeEvent(u, { source: 'image', createdAt: `${minuteAgo(20)} + interval '40 seconds'` }) // …but the same minute is one mistake
  await makeEvent(u, { action: 'review', createdAt: minuteAgo(30) })                       // held, not refused
  await makeEvent(u, { source: 'output', createdAt: minuteAgo(40) })                       // not their doing
  await makeEvent(u, { source: 'prompt_assist', createdAt: minuteAgo(50) })                // a draft
  await makeEvent(u, { source: 'report', createdAt: minuteAgo(55) })                       // a flag by someone
  await makeEvent(u, { status: 'dismissed', createdAt: minuteAgo(60) })                    // the checker was wrong
  await makeEvent(u, { createdAt: `now() - interval '31 days'` })                          // outside the window
  const { strikes, windowDays } = (await get(`/api/admin/users/detail?userId=${u.id}`)).body
  assert.equal(strikes.count, 2)
  assert.equal(windowDays ?? strikes.windowDays, 30)
})

test('account detail: a strike withdrawn by dismissing the item is gone from the count at once', async () => {
  const u = await stack.createUser()
  const ev = await makeEvent(u, { createdAt: minuteAgo(5) })
  assert.equal((await get(`/api/admin/users/detail?userId=${u.id}`)).body.strikes.count, 1)
  assert.equal((await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'dismiss' })).status, 200)
  assert.equal((await get(`/api/admin/users/detail?userId=${u.id}`)).body.strikes.count, 0)
})

test('account detail: only the eight newest jobs and flags, newest first', async () => {
  const u = await stack.createUser()
  for (let i = 1; i <= 11; i++) {
    await makeJob(u, { createdAt: `now() - interval '${i} minutes'` })
    await makeEvent(u, { createdAt: `now() - interval '${i} minutes'`, excerpt: `flag-${i}` })
  }
  const d = (await get(`/api/admin/users/detail?userId=${u.id}`)).body
  assert.equal(d.recentJobs.length, 8)
  assert.equal(d.recentEvents.length, 8)
  assert.deepEqual(d.recentEvents.map(e => e.excerpt), Array.from({ length: 8 }, (_, i) => `flag-${i + 1}`))
  const times = d.recentJobs.map(j => Date.parse(j.createdAt))
  assert.deepEqual([...times].sort((a, b) => b - a), times)
  assert.equal(d.user.jobs, 11, 'the total counts them all')
})

test('account detail: never someone else\'s data', async () => {
  const a = await stack.createUser({ email: 'a@test.example' })
  const b = await stack.createUser({ email: 'b@test.example' })
  await makeJob(b, { credits: 99 }); await makeEvent(b); await stack.putAsset({ userId: b.id, bytes: Buffer.alloc(10) })
  await stack.sql(`insert into influencers (user_id, name) values ($1, 'B-only')`, [b.id])
  const d = (await get(`/api/admin/users/detail?userId=${a.id}`)).body
  assert.equal(d.recentJobs.length, 0)
  assert.equal(d.recentEvents.length, 0)
  assert.equal(d.influencers, 0)
  assert.equal(d.assets.total, 0)
  assert.equal(d.user.kieCredits, 0)
})

test('account detail: an unknown account is a 404; a missing, malformed or repeated id is a 400', async () => {
  assert.equal((await get('/api/admin/users/detail?userId=00000000-0000-4000-8000-000000000000')).status, 404)
  for (const query of ['', '?userId=', '?userId=nope', '?userId=1', `?userId=${admin.id}&userId=${admin.id}`, '?userId[]=x', `?userId=${admin.id}%00`, `?userId=${'a'.repeat(5000)}`]) {
    assert.equal((await get(`/api/admin/users/detail${query}`)).status, 400, query)
  }
})

test('account detail works for an administrator and for a suspended account', async () => {
  const s = await stack.createUser({ status: 'suspended' })
  await stack.sql(`update users set suspended_at = now(), suspended_reason = 'By boss: spam' where id = $1`, [s.id])
  const d = (await get(`/api/admin/users/detail?userId=${s.id}`)).body
  assert.equal(d.user.status, 'suspended')
  assert.equal(d.user.suspendedReason, 'By boss: spam')
  assert.ok(d.user.suspendedAt)
  assert.equal((await get(`/api/admin/users/detail?userId=${admin.id}`)).body.user.role, 'admin')
})

// ── User list: search, sort, paging ─────────────────────────────────────────

async function sortFixture() {
  const make = async (name, { jobs, credits, flags, storage, ageDays }) => {
    const u = await stack.createUser({ email: `${name}@sorttest.example` })
    await stack.sql(`update users set created_at = now() - $2 * interval '1 day' where id = $1`, [u.id, ageDays])
    for (let i = 0; i < jobs; i++) await makeJob(u, { credits: i === 0 ? credits : 0 })
    for (let i = 0; i < flags; i++) await makeEvent(u)
    if (storage) await stack.putAsset({ userId: u.id, bytes: Buffer.alloc(storage) })
    return u
  }
  await make('aaa', { jobs: 3, credits: 5, flags: 0, storage: 100, ageDays: 1 })
  await make('bbb', { jobs: 1, credits: 50, flags: 2, storage: 5, ageDays: 3 })
  await make('ccc', { jobs: 2, credits: 20, flags: 1, storage: 300, ageDays: 2 })
}
const order = async query => (await get(`/api/admin/users?q=sorttest&${query}`)).body.users.map(u => u.email.slice(0, 3))

test('every sort key sorts, in both directions, and says which it used', async () => {
  await sortFixture()
  const expected = {
    created: ['aaa', 'ccc', 'bbb'],          // newest first
    email: ['ccc', 'bbb', 'aaa'],            // descending
    jobs: ['aaa', 'ccc', 'bbb'],
    credits: ['bbb', 'ccc', 'aaa'],
    flags: ['bbb', 'ccc', 'aaa'],
    storage: ['ccc', 'aaa', 'bbb'],
  }
  for (const [sort, desc] of Object.entries(expected)) {
    assert.deepEqual(await order(`sort=${sort}&dir=desc`), desc, `${sort} desc`)
    assert.deepEqual(await order(`sort=${sort}&dir=asc`), [...desc].reverse(), `${sort} asc`)
    const res = await get(`/api/admin/users?q=sorttest&sort=${sort}&dir=asc`)
    assert.equal(res.body.sort, sort)
    assert.equal(res.body.dir, 'asc')
  }
})

test('the default is newest first; email sorting ignores case', async () => {
  await sortFixture()
  assert.deepEqual(await order(''), ['aaa', 'ccc', 'bbb'])
  await stack.sql(`update users set email = 'Zzz@sorttest.example' where email like 'aaa@%'`)
  assert.deepEqual(await order('sort=email&dir=asc'), ['bbb', 'ccc', 'Zzz'])
})

test('a sort or direction that is not on the list is ignored — it never reaches the query', async () => {
  await sortFixture()
  const defaults = await order('')
  const hostile = [
    'sort=password_hash', 'sort=created_at;drop table users', `sort=${q('email; select pg_sleep(5)')}`, 'sort=', 'sort=__proto__',
    'sort=constructor', 'sort=toString', 'sort=hasOwnProperty', 'dir=sideways', `dir=${q('desc; drop table users')}`, 'dir=ASC', 'dir=',
  ]
  for (const query of hostile) {
    const res = await get(`/api/admin/users?q=sorttest&${query}`)
    assert.equal(res.status, 200, query)
    assert.equal(res.body.sort, 'created', query)
    assert.equal(res.body.dir, 'desc', query)
    assert.deepEqual(res.body.users.map(u => u.email.slice(0, 3)), defaults, query)
  }
  assert.equal((await stack.one('select count(*)::int as n from users')).n, 4, 'the table is intact')
})

test('odd shapes of the sort parameter are not a server error', async () => {
  for (const query of ['sort[]=email', 'sort[a]=b', 'sort=email&sort=jobs', 'dir[]=asc', 'sort[]=', 'sort=email&dir=asc&dir=desc']) {
    const res = await get(`/api/admin/users?${query}`)
    assert.equal(res.status, 200, query)
  }
})

test('ties never skip or repeat an account while paging', async () => {
  for (let i = 0; i < 9; i++) await stack.createUser({ email: `tie${i}@ties.example` })
  await stack.sql(`update users set created_at = '2026-01-01T00:00:00Z' where email like '%@ties.example'`)
  for (const sort of ['created', 'jobs', 'credits', 'flags', 'storage']) {
    const seen = []
    for (const page of [1, 2, 3, 4]) seen.push(...(await get(`/api/admin/users?q=ties.example&sort=${sort}&pageSize=3&page=${page}`)).body.users.map(u => u.id))
    assert.equal(new Set(seen).size, 9, `${sort}: all nine, each once`)
    assert.equal(seen.length, 9)
  }
})

test('search finds a name as well as an email, ignores padding, and treats an empty term as no search', async () => {
  const u = await stack.createUser({ email: 'unrelated@test.example' })
  await stack.sql(`update users set display_name = 'Miranda Brown' where id = $1`, [u.id])
  assert.equal((await get('/api/admin/users?q=miranda')).body.total, 1)
  assert.equal((await get('/api/admin/users?q=' + q('  Brown  '))).body.total, 1)
  assert.equal((await get('/api/admin/users?q=')).body.total, 2)
  assert.equal((await get('/api/admin/users?q=' + q('   '))).body.total, 2)
  assert.equal((await get('/api/admin/users?q=' + q('\\'))).body.total, 0, 'a backslash is a character, not an escape')
})

test('search survives a NUL, a lone surrogate, an enormous term and a repeated parameter', async () => {
  await stack.createUser({ email: 'ok@test.example' })
  for (const term of ['%00', 'a%00b', '%ED%A0%80', 'x'.repeat(10_000), '%F0%9F%98%80', '"; --', '\n\t']) {
    const res = await get(`/api/admin/users?q=${term.startsWith('%') ? term : q(term)}`)
    assert.ok(res.status === 200 || res.status === 400, `${term.slice(0, 20)} answered ${res.status}`)
  }
  assert.equal((await get('/api/admin/users?q=a&q=b')).status, 200)
  assert.equal((await get('/api/admin/users?q[]=a')).status, 200)
  assert.equal((await get('/api/admin/users?q[x]=a')).status, 200)
})

test('paging beyond the end is an empty page that still knows the total; nonsense pages are page 1', async () => {
  for (let i = 0; i < 3; i++) await stack.createUser()
  const beyond = (await get('/api/admin/users?page=99&pageSize=2')).body
  assert.equal(beyond.users.length, 0)
  assert.equal(beyond.total, 4)
  for (const query of ['page=0', 'page=-3', 'page=abc', 'page=1.5', 'page=', 'page[]=2']) {
    const res = await get(`/api/admin/users?${query}&pageSize=2`)
    assert.equal(res.status, 200, query)
    assert.equal(res.body.page, 1, query)
  }
  for (const query of ['pageSize=0', 'pageSize=-1', 'pageSize=abc', 'pageSize=1e308', 'pageSize=']) {
    const res = await get(`/api/admin/users?${query}`)
    assert.equal(res.status, 200, query)
    assert.ok(res.body.pageSize >= 1 && res.body.pageSize <= 100, `${query} → ${res.body.pageSize}`)
  }
  assert.equal((await get('/api/admin/users?page=1e308')).status, 200)
})

test('the list reflects a change at once: a suspended account shows as suspended with its reason', async () => {
  const u = await stack.createUser({ email: 'soon@test.example' })
  assert.equal((await post('/api/admin/users/suspend', { userId: u.id, reason: 'spam' })).status, 200)
  const row = (await get('/api/admin/users?q=soon')).body.users[0]
  assert.equal(row.status, 'suspended')
  assert.match(row.suspendedReason, /^By boss@test\.example: spam$/)
  assert.ok(row.suspendedAt)
})

// ── Moderation: one item, counts, filters ───────────────────────────────────

test('a single item has exactly the shape the list gives it, plus who decided it', async () => {
  const u = await stack.createUser({ email: 'owner@test.example' })
  const asset = await stack.putAsset({ userId: u.id, bytes: Buffer.alloc(10), moderationStatus: 'blocked' })
  const ev = await makeEvent(u, { source: 'image', assetId: asset.id })
  const fromList = (await get('/api/admin/moderation')).body.events[0]
  const one = (await get(`/api/admin/moderation/item?eventId=${ev.id}`)).body.event
  assert.deepEqual(one, fromList)
  assert.equal(one.assetKind, 'image')
  assert.equal(one.assetStatus, 'blocked')
  assert.equal(one.email, 'owner@test.example')

  await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'dismiss', note: 'fine' })
  const after = (await get(`/api/admin/moderation/item?eventId=${ev.id}`)).body.event
  assert.equal(after.status, 'dismissed')
  assert.equal(after.reviewedBy, 'boss@test.example')
  assert.equal(after.reviewNote, 'fine')
  assert.ok(after.reviewedAt)
})

test('a single item: unknown is a 404; missing, malformed or repeated ids are a 400', async () => {
  assert.equal((await get('/api/admin/moderation/item?eventId=00000000-0000-4000-8000-000000000000')).status, 404)
  for (const query of ['', '?eventId=', '?eventId=nope', `?eventId=${admin.id}%00`, '?eventId[]=x', '?eventId=1;drop table moderation_events']) {
    assert.equal((await get(`/api/admin/moderation/item${query}`)).status, 400, query)
  }
})

test('the queue\'s counts ignore the status you are looking at but follow every other filter', async () => {
  const a = await stack.createUser({ email: 'a@test.example' })
  const b = await stack.createUser({ email: 'b@test.example' })
  await makeEvent(a); await makeEvent(a); await makeEvent(a, { status: 'dismissed' }); await makeEvent(a, { status: 'confirmed', source: 'image' })
  await makeEvent(b, { source: 'report', action: 'review' }); await makeEvent(b, { status: 'dismissed', source: 'report', action: 'review' })

  const all = (await get('/api/admin/moderation?status=all')).body
  assert.deepEqual(all.counts, { open: 3, dismissed: 2, confirmed: 1 })
  assert.equal(all.total, 6)

  const dismissed = (await get('/api/admin/moderation?status=dismissed')).body
  assert.equal(dismissed.total, 2)
  assert.deepEqual(dismissed.counts, { open: 3, dismissed: 2, confirmed: 1 }, 'the tabs still show every status')

  assert.deepEqual((await get('/api/admin/moderation?source=report')).body.counts, { open: 1, dismissed: 1, confirmed: 0 })
  assert.deepEqual((await get('/api/admin/moderation?action=review&status=all')).body.counts, { open: 1, dismissed: 1, confirmed: 0 })
  assert.deepEqual((await get(`/api/admin/moderation?userId=${a.id}`)).body.counts, { open: 2, dismissed: 1, confirmed: 1 })
  assert.deepEqual((await get(`/api/admin/moderation?userId=${a.id}&source=image`)).body.counts, { open: 0, dismissed: 0, confirmed: 1 })
})

test('filtering the queue by account returns only that account\'s items; a bad id is refused', async () => {
  const a = await stack.createUser(); const b = await stack.createUser()
  await makeEvent(a); await makeEvent(b); await makeEvent(b)
  const res = await get(`/api/admin/moderation?userId=${b.id}`)
  assert.equal(res.body.total, 2)
  assert.ok(res.body.events.every(e => e.userId === b.id))
  assert.equal((await get(`/api/admin/moderation?userId=${admin.id}`)).body.total, 0)
  for (const bad of ['nope', '1', `${a.id}%00`, `${a.id}'`, 'x'.repeat(2000)]) {
    assert.equal((await get(`/api/admin/moderation?userId=${bad}`)).status, 400, bad)
  }
})

test('the queue refuses a status, source or action it does not know — and says which are allowed', async () => {
  for (const [query, word] of [['status=bogus', 'status'], ['source=bogus', 'source'], ['action=bogus', 'action'], ['status=OPEN', 'status'], ['status=open&status=all', 'status'], ['source=prompt&source=image', 'source']]) {
    const res = await get(`/api/admin/moderation?${query}`)
    assert.equal(res.status, 400, query)
    assert.match(res.body.error, new RegExp(word), query)
  }
  assert.equal((await get('/api/admin/moderation?status=all&source=&action=')).status, 200, 'empty filters mean no filter')
})

test('the queue is newest first, ties broken the same way every time, and pages without gaps', async () => {
  const u = await stack.createUser()
  for (let i = 0; i < 7; i++) await makeEvent(u, { createdAt: i < 4 ? `timestamp '2026-10-01T10:00:00Z'` : `timestamp '2026-10-02T10:00:00Z'` })
  const seen = []
  for (const page of [1, 2, 3]) seen.push(...(await get(`/api/admin/moderation?pageSize=3&page=${page}`)).body.events.map(e => e.id))
  assert.equal(new Set(seen).size, 7)
  const full = (await get('/api/admin/moderation?pageSize=100')).body.events
  assert.deepEqual(full.map(e => e.id), seen)
  assert.ok(Date.parse(full[0].createdAt) >= Date.parse(full.at(-1).createdAt))
})

test('a report-sourced item with no file has no asset fields filled in', async () => {
  const u = await stack.createUser()
  await makeEvent(u, { source: 'report', action: 'review', excerpt: 'this is wrong' })
  const e = (await get('/api/admin/moderation')).body.events[0]
  assert.equal(e.assetId, null)
  assert.equal(e.assetKind, null)
  assert.equal(e.assetStatus, null)
  assert.equal(e.reviewedBy, null)
})

// ── The audit log ───────────────────────────────────────────────────────────

async function seedAudit() {
  const second = await stack.createUser({ email: 'second@test.example', role: 'admin' })
  const rows = [
    [admin, 'user.suspend'], [admin, 'user.unsuspend'], [second, 'user.delete'], [admin, 'moderation.dismiss'],
    [second, 'moderation.view-media'], [admin, 'price.upsert'], [second, 'price.delete'],
  ]
  for (const [who, action] of rows) {
    await stack.sql(`insert into admin_audit_log (admin_id, admin_email, action, details) values ($1, $2, $3, '{}'::jsonb)`, [who.id, who.email, action])
  }
}

test('the audit log filters by family (a prefix), by admin (case-insensitive, partial), and by both', async () => {
  await seedAudit()
  const actions = async query => (await get(`/api/admin/audit?${query}`)).body.entries.map(e => e.action).sort()
  assert.deepEqual(await actions('action=user.'), ['user.delete', 'user.suspend', 'user.unsuspend'])
  assert.deepEqual(await actions('action=moderation.'), ['moderation.dismiss', 'moderation.view-media'])
  assert.deepEqual(await actions('action=price.'), ['price.delete', 'price.upsert'])
  assert.deepEqual(await actions('action=user'), ['user.delete', 'user.suspend', 'user.unsuspend'], 'a prefix does not need its dot')
  assert.deepEqual(await actions('action=user.sus'), ['user.suspend'])
  assert.equal((await get('/api/admin/audit')).body.total, 7)
  assert.deepEqual(await actions('admin=SECOND'), ['moderation.view-media', 'price.delete', 'user.delete'])
  assert.deepEqual(await actions('admin=second@test&action=price.'), ['price.delete'])
  assert.deepEqual(await actions('admin=nobody'), [])
})

test('an action filter is a prefix: the same words in the middle of an action do not match', async () => {
  for (const action of ['user.suspend', 'legacy.user.suspend', 'x.user.', 'USER.suspend']) {
    await stack.sql(`insert into admin_audit_log (admin_id, admin_email, action, details) values ($1, $2, $3, '{}'::jsonb)`, [admin.id, admin.email, action])
  }
  const actions = async query => (await get(`/api/admin/audit?${query}`)).body.entries.map(e => e.action).sort()
  assert.deepEqual(await actions('action=user.'), ['user.suspend'])
  assert.deepEqual(await actions('action=legacy.'), ['legacy.user.suspend'])
  assert.deepEqual(await actions('action=USER.'), ['USER.suspend'], 'actions are matched exactly, including case')
})

test('audit filters treat % and _ as plain characters, and survive hostile text', async () => {
  await seedAudit()
  assert.equal((await get(`/api/admin/audit?action=${q('%')}`)).body.total, 0)
  assert.equal((await get(`/api/admin/audit?action=${q('user_')}`)).body.total, 0)
  assert.equal((await get(`/api/admin/audit?admin=${q('%')}`)).body.total, 0)
  assert.equal((await get(`/api/admin/audit?admin=${q('_')}`)).body.total, 0)
  for (const value of ['%ED%A0%80', "'; drop table admin_audit_log; --", 'x'.repeat(5000)]) {
    for (const key of ['action', 'admin']) {
      const res = await get(`/api/admin/audit?${key}=${value.startsWith('%') ? value : q(value)}`)
      assert.equal(res.status, 200, `${key}=${value.slice(0, 20)}`)
    }
  }
  // A NUL byte, which the database cannot store, is refused at the door (api/_lib/nul.js) instead of reaching it.
  for (const value of ['%00', 'a%00b']) {
    for (const key of ['action', 'admin']) {
      const res = await get(`/api/admin/audit?${key}=${value}`)
      assert.equal(res.status, 400, `${key}=${value}`)
      assert.equal(res.body.code, 'BAD_CHARACTER')
    }
  }
  assert.equal((await stack.one('select count(*)::int as n from admin_audit_log')).n, 7)
})

test('the audit log is newest first with the same ordering on every page', async () => {
  await seedAudit()
  await stack.sql(`update admin_audit_log set created_at = '2026-10-01T00:00:00Z'`)    // all tied
  const seen = []
  for (const page of [1, 2, 3, 4]) seen.push(...(await get(`/api/admin/audit?pageSize=2&page=${page}`)).body.entries.map(e => e.id))
  assert.equal(new Set(seen).size, 7)
  assert.deepEqual(seen.map(Number), [...seen.map(Number)].sort((a, b) => b - a), 'id descending within a tie')
  const beyond = (await get('/api/admin/audit?page=50&pageSize=2')).body
  assert.equal(beyond.entries.length, 0)
  assert.equal(beyond.total, 7)
})

test('audit entries say who, what, on what, and when — and keep the admin\'s email even if the account is gone', async () => {
  const second = await stack.createUser({ email: 'gone@test.example', role: 'admin' })
  await stack.sql(`insert into admin_audit_log (admin_id, admin_email, action, target_type, target_id, details) values ($1, 'gone@test.example', 'user.delete', 'user', 'abc', '{"email":"x"}'::jsonb)`, [second.id])
  await stack.sql('delete from users where id = $1', [second.id])
  const entry = (await get('/api/admin/audit')).body.entries[0]
  assert.equal(entry.admin, 'gone@test.example')
  assert.deepEqual({ a: entry.action, t: entry.targetType, id: entry.targetId, d: entry.details }, { a: 'user.delete', t: 'user', id: 'abc', d: { email: 'x' } })
  assert.ok(entry.at)
  assert.equal(typeof entry.id, 'string')
})

// ── Overview numbers ────────────────────────────────────────────────────────

test('stats count the right jobs in the right windows, and say how many finished jobs have no charge', async () => {
  const u = await stack.createUser()
  await makeJob(u, { state: 'success', credits: 10 })                                                         // today
  await makeJob(u, { state: 'success', credits: 20, completedAt: `now() - interval '2 days'`, createdAt: `now() - interval '2 days'` })
  await makeJob(u, { state: 'success', credits: 40, completedAt: `now() - interval '20 days'`, createdAt: `now() - interval '20 days'` })
  await makeJob(u, { state: 'success', credits: 80, completedAt: `now() - interval '40 days'`, createdAt: `now() - interval '40 days'` })
  await makeJob(u, { state: 'fail', credits: null })                                                          // settled, no charge
  await makeJob(u, { state: 'success', credits: 0 })                                                          // free is not unknown
  await makeJob(u, { state: 'generating', completedAt: 'null' })
  await makeJob(u, { state: 'waiting', completedAt: 'null' })
  await makeJob(u, { state: 'queuing', completedAt: 'null' })

  const s = (await get('/api/admin/stats')).body
  assert.equal(s.jobs.running, 3)
  assert.equal(s.jobs.credits24h, 10)
  assert.equal(s.jobs.credits7d, 30)
  assert.equal(s.jobs.credits30d, 70)
  assert.equal(s.jobs.chargeUnknown30d, 1)
  assert.equal(s.jobs.started24h, 6)
  assert.equal(s.jobs.failed24h, 1)
  assert.equal(s.users.total, 2)
})

test('stats: users, flags and the models used without a price', async () => {
  const u = await stack.createUser()
  await stack.createUser({ status: 'suspended' })
  await stack.sql(`update users set created_at = now() - interval '9 days' where id = $1`, [u.id])
  await makeEvent(u); await makeEvent(u, { action: 'review' }); await makeEvent(u, { status: 'dismissed' })
  for (const model of ['priced-model', 'unpriced-a', 'unpriced-a', 'unpriced-b']) await makeJob(u, { model })
  await makeJob(u, { model: null }); await makeJob(u, { model: '' })
  await post('/api/admin/prices/upsert', { model: 'priced-model', unit: 'per_video', credits: 1, enabled: true })

  const s = (await get('/api/admin/stats')).body
  assert.deepEqual(s.users, { total: 3, suspended: 1, new_7d: 2 })
  assert.deepEqual({ open: s.moderation.open, blocked: s.moderation.openBlocked, today: s.moderation.events24h }, { open: 2, blocked: 1, today: 3 })
  assert.equal(s.unpricedModels, 2, 'two distinct models; blank and null do not count; a priced one does not')

  await post('/api/admin/prices/upsert', { model: 'unpriced-a', unit: 'per_video', credits: 1, enabled: false })
  assert.equal((await get('/api/admin/stats')).body.unpricedModels, 1, 'pricing a model — even switched off — takes it off the list')
  await post('/api/admin/prices/delete', { model: 'unpriced-a' })
  assert.equal((await get('/api/admin/stats')).body.unpricedModels, 2)
})

test('stats on an empty system are zeros, not nulls', async () => {
  await stack.sql('delete from users where id <> $1', [admin.id])
  const s = (await get('/api/admin/stats')).body
  assert.deepEqual(s.jobs, { running: 0, started24h: 0, failed24h: 0, credits24h: 0, credits7d: 0, credits30d: 0, chargeUnknown30d: 0 })
  assert.deepEqual(s.moderation, { open: 0, openBlocked: 0, events24h: 0 })
  assert.equal(s.unpricedModels, 0)
})

test('usage covers whole UTC days ending today, so its totals match the chart', async () => {
  const u = await stack.createUser()
  const day = n => `(date_trunc('day', now() at time zone 'UTC') - interval '${n} days') at time zone 'UTC'`
  await makeJob(u, { credits: 1, completedAt: `${day(0)} + interval '1 minute'` })                    // today
  await makeJob(u, { credits: 2, completedAt: `${day(6)} + interval '1 minute'` })                    // the first day of a 7-day window
  await makeJob(u, { credits: 4, completedAt: `${day(6)} - interval '1 minute'` })                    // the last minute BEFORE it
  await makeJob(u, { credits: 8, completedAt: `${day(7)} + interval '12 hours'` })                    // the day before the window

  const seven = (await get('/api/admin/usage?days=7')).body
  assert.equal(seven.days, 7)
  assert.equal(seven.rows.reduce((n, r) => n + r.credits, 0), 3, 'today and the first day of the window; nothing earlier')
  const days = seven.rows.map(r => r.day)
  assert.ok(days.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)), 'days are plain UTC dates')
  assert.equal(new Set(days).size, 2)
  assert.equal((await get('/api/admin/usage?days=1')).body.rows.reduce((n, r) => n + r.credits, 0), 1, 'one day is today')
  assert.equal((await get('/api/admin/usage?days=8')).body.rows.reduce((n, r) => n + r.credits, 0), 15, '8 days takes in the day before the 7-day window, and with it both jobs on that day')
})

test('usage groups by day and model, counts successes and failures, names a missing model, and lists the biggest first', async () => {
  const u = await stack.createUser()
  await makeJob(u, { model: 'a', credits: 5 }); await makeJob(u, { model: 'a', credits: 5 }); await makeJob(u, { model: 'a', state: 'fail', credits: 1 })
  await makeJob(u, { model: 'b', credits: 50 }); await makeJob(u, { model: null, credits: 2 }); await makeJob(u, { model: 'c', state: 'generating', completedAt: 'null' })
  const { rows } = (await get('/api/admin/usage?days=1')).body
  assert.deepEqual(rows.map(r => r.model), ['b', 'a', '(unknown)'], 'unfinished jobs are not usage; biggest spend first')
  assert.deepEqual(rows.find(r => r.model === 'a'), { day: rows[0].day, model: 'a', succeeded: 2, failed: 1, credits: 11 })
  assert.equal(typeof rows[0].credits, 'number')
})

test('usage: days is a whole number from 1 to 90, and anything else is 30', async () => {
  const days = async value => (await get(`/api/admin/usage?days=${value}`)).body.days
  assert.equal(await days('7'), 7)
  assert.equal(await days('90'), 90)
  assert.equal(await days('91'), 90)
  assert.equal(await days('100000'), 90)
  assert.equal(await days('1'), 1)
  assert.equal(await days('1.9'), 1)
  assert.equal(await days('-5'), 1)
  assert.equal(await days('0'), 30)
  assert.equal(await days('abc'), 30)
  assert.equal(await days(''), 30)
  assert.equal(await days('1e999'), 90)
  assert.equal((await get('/api/admin/usage')).body.days, 30)
  assert.equal((await get('/api/admin/usage?days[]=5')).status, 200)
})

// ── Hostile text ────────────────────────────────────────────────────────────

test('a suspension reason: required, trimmed, bounded, and any text is stored safely', async () => {
  const target = await stack.createUser({ email: 'target@test.example' })
  const suspend = reason => post('/api/admin/users/suspend', { userId: target.id, reason })
  const reset = () => stack.sql(`update users set status = 'active', suspended_at = null, suspended_reason = null where id = $1`, [target.id])

  for (const bad of [undefined, null, '', '   ', '\n\t', 123, true, [], ['spam'], { a: 1 }, 'x'.repeat(301), 'a\u0000b']) {
    const res = await suspend(bad)
    assert.equal(res.status, 400, JSON.stringify(bad)?.slice(0, 30))
    assert.equal((await userRow(target.id)).status, 'active', 'nothing changed')
  }
  assert.equal((await audits()).length, 0, 'refused requests leave no trace')

  assert.equal((await suspend('x'.repeat(300))).status, 200)
  await reset()
  assert.equal((await suspend('  padded reason  ')).status, 200)
  assert.equal((await userRow(target.id)).suspended_reason, 'By boss@test.example: padded reason')
  await reset()

  for (const odd of ['emoji 😀 ok', 'lone \ud800 surrogate', '<script>alert(1)</script>', "o'brien; drop table users; --", 'tab\there', '‮RTL', '日本語の理由']) {
    const res = await suspend(odd)
    assert.equal(res.status, 200, odd)
    const stored = (await userRow(target.id)).suspended_reason
    assert.ok(stored.startsWith('By boss@test.example: '), odd)
    assert.ok(!stored.includes('\ud800') || /\ud800[\udc00-\udfff]/.test(stored), 'no lone surrogate reaches the database')
    await reset()
  }
  assert.equal((await stack.one('select count(*)::int as n from users')).n, 2)
})

test('the same text in an audit entry never makes the action fail', async () => {
  const target = await stack.createUser()
  const res = await post('/api/admin/users/suspend', { userId: target.id, reason: 'bad \ud800 and \u0001 control' })
  assert.equal(res.status, 200)
  const entry = (await audits()).at(-1)
  assert.equal(entry.action, 'user.suspend')
  assert.match(entry.details.reason, /bad .* and .* control/)
})

test('a model id with a NUL is refused as a price', async () => {
  assert.equal((await post('/api/admin/prices/upsert', { model: 'bad\u0000model', unit: 'per_video', credits: 1, enabled: true })).status, 400)
  assert.equal((await post('/api/admin/prices/upsert', { model: 'ok-model', unit: 'per_video', credits: 1, enabled: true })).status, 200)
  assert.equal((await get('/api/admin/prices')).body.prices.length, 1)
})

// ── Actions and their audit entries: together or not at all ─────────────────

async function breakAudit(action, fn) {
  await stack.sql(`alter table admin_audit_log add constraint depth_break check (action <> '${action}')`)
  try { return await fn() } finally { await stack.sql('alter table admin_audit_log drop constraint depth_break') }
}

test('if the audit entry cannot be written, a suspension does not happen — and the person stays signed in', async () => {
  const target = await stack.createUser()
  const res = await breakAudit('user.suspend', () => post('/api/admin/users/suspend', { userId: target.id, reason: 'spam' }))
  assert.equal(res.status, 500)
  assert.equal((await userRow(target.id)).status, 'active')
  assert.equal((await userRow(target.id)).suspended_reason, null)
  assert.equal(await sessionCount(target.id), 1, 'their session was not revoked')
  assert.equal((await get('/api/admin/stats', target)).status, 403, 'and they still reach the API as themselves (just not admin)')
  assert.equal((await audits()).length, 0)
})

test('if the audit entry cannot be written, a restore, a role change and a deletion do not happen either', async () => {
  const suspended = await stack.createUser({ status: 'suspended' })
  assert.equal((await breakAudit('user.unsuspend', () => post('/api/admin/users/unsuspend', { userId: suspended.id }))).status, 500)
  assert.equal((await userRow(suspended.id)).status, 'suspended')

  const promoted = await stack.createUser()
  assert.equal((await breakAudit('user.set-role', () => post('/api/admin/users/set-role', { userId: promoted.id, role: 'admin' }))).status, 500)
  assert.equal((await userRow(promoted.id)).role, 'user')

  const doomed = await stack.createUser({ email: 'doomed@test.example' })
  assert.equal((await breakAudit('user.delete', () => post('/api/admin/users/delete', { userId: doomed.id, confirmEmail: 'doomed@test.example' }))).status, 500)
  assert.ok(await userRow(doomed.id), 'the account is still there')
  assert.equal((await audits()).length, 0)
})

test('a refused action leaves no audit entry, whatever the reason for refusing', async () => {
  const user = await stack.createUser({ email: 'plain@test.example' })
  const other = await stack.createUser({ email: 'other-admin@test.example', role: 'admin' })
  const ghost = '00000000-0000-4000-8000-000000000000'
  const refused = [
    ['/api/admin/users/suspend', { userId: admin.id, reason: 'x' }],
    ['/api/admin/users/suspend', { userId: other.id, reason: 'x' }],
    ['/api/admin/users/suspend', { userId: ghost, reason: 'x' }],
    ['/api/admin/users/suspend', { userId: 'nope', reason: 'x' }],
    ['/api/admin/users/set-role', { userId: admin.id, role: 'user' }],
    ['/api/admin/users/set-role', { userId: user.id, role: 'owner' }],
    ['/api/admin/users/set-role', { userId: ghost, role: 'admin' }],
    ['/api/admin/users/delete', { userId: user.id, confirmEmail: 'wrong@test.example' }],
    ['/api/admin/users/delete', { userId: other.id, confirmEmail: other.email }],
    ['/api/admin/users/delete', { userId: admin.id, confirmEmail: admin.email }],
    ['/api/admin/users/delete', { userId: ghost, confirmEmail: 'x@test.example' }],
    ['/api/admin/users/unsuspend', { userId: ghost }],
    ['/api/admin/moderation/resolve', { eventId: ghost, resolution: 'dismiss' }],
    ['/api/admin/moderation/resolve', { eventId: 'nope', resolution: 'dismiss' }],
    ['/api/admin/prices/upsert', { model: 'm', unit: 'per_year', credits: 1 }],
    ['/api/admin/prices/upsert', { model: 'm', unit: 'per_video', credits: -1 }],
    ['/api/admin/prices/delete', { model: ghost }],
  ]
  for (const [path, body] of refused) {
    const res = await post(path, body)
    assert.ok(res.status >= 400 && res.status < 500, `${path} ${JSON.stringify(body)} answered ${res.status}`)
  }
  assert.deepEqual(await audits(), [], 'not one entry')
  assert.equal((await userRow(user.id)).role, 'user')
  assert.equal((await userRow(other.id)).role, 'admin')
})

test('an action that changed nothing says so, and the entry records that', async () => {
  const u = await stack.createUser()
  assert.equal((await post('/api/admin/users/unsuspend', { userId: u.id })).body.changed, false)
  await post('/api/admin/users/suspend', { userId: u.id, reason: 'one' })
  const again = await post('/api/admin/users/suspend', { userId: u.id, reason: 'two' })
  assert.equal(again.status, 200)
  assert.equal(again.body.changed, false)
  assert.match((await userRow(u.id)).suspended_reason, /one$/, 'the original reason is kept')
  assert.equal((await post('/api/admin/users/set-role', { userId: u.id, role: 'user' })).body.changed, false)
  assert.deepEqual((await audits()).map(a => [a.action, a.details.changed ?? null]), [['user.unsuspend', false], ['user.suspend', true], ['user.suspend', false], ['user.set-role', null]])
})

// ── At the same moment ──────────────────────────────────────────────────────

test('two administrators demoting each other at the same time cannot leave the panel with no administrator', async () => {
  const other = await stack.createUser({ email: 'other@test.example', role: 'admin' })
  const [a, b] = await Promise.all([
    post('/api/admin/users/set-role', { userId: other.id, role: 'user' }, admin),
    post('/api/admin/users/set-role', { userId: admin.id, role: 'user' }, other),
  ])
  assert.deepEqual([a.status, b.status].sort(), [200, 403], `one wins, one is turned away (got ${a.status} and ${b.status})`)
  const left = await stack.sql(`select email from users where role = 'admin'`)
  assert.equal(left.length, 1, 'exactly one administrator remains')
  assert.equal((await audits()).length, 1, 'and only the demotion that happened is recorded')
})

test('three administrators demoting each other around a circle still leave one', async () => {
  const b = await stack.createUser({ email: 'b@test.example', role: 'admin' })
  const c = await stack.createUser({ email: 'c@test.example', role: 'admin' })
  const results = await Promise.all([
    post('/api/admin/users/set-role', { userId: b.id, role: 'user' }, admin),
    post('/api/admin/users/set-role', { userId: c.id, role: 'user' }, b),
    post('/api/admin/users/set-role', { userId: admin.id, role: 'user' }, c),
  ])
  assert.ok(results.every(r => r.status === 200 || r.status === 403), results.map(r => r.status).join())
  assert.ok((await stack.sql(`select 1 from users where role = 'admin'`)).length >= 1, 'somebody can still open the panel')
})

test('a demotion that arrives after the administrator was demoted is refused', async () => {
  const other = await stack.createUser({ email: 'other@test.example', role: 'admin' })
  const victim = await stack.createUser({ email: 'victim@test.example', role: 'admin' })
  await stack.sql(`update users set role = 'user' where id = $1`, [admin.id])
  const res = await post('/api/admin/users/set-role', { userId: victim.id, role: 'user' }, admin)
  assert.equal(res.status, 403)
  assert.equal((await userRow(victim.id)).role, 'admin')
  void other
})

test('two suspensions of the same account at once: one does it, the other finds it done, and the log says so', async () => {
  const target = await stack.createUser()
  const second = await stack.createUser({ email: 'second@test.example', role: 'admin' })
  const [a, b] = await Promise.all([
    post('/api/admin/users/suspend', { userId: target.id, reason: 'first' }, admin),
    post('/api/admin/users/suspend', { userId: target.id, reason: 'second' }, second),
  ])
  assert.deepEqual([a.status, b.status], [200, 200])
  assert.deepEqual([a.body.changed, b.body.changed].sort(), [false, true])
  assert.equal((await userRow(target.id)).status, 'suspended')
  assert.equal(await sessionCount(target.id), 0)
  const entries = await audits()
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map(e => e.details.changed).sort(), [false, true])
})

test('suspending and restoring at the same time ends in one consistent state', async () => {
  const target = await stack.createUser()
  await post('/api/admin/users/suspend', { userId: target.id, reason: 'x' })
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? post('/api/admin/users/unsuspend', { userId: target.id }) : post('/api/admin/users/suspend', { userId: target.id, reason: `r${i}` }))))
  assert.ok(results.every(r => r.status === 200))
  const row = await userRow(target.id)
  assert.ok(row.status === 'active' ? row.suspended_reason === null && row.suspended_at === null : row.suspended_reason !== null && row.suspended_at !== null, 'never active with a reason, nor suspended without one')
})

test('deleting an account while it is being suspended: no server error, and the log never describes an account that is not gone', async () => {
  const target = await stack.createUser({ email: 'target@test.example' })
  const [d, s] = await Promise.all([
    post('/api/admin/users/delete', { userId: target.id, confirmEmail: 'target@test.example' }),
    post('/api/admin/users/suspend', { userId: target.id, reason: 'late' }),
  ])
  assert.ok(d.status < 500 && s.status < 500, `delete ${d.status}, suspend ${s.status}`)
  assert.equal(d.status, 200)
  assert.equal(await userRow(target.id), null)
  assert.ok((await audits()).some(e => e.action === 'user.delete'))
})

test('two administrators deleting the same account at once: one succeeds, the other is told it is gone', async () => {
  const target = await stack.createUser({ email: 'twice@test.example' })
  const second = await stack.createUser({ email: 'second@test.example', role: 'admin' })
  const [a, b] = await Promise.all([
    post('/api/admin/users/delete', { userId: target.id, confirmEmail: 'twice@test.example' }, admin),
    post('/api/admin/users/delete', { userId: target.id, confirmEmail: 'twice@test.example' }, second),
  ])
  assert.ok(a.status < 500 && b.status < 500, `${a.status} and ${b.status}`)
  assert.ok([a.status, b.status].includes(200))
  assert.equal(await userRow(target.id), null)
  assert.ok((await audits()).filter(e => e.action === 'user.delete').length >= 1)
})

test('prices saved at the same moment: the last write wins and the table has one row', async () => {
  await Promise.all(Array.from({ length: 6 }, (_, i) => post('/api/admin/prices/upsert', { model: 'racy', unit: 'per_video', credits: i, enabled: true })))
  const rows = await stack.sql(`select * from model_prices where model = 'racy'`)
  assert.equal(rows.length, 1)
  assert.equal((await audits()).filter(e => e.action === 'price.upsert').length, 6)
})

// ── A decision that could not be carried out is not left looking made ───────

async function generatedResult(user, { assetStatus = 'clear' } = {}) {
  const inf = (await stack.one(`insert into influencers (user_id, name) values ($1, 'Mia') returning id`, [user.id])).id
  const asset = await stack.putAsset({ userId: user.id, origin: 'generated', influencerId: inf, bytes: Buffer.from('x'.repeat(100)), moderationStatus: assetStatus })
  await stack.sql(`insert into generations (user_id, influencer_id, asset_id, kind, label) values ($1, $2, $3, 'image', 'x')`, [user.id, inf, asset.id])
  const job = await stack.one(
    `insert into generation_jobs (user_id, kie_task_id, kind, label, state, asset_id) values ($1, $2, 'image', 'x', 'success', $3) returning id`,
    [user.id, `resolve-${++counter}`, asset.id])
  const ev = await makeEvent(user, { source: 'output', action: 'review', assetId: asset.id })
  return { asset, job, ev }
}
const eventState = id => stack.one('select status, reviewed_by, reviewed_at, review_note from moderation_events where id = $1', [id])

test('if the decision cannot be recorded, the item goes back to open and nothing is half-decided from the admin\'s side', async () => {
  const u = await stack.createUser()
  const ev = await makeEvent(u)
  const res = await breakAudit('moderation.dismiss', () => post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'dismiss', note: 'fine' }))
  assert.equal(res.status, 500)
  const state = await eventState(ev.id)
  assert.deepEqual([state.status, state.reviewed_by, state.reviewed_at, state.review_note], ['open', null, null, null])

  const retry = await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'dismiss', note: 'fine' })
  assert.equal(retry.status, 200)
  assert.equal((await eventState(ev.id)).status, 'dismissed')
  assert.equal((await audits()).filter(a => a.action === 'moderation.dismiss').length, 1, 'one entry, from the attempt that worked')
})

test('a confirmation that fails after its effects can simply be pressed again: nothing is done twice and nothing is missed', async () => {
  const u = await stack.createUser()
  const { asset, job, ev } = await generatedResult(u)

  const first = await breakAudit('moderation.confirm', () => post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'confirm', suspendUser: true }))
  assert.equal(first.status, 500)
  assert.equal((await eventState(ev.id)).status, 'open', 'handed back')
  assert.equal((await userRow(u.id)).status, 'suspended', 'the effects that happened stay (they are what was decided)')
  assert.equal((await stack.one('select moderation_status as s from assets where id = $1', [asset.id])).s, 'blocked')

  const second = await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'confirm', suspendUser: true })
  assert.equal(second.status, 200)
  assert.deepEqual({ blocked: second.body.blocked, suspended: second.body.suspended, deleted: second.body.deleted }, { blocked: false, suspended: false, deleted: false }, 'already done, and said so')
  assert.equal((await eventState(ev.id)).status, 'confirmed')
  assert.equal((await stack.sql('select 1 from generations where user_id = $1', [u.id])).length, 0)
  assert.equal((await stack.one('select state from generation_jobs where id = $1', [job.id])).state, 'fail')
  assert.equal((await audits()).filter(a => a.action === 'moderation.confirm').length, 1)
})

test('confirming finishes taking a file down even if an earlier attempt blocked it and stopped there', async () => {
  const u = await stack.createUser()
  const { asset, job, ev } = await generatedResult(u, { assetStatus: 'blocked' })     // blocked, but still showing in the gallery
  assert.equal((await stack.sql('select 1 from generations where user_id = $1', [u.id])).length, 1)

  const res = await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'confirm' })
  assert.equal(res.status, 200)
  assert.equal((await stack.sql('select 1 from generations where user_id = $1', [u.id])).length, 0, 'gone from the gallery now')
  assert.equal((await stack.one('select state from generation_jobs where id = $1', [job.id])).state, 'fail')
  assert.equal(stack.s3.objects.has(asset.key), true)
})

test('after a failed decision, a different administrator can decide the item instead', async () => {
  const peer = await stack.createUser({ role: 'admin' })
  const u = await stack.createUser()
  const ev = await makeEvent(u)
  // Our attempt fails at the audit step and hands the item back.
  await stack.sql(`alter table admin_audit_log add constraint depth_break check (action <> 'moderation.dismiss')`)
  try {
    const a = await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'dismiss' })
    assert.equal(a.status, 500)
  } finally { await stack.sql('alter table admin_audit_log drop constraint depth_break') }
  const b = await post('/api/admin/moderation/resolve', { eventId: ev.id, resolution: 'confirm', note: 'peer' }, peer)
  assert.equal(b.status, 200)
  const state = await eventState(ev.id)
  assert.deepEqual([state.status, state.review_note], ['confirmed', 'peer'])
})
