/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Database migrations.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Applies every `migrations/*.sql` file not applied yet, in name order, each in
 * its own transaction, and records it in `schema_migrations`. The API runs this
 * on start (server/index.js), so deploying a schema change is deploying the
 * code. Run it by hand with `npm run migrate`.
 *
 * An advisory lock serialises it: the API and the worker start together, and
 * two processes applying the same migration at once would collide.
 *
 * Never edit a migration that has been applied anywhere — add a new file.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { db, closeDb } from '../api/_lib/db.js'

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

/** Any constant works; it only has to be the same for every process. */
const LOCK_KEY = 815_462_001

export async function migrate({ log = console.log } = {}) {
  const client = await db().connect()
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY])
    await client.query(`
      create table if not exists schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `)

    const { rows } = await client.query('select name from schema_migrations')
    const applied = new Set(rows.map(r => r.name))
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort()

    for (const file of files) {
      if (applied.has(file)) continue
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into schema_migrations (name) values ($1)', [file])
        await client.query('commit')
        log(`[migrate] applied ${file}`)
      } catch (e) {
        await client.query('rollback').catch(() => {})
        throw new Error(`Migration ${file} failed: ${e.message}`)
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {})
    client.release()
  }
}

// `node db/migrate.js`
const entry = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : ''
if (entry && entry === fileURLToPath(import.meta.url).toLowerCase()) {
  migrate()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch(e => { console.error(e.message); process.exit(1) })
}
