// The moderation machinery under stress: uploads checked in the background, the
// same file used twice at the same moment, strikes at their boundaries, and what a
// suspension does to every way back into the account.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack, jpeg } from '../helpers/stack.js'

let stack
before(async () => { stack = await startStack() })
after(async () => { await stack?.stop() })
beforeEach(async () => {
  await stack.reset()
  delete process.env.MODERATION_ENABLED
  delete process.env.MODERATION_FAIL_MODE
})

const confirm = (user, assetId) => stack.api('POST', '/api/storage/confirm', { token: user.token, body: { assetId } })
const statusOf = id => stack.one('select moderation_status as s from assets where id = $1', [id]).then(r => r.s)
const events = userId => stack.sql('select source, action, status, asset_id from moderation_events where user_id = $1 order by created_at, id', [userId])
const createTask = (token, input) => stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token, body: { model: 'kling-3.0/video', input } })
const userRow = id => stack.one('select status, suspended_reason from users where id = $1', [id])
const sessionCount = id => stack.one('select count(*)::int as n from sessions where user_id = $1', [id]).then(r => r.n)
const upload = (user, marker) => stack.putAsset({ userId: user.id, bytes: jpeg(marker) })
const earlierStrikes = (user, n) => stack.sql(
  `insert into moderation_events (user_id, source, action, categories, created_at)
   select $1, 'prompt', 'blocked', '{sexual}', now() - (g * 5) * interval '1 minute' from generate_series(1, $2) g`,
  [user.id, n],
)

// ── Uploads are checked in the background ───────────────────────────────────

test('confirming an upload answers at once; the check follows, and a clean file is marked clear', async () => {
  // The checker is slow on purpose; the answer must come well before it could have finished. The margin is wide
  // because a loaded machine (a virus scanner, a parallel build) can make an ordinary request take half a second.
  stack.openai.mode.delayMs = 1500
  const u = await stack.createUser()
  const a = await upload(u, 'IMG-OK')
  const started = Date.now()
  const res = await confirm(u, a.id)
  assert.equal(res.status, 200)
  assert.ok(Date.now() - started < 1000, 'the app does not wait for the check')
  assert.equal(res.body.byteSize, Number((await stack.one('select byte_size from assets where id = $1', [a.id])).byte_size))
  assert.equal(await statusOf(a.id), 'unchecked', 'not yet')
  await stack.waitFor(async () => (await statusOf(a.id)) === 'clear', { what: 'the upload to be checked' })
  assert.deepEqual(await events(u.id), [])
})

test('a refused upload is blocked, recorded and counted as a strike — before it is ever used', async () => {
  const u = await stack.createUser()
  const a = await upload(u, 'IMG-EXPLICIT')
  await confirm(u, a.id)
  await stack.waitFor(async () => (await statusOf(a.id)) === 'blocked', { what: 'the block' })
  const [e] = await events(u.id)
  assert.deepEqual({ source: e.source, action: e.action, status: e.status, asset: e.asset_id }, { source: 'image', action: 'blocked', status: 'open', asset: a.id })
  const { countStrikes } = await stack.load('api/_lib/moderation/events.js')
  assert.equal(await countStrikes(u.id, 30), 1)

  const use = await createTask(u.token, { prompt: 'fine', image_urls: [a.url] })
  assert.equal(use.status, 400)
  assert.equal(use.body.code, 'CONTENT_BLOCKED')
  assert.equal((await events(u.id)).length, 1, 'using it afterwards adds nothing')
})

test('the upload that reaches the strike limit suspends the account by itself', async () => {
  const u = await stack.createUser()
  await earlierStrikes(u, 4)
  const a = await upload(u, 'IMG-EXPLICIT')
  await confirm(u, a.id)
  await stack.waitFor(async () => (await userRow(u.id)).status === 'suspended', { what: 'the suspension' })
  assert.match((await userRow(u.id)).suspended_reason, /5 content refusals in 30 days/)
  assert.equal(await sessionCount(u.id), 0)
})

