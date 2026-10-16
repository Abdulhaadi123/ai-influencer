// Migration 002 against a database that already has data in it — the situation a
// deploy is actually in — and the constraints it adds.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

import { PGlite } from '@electric-sql/pglite'

const migrations = new URL('../../db/migrations/', import.meta.url)
const sql = name => readFileSync(new URL(name, migrations), 'utf8')

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

/** A database at migration 001 with a user, a file, a job and a gallery entry in it. */
async function legacyDatabase() {
  const db = await PGlite.create()
  await db.exec(sql('001_schema.sql'))
  await db.query(`insert into users (id, email, password_hash) values ($1, 'old@test.example', 'x'), ($2, 'other@test.example', 'x')`, [USER, OTHER])
  await db.query(
    `insert into assets (id, user_id, s3_key, kind, origin, byte_size)
     values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $1, 'users/old/a.jpg', 'image', 'generated', 100)`, [USER])
  await db.query(
    `insert into generation_jobs (user_id, kie_task_id, kind, state, asset_id)
     values ($1, 'old-task', 'image', 'success', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')`, [USER])
  return db
}

test('the migrations are numbered in order with no gaps', () => {
  const files = readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()
  assert.deepEqual(files, ['001_schema.sql', '002_moderation_admin.sql', '003_provider_refusals.sql', '004_admin_list_indexes.sql', '005_billing.sql', '006_sealed_uploads.sql'])
})

test('006 adds sealed_at to a live table without touching a row, and nothing needs backfilling', async () => {
  const db = await legacyDatabase()
  // A young upload as it stood before sealing existed, next to the generated file legacyDatabase made.
  await db.query(`insert into assets (user_id, s3_key, kind, origin, byte_size) values ($1, 'users/old/up.jpg', 'image', 'upload', 7)`, [USER])
  for (const file of ['002_moderation_admin.sql', '003_provider_refusals.sql', '004_admin_list_indexes.sql', '005_billing.sql', '006_sealed_uploads.sql']) await db.exec(sql(file))

  const column = (await db.query(`select data_type, is_nullable, column_default from information_schema.columns where table_name = 'assets' and column_name = 'sealed_at'`)).rows[0]
  assert.deepEqual(column, { data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null }, 'nullable and no default: applying it rewrites nothing')
  assert.deepEqual((await db.query('select count(*)::int as n from assets where sealed_at is not null')).rows[0], { n: 0 }, 'no row was marked by the migration')
  assert.equal((await db.query('select count(*)::int as n from assets')).rows[0].n, 2, 'and none was lost')
  await db.close()
})

test('002 applies on top of existing data and gives every old row a safe default', async () => {
  const db = await legacyDatabase()
  await db.exec(sql('002_moderation_admin.sql'))

  const users = (await db.query('select email, role, status, suspended_at, suspended_reason from users order by email')).rows
  assert.deepEqual(users.map(u => [u.role, u.status, u.suspended_at, u.suspended_reason]), [['user', 'active', null, null], ['user', 'active', null, null]],
    'nobody becomes an admin or gets suspended by a migration')

  const asset = (await db.query('select moderation_status, moderated_at from assets')).rows[0]
  assert.deepEqual([asset.moderation_status, asset.moderated_at], ['unchecked', null], 'existing files are checked on first use, not assumed clean')

  const job = (await db.query('select state, kie_credits from generation_jobs')).rows[0]
  assert.deepEqual([job.state, job.kie_credits], ['success', null], 'an old job\'s charge is unknown, not zero')
  await db.close()
})

test('the previous release keeps working against the new schema (nothing it writes is refused)', async () => {
  const db = await legacyDatabase()
  await db.exec(sql('002_moderation_admin.sql'))
  // Exactly the statements the old code ran: no new column named.
  await db.query(`insert into users (email, password_hash, display_name) values ('new@test.example', 'x', 'n')`)
  await db.query(`insert into assets (user_id, s3_key, kind, origin, byte_size) values ($1, 'users/old/b.jpg', 'image', 'upload', 5)`, [USER])
  await db.query(`insert into generation_jobs (user_id, kie_task_id, kind) values ($1, 'old-2', 'video')`, [USER])
  await db.query(`update generation_jobs set state = 'fail', fail_msg = 'x', completed_at = now() where kie_task_id = 'old-2'`)
  assert.equal((await db.query('select count(*)::int as n from assets')).rows[0].n, 2)
  await db.close()
})

