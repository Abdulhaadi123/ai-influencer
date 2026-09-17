/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The database connection.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One pool for the process. Only the backend talks to Postgres — the app never
 * connects to it — so every query here runs as trusted code, and ownership is
 * enforced by the queries themselves: anything touching user data carries the
 * verified user id from the session (api/_lib/auth.js), never one from the
 * request.
 *
 * Note for readers of results: `bigint` columns (byte_size, sums of it) arrive
 * as strings, because a JavaScript number cannot hold every bigint. Wrap them in
 * Number() where a count is expected.
 */

import pg from 'pg'

let pool = null

export function db() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set on the server.')
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DATABASE_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      // A database that cannot be reached should fail a request in seconds,
      // not hang it until the client gives up.
      connectionTimeoutMillis: 5_000,
    })
    // An idle client losing its connection must not crash the process.
    pool.on('error', e => console.error('[db] idle connection error:', e.message))
  }
  return pool
}

export function query(text, params) {
  return db().query(text, params)
}

/** The first row, or null. */
export async function one(text, params) {
  const { rows } = await db().query(text, params)
  return rows[0] ?? null
}

export async function many(text, params) {
  const { rows } = await db().query(text, params)
  return rows
}

/**
 * Run `fn(client)` inside a transaction: committed if it returns, rolled back
 * if it throws. Use the client it is given for every query that must be part of
 * the transaction — a query on the pool runs outside it.
 */
export async function transaction(fn) {
  const client = await db().connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export async function closeDb() {
  if (pool) {
    const closing = pool
    pool = null
    await closing.end()
  }
}