test('a borderline upload is cleared and put in front of a person, with no strike', async () => {
  const u = await stack.createUser()
  const a = await upload(u, 'IMG-BORDER')
  await confirm(u, a.id)
  await stack.waitFor(async () => (await statusOf(a.id)) === 'clear')
  const [e] = await events(u.id)
  assert.equal(e.action, 'review')
  const { countStrikes } = await stack.load('api/_lib/moderation/events.js')
  assert.equal(await countStrikes(u.id, 30), 0)
})

test('an administrator cannot confirm an upload through the app, and strikes never suspend one', async () => {
  const admin = await stack.createUser({ role: 'admin' })
  const a = await upload(admin, 'IMG-EXPLICIT')
  assert.equal((await confirm(admin, a.id)).status, 401, 'an admin session is a panel session, not an app one')
  assert.equal(await statusOf(a.id), 'unchecked', 'so nothing was checked, recorded or counted')

  // The rule underneath (applyEnforcement): however many strikes an administrator has, they are not suspended.
  await earlierStrikes(admin, 6)
  const { applyEnforcement } = await stack.load('api/_lib/moderation/events.js')
  const { moderationConfig } = await stack.load('api/_lib/moderation/config.js')
  assert.equal((await applyEnforcement(admin.id, { config: moderationConfig() })).suspended, false)
  assert.equal((await userRow(admin.id)).status, 'active')
})

test('confirming twice does not check twice or record twice', async () => {
  const u = await stack.createUser()
  const a = await upload(u, 'IMG-EXPLICIT')
  await confirm(u, a.id)
  await stack.waitFor(async () => (await statusOf(a.id)) === 'blocked')
  const calls = stack.openai.requests.length
  assert.equal((await confirm(u, a.id)).status, 200)
  await new Promise(r => setTimeout(r, 200))
  assert.equal(stack.openai.requests.length, calls, 'the answer was kept')
  assert.equal((await events(u.id)).length, 1)
})

test('confirming: someone else\'s file, an unknown file and a bad id are refused — and nothing is checked', async () => {
  const owner = await stack.createUser(); const other = await stack.createUser()
  const a = await upload(owner, 'IMG-EXPLICIT')
  assert.equal((await confirm(other, a.id)).status, 404)
  assert.equal((await confirm(owner, '00000000-0000-4000-8000-000000000000')).status, 404)
  for (const bad of [undefined, null, '', 'nope', 5, ['x'], { a: 1 }]) assert.equal((await confirm(owner, bad)).status, 400, JSON.stringify(bad))
  assert.equal((await stack.api('POST', '/api/storage/confirm', {})).status, 401)
  await new Promise(r => setTimeout(r, 150))
  assert.equal(stack.openai.requests.length, 0)
  assert.equal(await statusOf(a.id), 'unchecked')
})

test('confirming a file that never arrived is a clear "try again", not a crash', async () => {
  const u = await stack.createUser()
  const a = await upload(u, 'IMG-OK')
  stack.s3.objects.delete(a.key)
  const res = await confirm(u, a.id)
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'UPLOAD_INCOMPLETE')
})

test('when the checker is down the upload still confirms, stays unchecked, and is checked on first use', async () => {
  const u = await stack.createUser()
  const a = await upload(u, 'IMG-OK')
  stack.openai.mode.status = 500
  assert.equal((await confirm(u, a.id)).status, 200)
  await new Promise(r => setTimeout(r, 400))
  assert.equal(await statusOf(a.id), 'unchecked')
  assert.deepEqual(await events(u.id), [])

  stack.openai.mode.status = null
  const use = await createTask(u.token, { prompt: 'fine', image_urls: [a.url] })
  assert.equal(use.status, 200)
  assert.equal(await statusOf(a.id), 'clear')
})

test('with moderation off, confirming does not ask the classifier anything', async () => {
  process.env.MODERATION_ENABLED = 'false'
  const u = await stack.createUser()
  const a = await upload(u, 'IMG-EXPLICIT')
  assert.equal((await confirm(u, a.id)).status, 200)
  await new Promise(r => setTimeout(r, 250))
  assert.equal(stack.openai.requests.length, 0)
  assert.equal(await statusOf(a.id), 'unchecked')
})