test('every new constraint refuses what it should, and only that', async () => {
  const db = await legacyDatabase()
  await db.exec(sql('002_moderation_admin.sql'))
  const refuses = async (text, params, pattern) => {
    await assert.rejects(db.query(text, params), pattern, text)
  }

  await refuses(`update users set role = 'owner' where id = $1`, [USER], /users_role_check/)
  await refuses(`update users set status = 'banned' where id = $1`, [USER], /users_status_check/)
  await refuses(`update assets set moderation_status = 'maybe'`, [], /assets_moderation_status_check/)
  await refuses(`insert into moderation_events (user_id, source, action) values ($1, 'carrier-pigeon', 'blocked')`, [USER], /source_check/)
  await refuses(`insert into moderation_events (user_id, source, action) values ($1, 'prompt', 'shrugged')`, [USER], /action_check/)
  await refuses(`insert into moderation_events (user_id, source, action, status) values ($1, 'prompt', 'blocked', 'pending')`, [USER], /status_check/)
  await refuses(`insert into model_prices (model, unit) values ('m', 'per_century')`, [], /model_prices_unit_check/)
  await refuses(`insert into model_prices (model, credits) values ('m', -1)`, [], /model_prices_credits_check/)
  await refuses(`insert into moderation_events (user_id, source, action) values (gen_random_uuid(), 'prompt', 'blocked')`, [], /foreign key/)

  // …and accepts every documented value.
  for (const source of ['prompt', 'prompt_assist', 'image', 'video', 'output', 'report']) {
    await db.query(`insert into moderation_events (user_id, source, action) values ($1, $2, 'review')`, [USER, source])
  }
  for (const unit of ['per_second', 'per_video', 'per_image']) await db.query(`insert into model_prices (model, unit) values ($1, $2)`, [`m-${unit}`, unit])
  await db.query(`update users set role = 'admin' where id = $1`, [USER])
  await db.query(`update assets set moderation_status = 'blocked'`)
  await db.query(`update generation_jobs set kie_credits = 12.375`)
  assert.equal(Number((await db.query('select kie_credits from generation_jobs')).rows[0].kie_credits), 12.375)
  await db.close()
})

test('deleting what an event or an audit entry points at never deletes the record, except with the user', async () => {
  const db = await legacyDatabase()
  await db.exec(sql('002_moderation_admin.sql'))
  const ASSET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

  await db.query(`insert into moderation_events (id, user_id, source, action, asset_id) values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', $1, 'output', 'blocked', $2)`, [USER, ASSET])
  await db.query(`insert into admin_audit_log (admin_id, admin_email, action) values ($1, 'other@test.example', 'x')`, [OTHER])
  await db.query(`insert into model_prices (model, updated_by) values ('m', $1)`, [OTHER])

  // The file goes (a reviewer deleted it): the event stays, pointing at nothing.
  await db.query('delete from generation_jobs')
  await db.query('delete from assets')
  const ev = (await db.query('select asset_id from moderation_events')).rows
  assert.deepEqual(ev, [{ asset_id: null }])

  // An admin's account goes: the audit entry and the price stay.
  await db.query('delete from users where id = $1', [OTHER])
  assert.equal((await db.query('select admin_id, admin_email from admin_audit_log')).rows[0].admin_id, null)
  assert.equal((await db.query('select admin_email from admin_audit_log')).rows[0].admin_email, 'other@test.example', 'who it was is kept')
  assert.equal((await db.query('select updated_by from model_prices')).rows[0].updated_by, null)

  // The user's account goes: so does everything about them.
  await db.query('delete from users where id = $1', [USER])
  assert.equal((await db.query('select count(*)::int as n from moderation_events')).rows[0].n, 0)
  await db.close()
})

