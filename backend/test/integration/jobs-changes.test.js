// GET /api/jobs/changes — what every open app asks every few seconds.
// It had no test; these pin what the app depends on before and after its queries were merged.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack } from '../helpers/stack.js'

let stack
before(async () => { stack = await startStack({}) })
after(async () => { await stack?.stop() })
beforeEach(() => stack.reset())

let n = 0
/** A job whose last change was `updatedAgo` ago (insert may set updated_at; only an UPDATE fires the stamping trigger). */
async function job(user, { state = 'waiting', updatedAgo = '0 seconds' } = {}) {
  const row = await stack.one(
    `insert into generation_jobs (user_id, kie_task_id, kind, label, model, state, created_at, updated_at)
     values ($1, $2, 'image', 'Image', 'nano-banana-pro', $3, now() - interval '1 hour', now() - $4::interval) returning id`,
    [user.id, `chg-${++n}`, state, updatedAgo],
  )
  return row.id
}
const changes = (user, since) => stack.api('GET', `/api/jobs/changes${since ? `?since=${encodeURIComponent(since)}` : ''}`, { token: user.token })

test('the first call only sets the starting point: a cursor and the running count, no rows', async () => {
  const u = await stack.createUser()
  await job(u, { state: 'generating' })
  await job(u, { state: 'success' })
  const res = await changes(u)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.jobs, [])
  assert.equal(res.body.activeCount, 1)
  assert.ok(!Number.isNaN(new Date(res.body.cursor).getTime()), 'the cursor is a time')
})

test('the cursor sits about five seconds in the past, so a change committed as it was taken is not missed', async () => {
  const u = await stack.createUser()
  const before = Date.now()
  const { body } = await changes(u)
  const lag = before - new Date(body.cursor).getTime()
  assert.ok(lag > 3_000 && lag < 15_000, `cursor lag was ${lag} ms`)
})

test('with a cursor: only this account\'s rows changed since, oldest change first', async () => {
  const u = await stack.createUser()
  const stranger = await stack.createUser()
  const old = await job(u, { updatedAgo: '10 minutes' })
  const a = await job(u, { updatedAgo: '30 seconds' })
  const b = await job(u, { updatedAgo: '10 seconds' })
  await job(stranger, { updatedAgo: '5 seconds' })

  const since = new Date(Date.now() - 60_000).toISOString()
  const res = await changes(u, since)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.jobs.map(j => j.id), [a, b], 'the old one and the stranger\'s are not included, and the order is by change time')
  assert.ok(!res.body.jobs.some(j => j.id === old))
})

test('the running count is the account\'s own and counts only waiting, queued and generating jobs', async () => {
  const u = await stack.createUser()
  const stranger = await stack.createUser()
  for (const state of ['waiting', 'queuing', 'generating', 'success', 'fail']) await job(u, { state })
  await job(stranger, { state: 'generating' })
  assert.equal((await changes(u)).body.activeCount, 3)
  assert.equal((await changes(stranger)).body.activeCount, 1)
})

test('what comes back for a job is what the app needs and nothing of the studio\'s cost', async () => {
  const u = await stack.createUser()
  const id = await job(u, { state: 'success', updatedAgo: '5 seconds' })
  await stack.sql(`update generation_jobs set kie_credits = 60 where id = $1`, [id])
  const res = await changes(u, new Date(Date.now() - 60_000).toISOString())
  const row = res.body.jobs.find(j => j.id === id)
  assert.ok(row, 'the row is there')
  assert.ok(!('kie_credits' in row))
  for (const key of ['id', 'kie_task_id', 'kind', 'label', 'model', 'state', 'asset_id', 'fail_msg', 'created_at', 'updated_at']) assert.ok(key in row, key)
})

test('at most 200 rows in one answer', async () => {
  const u = await stack.createUser()
  await stack.sql(
    `insert into generation_jobs (user_id, kie_task_id, kind, label, state)
     select $1, 'bulk-' || g, 'image', 'Image', 'success' from generate_series(1, 230) g`, [u.id])
  const res = await changes(u, new Date(Date.now() - 60_000).toISOString())
  assert.equal(res.body.jobs.length, 200)
})

test('a time that is not a time is refused, and a stranger gets nothing', async () => {
  const u = await stack.createUser()
  assert.equal((await changes(u, 'not-a-date')).status, 400)
  assert.equal((await stack.api('GET', '/api/jobs/changes')).status, 401)
})

/** The statements one call to /changes puts to the database, apart from checking who is asking. */
async function statementsFor(user, since) {
  const { db } = await stack.load('api/_lib/db.js')
  const pool = db()
  const seen = []
  const original = pool.query.bind(pool)
  pool.query = (text, ...rest) => { seen.push(String(text?.text ?? text)); return original(text, ...rest) }
  try { await changes(user, since) } finally { pool.query = original }
  return seen.filter(t => !/sessions/i.test(t)).map(t => t.replace(/s+/g, ' ').slice(0, 60))
}

test('it is cheap: a poll with a cursor is two queries, and the first poll (which reads no rows) is one', async () => {
  const u = await stack.createUser()
  const withCursor = await statementsFor(u, new Date(Date.now() - 60_000).toISOString())
  assert.equal(withCursor.length, 2, JSON.stringify(withCursor))
  const first = await statementsFor(u)
  assert.equal(first.length, 1, JSON.stringify(first))
})

// ── GET /api/jobs?active=1 — what the app's half-minute background sync asks for ─────────

const list = (user, qs = '') => stack.api('GET', `/api/jobs${qs}`, { token: user.token })

test('active=1 returns only the running jobs, newest first, and only this account\'s', async () => {
  const u = await stack.createUser()
  const stranger = await stack.createUser()
  const a = await job(u, { state: 'waiting' })
  const b = await job(u, { state: 'generating' })
  await job(u, { state: 'success' })
  await job(u, { state: 'fail' })
  await job(stranger, { state: 'generating' })

  const res = await list(u, '?active=1')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.jobs.map(j => j.id).sort(), [a, b].sort())
  assert.ok(res.body.jobs.every(j => ['waiting', 'queuing', 'generating'].includes(j.state)))
})

test('with nothing running the answer is empty — a few bytes, not sixty jobs', async () => {
  const u = await stack.createUser()
  for (let i = 0; i < 12; i++) await job(u, { state: 'success' })
  const everything = await list(u)
  const running = await list(u, '?active=1')
  assert.equal(everything.body.jobs.length, 12, 'the plain list is unchanged')
  assert.deepEqual(running.body.jobs, [])
})

test('without active=1 the list is exactly what it was: every state, newest first, limit honoured', async () => {
  const u = await stack.createUser()
  await job(u, { state: 'success' })
  await job(u, { state: 'generating' })
  await job(u, { state: 'fail' })
  assert.equal((await list(u)).body.jobs.length, 3)
  assert.equal((await list(u, '?limit=2')).body.jobs.length, 2)
  assert.equal((await list(u, '?active=0')).body.jobs.length, 3, 'only 1 or true switches the filter on')
  assert.equal((await list(u, '?active=1&limit=1')).body.jobs.length, 1)
})