test('a burst of uploads is checked at most three at a time; the rest wait for their first use', async () => {
  stack.openai.mode.delayMs = 500
  const u = await stack.createUser()
  const files = await Promise.all(Array.from({ length: 8 }, () => upload(u, 'IMG-OK')))
  const answers = await Promise.all(files.map(f => confirm(u, f.id)))
  assert.ok(answers.every(r => r.status === 200), 'every upload confirmed')
  await stack.waitFor(async () => stack.openai.inflight === 0 && stack.openai.requests.length > 0, { what: 'the checks to finish' })
  await new Promise(r => setTimeout(r, 150))
  assert.ok(stack.openai.maxInflight <= 3, `at most three at once (saw ${stack.openai.maxInflight})`)
  const states = await Promise.all(files.map(f => statusOf(f.id)))
  assert.ok(states.includes('clear'), 'some were checked')
  assert.ok(states.includes('unchecked'), 'the others were left for their first use')

  // …and each of those is checked the moment it is used.
  stack.openai.mode.delayMs = 0
  const waiting = files[states.indexOf('unchecked')]
  assert.equal((await createTask(u.token, { prompt: 'fine', image_urls: [waiting.url] })).status, 200)
  assert.equal(await statusOf(waiting.id), 'clear')
})

// ── The same file, used at the same moment ──────────────────────────────────

test('one refused file used by several requests at once: one event, one strike, every request refused', async () => {
  const u = await stack.createUser()
  const a = await upload(u, 'IMG-EXPLICIT')
  const out = await Promise.all(Array.from({ length: 5 }, () => createTask(u.token, { prompt: 'fine', image_urls: [a.url] })))
  assert.ok(out.every(r => r.status === 400 && r.body.code === 'CONTENT_BLOCKED'), out.map(r => r.status).join())
  assert.equal(await statusOf(a.id), 'blocked')
  assert.equal((await events(u.id)).length, 1, 'recorded once')
  const { countStrikes } = await stack.load('api/_lib/moderation/events.js')
  assert.equal(await countStrikes(u.id, 30), 1)
  assert.equal(stack.kie.requests.filter(r => r.path === '/api/v1/jobs/createTask').length, 0, 'none reached KIE')
})

test('one clean file used by several requests at once: all go through, nothing is recorded', async () => {
  const u = await stack.createUser()
  const a = await upload(u, 'IMG-OK')
  const out = await Promise.all(Array.from({ length: 5 }, () => createTask(u.token, { prompt: 'fine', image_urls: [a.url] })))
  assert.ok(out.every(r => r.status === 200))
  assert.equal(await statusOf(a.id), 'clear')
  assert.deepEqual(await events(u.id), [])
})

test('a request naming a clean file and a refused one is refused, and only the refused one is recorded', async () => {
  const u = await stack.createUser()
  const good = await upload(u, 'IMG-OK'); const bad = await upload(u, 'IMG-EXPLICIT')
  const res = await createTask(u.token, { prompt: 'fine', image_urls: [good.url, bad.url] })
  assert.equal(res.status, 400)
  assert.equal((await events(u.id)).length, 1)
  assert.equal(await statusOf(good.id), 'clear')
  assert.equal(await statusOf(bad.id), 'blocked')
})

// ── Strikes at the limit and at their edges ─────────────────────────────────

test('several refusals at the moment the limit is reached: suspended exactly once, every session gone, every request refused', async () => {
  const u = await stack.createUser()
  const bystander = await stack.createUser()
  await earlierStrikes(u, 4)
  const out = await Promise.all(Array.from({ length: 4 }, (_, i) => createTask(u.token, { prompt: `XXX-EXPLICIT variant ${i}` })))
  assert.ok(out.every(r => r.status === 400 || r.status === 403), out.map(r => r.status).join())
  assert.ok(out.some(r => r.status === 403 && r.body.code === 'ACCOUNT_SUSPENDED'), 'at least one was told why')
  const row = await userRow(u.id)
  assert.equal(row.status, 'suspended')
  assert.match(row.suspended_reason, /content refusals in 30 days/)
  assert.equal(await sessionCount(u.id), 0)
  assert.equal(await sessionCount(bystander.id), 1, 'nobody else is touched')
  assert.equal(stack.kie.requests.length, 0)
})

test('a suspended account\'s next request is refused before anything is classified or sent', async () => {
  const u = await stack.createUser()
  await stack.sql(`update users set status = 'suspended' where id = $1`, [u.id])
  const res = await createTask(u.token, { prompt: 'a calm lake' })
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'ACCOUNT_SUSPENDED')
  assert.equal(stack.openai.requests.length, 0)
  assert.equal(stack.kie.requests.length, 0)
})