test('the indexes the queries rely on exist', async () => {
  const db = await legacyDatabase()
  await db.exec(sql('002_moderation_admin.sql'))
  const names = (await db.query(`select indexname from pg_indexes where schemaname = 'public'`)).rows.map(r => r.indexname)
  for (const wanted of [
    'users_suspended_idx', 'assets_unchecked_idx', 'jobs_settled_idx',
    'moderation_events_open_idx', 'moderation_events_user_idx', 'moderation_events_asset_idx', 'admin_audit_created_idx',
  ]) assert.ok(names.includes(wanted), wanted)
  await db.close()
})

test('a price\'s updated_at moves when it is edited', async () => {
  const db = await legacyDatabase()
  await db.exec(sql('002_moderation_admin.sql'))
  await db.query(`insert into model_prices (model, credits) values ('m', 1)`)
  await db.query(`update model_prices set updated_at = now() - interval '1 day' where model = 'm'`)
  await db.query(`update model_prices set credits = 2 where model = 'm'`)
  const age = (await db.query(`select extract(epoch from now() - updated_at) as s from model_prices`)).rows[0].s
  assert.ok(Number(age) < 60, 'the trigger refreshed it')
  await db.close()
})

test('the audit log numbers its entries and keeps them in order', async () => {
  const db = await legacyDatabase()
  await db.exec(sql('002_moderation_admin.sql'))
  for (const a of ['one', 'two', 'three']) await db.query(`insert into admin_audit_log (admin_email, action) values ('a@test.example', $1)`, [a])
  const rows = (await db.query('select id, action from admin_audit_log order by id')).rows
  assert.deepEqual(rows.map(r => r.action), ['one', 'two', 'three'])
  assert.ok(Number(rows[0].id) < Number(rows[1].id))
  await db.close()
})

test('004 adds the two newest-first indexes the admin lists read, and applying it twice changes nothing', async () => {
  const db = await legacyDatabase()
  await db.exec(sql('002_moderation_admin.sql'))
  await db.exec(sql('003_provider_refusals.sql'))
  await db.exec(sql('004_admin_list_indexes.sql'))
  await db.exec(sql('004_admin_list_indexes.sql'))   // a hand-built CONCURRENTLY index must make this a no-op, not an error
  const defs = Object.fromEntries((await db.query(`select indexname, indexdef from pg_indexes where schemaname = 'public'`)).rows.map(r => [r.indexname, r.indexdef]))
  assert.match(defs.users_created_idx, /\(created_at DESC, id\)/)
  assert.match(defs.jobs_created_idx, /\(created_at DESC, id\)/)
  assert.match(defs.users_created_idx, / ON public\.users /)
  assert.match(defs.jobs_created_idx, / ON public\.generation_jobs /)
  await db.close()
})

test('005 adds the credit tables on top of everything before it, seeds the three packs, and the ledger goes with the user', async () => {
  const db = await legacyDatabase()
  for (const file of ['002_moderation_admin.sql', '003_provider_refusals.sql', '004_admin_list_indexes.sql', '005_billing.sql']) await db.exec(sql(file))

  const packs = (await db.query('select product_id, credits::float8 as credits, enabled from credit_packs order by credits')).rows
  assert.deepEqual(packs, [
    { product_id: 'credits_500', credits: 500, enabled: true },
    { product_id: 'credits_1500', credits: 1500, enabled: true },
    { product_id: 'credits_5000', credits: 5000, enabled: true },
  ])
  const tables = (await db.query(`select tablename from pg_tables where schemaname = 'public'`)).rows.map(r => r.tablename)
  for (const wanted of ['credit_ledger', 'billing_events', 'credit_packs']) assert.ok(tables.includes(wanted), wanted)

  const { rows: [user] } = await db.query(`insert into users (email, password_hash) values ('a@x.test', 'x') returning id`)
  await db.query(`insert into credit_ledger (user_id, kind, delta, ref) values ($1, 'grant', 5, 'r1')`, [user.id])
  await assert.rejects(db.query(`insert into credit_ledger (user_id, kind, delta, ref) values ($1, 'grant', 5, 'r1')`, [user.id]), /unique|duplicate/i, 'a ref is written once')
  await db.query('delete from users where id = $1', [user.id])
  assert.equal((await db.query('select count(*)::int as n from credit_ledger')).rows[0].n, 0)
  await db.close()
})