test('the strike window is exact: inside by an hour counts, outside by an hour does not — and a shorter window is respected', async () => {
  const { countStrikes } = await stack.load('api/_lib/moderation/events.js')
  const u = await stack.createUser()
  const at = interval => stack.sql(`insert into moderation_events (user_id, source, action, created_at) values ($1, 'prompt', 'blocked', now() - interval '${interval}')`, [u.id])
  await at('29 days 23 hours'); await at('30 days 1 hour')
  assert.equal(await countStrikes(u.id, 30), 1)
  assert.equal(await countStrikes(u.id, 31), 2)
  assert.equal(await countStrikes(u.id, 1), 0)
  assert.equal(await countStrikes(u.id, 29), 0)
})

test('strikes are counted per clock minute: two refusals a second apart across a minute boundary are two; inside one minute, one', async () => {
  const { countStrikes } = await stack.load('api/_lib/moderation/events.js')
  const u = await stack.createUser()
  const at = expr => stack.sql(`insert into moderation_events (user_id, source, action, created_at) values ($1, 'prompt', 'blocked', ${expr})`, [u.id])
  const boundary = `date_trunc('minute', now()) - interval '10 minutes'`
  await at(`${boundary} - interval '1 second'`); await at(boundary)
  assert.equal(await countStrikes(u.id, 30), 2, 'a known property of counting by minute')
  await at(`${boundary} + interval '1 second'`); await at(`${boundary} + interval '59 seconds'`)
  assert.equal(await countStrikes(u.id, 30), 2, 'everything else in that minute is the same single mistake')
})

test('only what the person submitted can be a strike: results, suggestions and reports are not', async () => {
  const { countStrikes } = await stack.load('api/_lib/moderation/events.js')
  const u = await stack.createUser()
  for (const [i, source] of ['output', 'prompt_assist', 'report'].entries()) {
    await stack.sql(`insert into moderation_events (user_id, source, action, created_at) values ($1, $2, 'blocked', now() - $3::int * interval '10 minutes')`, [u.id, source, i + 1])
  }
  assert.equal(await countStrikes(u.id, 30), 0)
  for (const [i, source] of ['prompt', 'image', 'video'].entries()) {
    await stack.sql(`insert into moderation_events (user_id, source, action, created_at) values ($1, $2, 'blocked', now() - $3::int * interval '10 minutes')`, [u.id, source, i + 5])
  }
  assert.equal(await countStrikes(u.id, 30), 3)
})

test('restoring an account does not wipe its strikes: at the limit, the next refusal suspends it again unless the items were dismissed', async () => {
  const admin = await stack.createUser({ role: 'admin' })
  const u = await stack.createUser()
  await earlierStrikes(u, 5)
  await stack.sql(`update users set status = 'suspended', suspended_at = now(), suspended_reason = 'limit' where id = $1`, [u.id])
  assert.equal((await stack.api('POST', '/api/admin/users/unsuspend', { token: admin.token, body: { userId: u.id } })).status, 200)
  const fresh = await stack.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } })
  assert.equal(fresh.status, 200, 'they can sign in again')

  const again = await createTask(fresh.body.session.accessToken, { prompt: 'XXX-EXPLICIT once more' })
  assert.equal(again.status, 403, 'still at the limit')
  assert.equal((await userRow(u.id)).status, 'suspended')

  // Dismissing the earlier items is how an admin gives the strikes back.
  await stack.api('POST', '/api/admin/users/unsuspend', { token: admin.token, body: { userId: u.id } })
  await stack.sql(`update moderation_events set status = 'dismissed' where user_id = $1`, [u.id])
  const login = await stack.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } })
  const third = await createTask(login.body.session.accessToken, { prompt: 'XXX-EXPLICIT third' })
  assert.equal(third.status, 400, 'a fresh start: refused, not suspended')
  assert.equal((await userRow(u.id)).status, 'active')
})

// ── A suspension closes every way in ────────────────────────────────────────

test('sign-in for a suspended account: the right password is told why, a wrong password or unknown address is not', async () => {
  const u = await stack.createUser({ email: 'gone@test.example' })
  await stack.sql(`update users set status = 'suspended' where id = $1`, [u.id])
  const before = await sessionCount(u.id)
  const right = await stack.api('POST', '/api/auth/login', { body: { email: 'gone@test.example', password: u.password } })
  assert.equal(right.status, 403)
  assert.equal(right.body.code, 'ACCOUNT_SUSPENDED')
  const wrong = await stack.api('POST', '/api/auth/login', { body: { email: 'gone@test.example', password: 'not-the-password' } })
  const nobody = await stack.api('POST', '/api/auth/login', { body: { email: 'nobody@test.example', password: 'not-the-password' } })
  assert.equal(wrong.status, 401)
  assert.equal(nobody.status, 401)
  assert.deepEqual(wrong.body, nobody.body, 'a guesser learns nothing about which addresses exist or are suspended')
  assert.equal(await sessionCount(u.id), before, 'and no session was created')
})

test('a session created in the instant before a suspension is useless: its token is refused and its refresh token is rejected', async () => {
  const u = await stack.createUser()
  const sessions = await stack.load('api/_lib/sessions.js')
  await stack.sql(`update users set status = 'suspended' where id = $1`, [u.id])
  const late = await sessions.createSession({ id: u.id, email: u.email, display_name: 'x', email_confirmed_at: new Date() })   // the login that was in flight

  const asUser = await stack.api('GET', '/api/auth/me', { token: late.accessToken })
  assert.equal(asUser.status, 403)
  assert.equal(asUser.body.code, 'ACCOUNT_SUSPENDED')
  const refreshed = await stack.api('POST', '/api/auth/refresh', { body: { refreshToken: late.refreshToken } })
  assert.equal(refreshed.status, 401)
  assert.equal(stack.kie.requests.length, 0)
})

test('suspended accounts cannot reach any of the routes a signed-in person can', async () => {
  const u = await stack.createUser()
  await stack.sql(`update users set status = 'suspended' where id = $1`, [u.id])
  const calls = [
    ['GET', '/api/auth/me'], ['GET', '/api/jobs'], ['GET', '/api/influencers'], ['POST', '/api/prompt-assist', { text: 'a calm lake' }],
    ['POST', '/api/storage/confirm', { assetId: '00000000-0000-4000-8000-000000000000' }], ['GET', '/api/kie/api/v1/chat/credit'],
    ['POST', '/api/reports', { generationId: '00000000-0000-4000-8000-000000000000', reason: 'other' }],
  ]
  for (const [method, path, body] of calls) {
    const res = await stack.api(method, path, { token: u.token, body })
    assert.equal(res.status, 403, `${method} ${path} answered ${res.status}`)
    assert.equal(res.body?.code, 'ACCOUNT_SUSPENDED', `${method} ${path}`)
  }
})

test('restoring ends the suspension but not the old sessions: they were removed, and signing in is the way back', async () => {
  const admin = await stack.createUser({ role: 'admin' })
  const u = await stack.createUser()
  assert.equal((await stack.api('POST', '/api/admin/users/suspend', { token: admin.token, body: { userId: u.id, reason: 'spam' } })).status, 200)
  assert.equal((await stack.api('GET', '/api/auth/me', { token: u.token })).status, 401)
  await stack.api('POST', '/api/admin/users/unsuspend', { token: admin.token, body: { userId: u.id } })
  assert.equal((await stack.api('GET', '/api/auth/me', { token: u.token })).status, 401, 'the old token stays dead')
  assert.equal((await stack.api('POST', '/api/auth/refresh', { body: { refreshToken: u.refreshToken } })).status, 401)
  const login = await stack.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } })
  assert.equal(login.status, 200)
  assert.equal((await stack.api('GET', '/api/auth/me', { token: login.body.session.accessToken })).status, 200)
})

test('what the app is told about its own account never includes its role or status', async () => {
  const admin = await stack.createUser({ role: 'admin' })
  const res = await stack.api('GET', '/api/auth/me', { token: admin.token })
  assert.equal(res.status, 200)
  assert.ok(!('role' in res.body.user) && !('status' in res.body.user))
  assert.ok(!/admin|suspend/i.test(JSON.stringify(res.body.user)))
})
