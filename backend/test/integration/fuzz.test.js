// Hostile and malformed input against every endpoint this work added.
//
// The one rule: a request that is wrong is answered as wrong (a 4xx with a message),
// never with a server error. A 500 here means a type, a character or a length that
// reached the database or the code unchecked — and a 500 on an admin or moderation
// route is exactly what someone probing for a way in would be looking for.
//
// Each endpoint gets every field set, one at a time, to every hostile value; whole
// bodies of the wrong shape; and a body that is not JSON at all. Afterwards the
// database must still be intact.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack, jpeg } from '../helpers/stack.js'

let stack
let admin, victim
let ids

before(async () => { stack = await startStack() })
after(async () => { await stack?.stop() })
beforeEach(async () => {
  failures.length = 0
  await stack.reset()
  admin = await stack.createUser({ email: 'boss@test.example', role: 'admin' })
  victim = await stack.createUser({ email: 'victim@test.example' })
  const asset = await stack.putAsset({ userId: victim.id, bytes: jpeg('IMG-OK'), moderationStatus: 'clear' })
  const event = await stack.one(`insert into moderation_events (user_id, source, action, asset_id) values ($1, 'image', 'review', $2) returning id`, [victim.id, asset.id])
  const inf = await stack.one(`insert into influencers (user_id, name) values ($1, 'Mia') returning id`, [victim.id])
  const gen = await stack.one(`insert into generations (user_id, influencer_id, asset_id, kind, label) values ($1, $2, $3, 'image', 'x') returning id`, [victim.id, inf.id, asset.id])
  ids = { user: victim.id, event: event.id, generation: gen.id }
})

/** Values a client could send in place of a sensible one. */
const HOSTILE = [
  null, true, false, 0, -1, 1.5, 1e308, -1e308, 2 ** 53,
  '', ' ', '   \t\n ', 'x', 'x'.repeat(20_000),
  '\u0000', 'a\u0000b', '\u0000'.repeat(50),
  "'; drop table users; --", "' or '1'='1", '"; select pg_sleep(5); --',
  '%', '_', '\\', '%_\\', '\\u0000',
  '😀', '\ud800', '‮', 'ünïcödé', '\r\nX-Injected: 1',
  '../../etc/passwd', '<script>alert(1)</script>', '${process.exit(1)}', '{{7*7}}',
  'constructor', '__proto__', 'toString', 'hasOwnProperty',
  [], [1, 2, 3], ['a', 'b'], [[]], [{}], {}, { a: 1 }, { toString: 'x' }, { __proto__: { admin: true } }, { length: 5 },
  '00000000-0000-4000-8000-000000000000', 'not-a-uuid', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
]

const failures = []
function check(label, res) {
  if (res.status >= 500) failures.push(`${res.status}  ${label}  → ${String(res.text).slice(0, 140)}`)
  else if (res.status >= 400 && !(res.body && typeof res.body.error === 'string' && typeof res.body.code === 'string')) {
    failures.push(`${res.status} without a { error, code } body  ${label}  → ${String(res.text).slice(0, 100)}`)
  }
}

const qsOf = params => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    if (Array.isArray(v)) for (const item of v) p.append(k, typeof item === 'object' ? JSON.stringify(item) : String(item))
    else p.append(k, typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** The same values for a URL: Node refuses a request line past ~16 KB itself (431), before the app is involved. */
const FOR_URL = HOSTILE.map(v => (typeof v === 'string' && v.length > 5000 ? v.slice(0, 5000) : v))

const label = v => JSON.stringify(v)?.slice(0, 60) ?? String(v)

// ── GET ──────────────────────────────────────────────────────────────────────

const GETS = () => [
  ['/api/admin/stats', {}],
  ['/api/admin/usage', { days: 30 }],
  ['/api/admin/audit', { page: 1, pageSize: 10, action: 'user.', admin: 'boss' }],
  ['/api/admin/config', {}],
  ['/api/admin/users', { q: 'victim', status: 'active', sort: 'created', dir: 'desc', page: 1, pageSize: 10 }],
  ['/api/admin/users/detail', { userId: ids.user }],
  ['/api/admin/jobs', { state: 'success', model: 'kling-3.0/video', userId: ids.user, q: 'task', page: 1, pageSize: 10 }],
  ['/api/admin/moderation', { status: 'open', source: 'image', action: 'review', userId: ids.user, page: 1, pageSize: 10 }],
  ['/api/admin/moderation/media', { eventId: ids.event }],
  ['/api/admin/prices', {}],
  ['/api/admin/billing/ledger', { userId: ids.user, page: 1, pageSize: 10 }],
]

test('GET: every parameter of every admin read survives every hostile value', async () => {
  for (const [path, base] of GETS()) {
    for (const [name] of Object.entries(base)) {
      for (const value of FOR_URL) {
        const res = await stack.api('GET', `${path}${qsOf({ ...base, [name]: value })}`, { token: admin.token })
        check(`GET ${path} ${name}=${label(value)}`, res)
      }
    }
    // The same parameter given twice arrives as an array.
    for (const [name, value] of Object.entries(base)) {
      const res = await stack.api('GET', `${path}${qsOf({ ...base, [name]: [value, 'second'] })}`, { token: admin.token })
      check(`GET ${path} ${name} repeated`, res)
    }
  }
  assert.deepEqual(failures, [])
})

test('GET: an unrecognised query string, bracket syntax and nesting are harmless', async () => {
  for (const [path] of GETS()) {
    for (const extra of ['?a[b][c]=1', '?q[]=1&q[]=2', '?__proto__[x]=1', '?constructor[prototype][x]=1', '?page=1e999', '?page=0x10', '?pageSize=-5&page=-5', `?${'a=1&'.repeat(500)}`]) {
      check(`GET ${path}${extra.slice(0, 40)}`, await stack.api('GET', `${path}${extra}`, { token: admin.token }))
    }
  }
  assert.deepEqual(failures, [])
})

// ── POST ─────────────────────────────────────────────────────────────────────

const POSTS = () => [
  ['/api/admin/users/suspend', { userId: ids.user, reason: 'spam' }],
  ['/api/admin/users/unsuspend', { userId: ids.user }],
  ['/api/admin/users/set-role', { userId: ids.user, role: 'user' }],
  ['/api/admin/users/delete', { userId: ids.user, confirmEmail: 'nobody@test.example' }],   // wrong on purpose: the target must survive
  ['/api/admin/moderation/resolve', { eventId: ids.event, resolution: 'dismiss', note: 'ok', deleteContent: false, suspendUser: false }],
  ['/api/admin/prices/upsert', { model: 'kling-3.0/video', unit: 'per_second', credits: 20, enabled: true, label: 'Kling', note: 'n' }],
  ['/api/admin/prices/delete', { model: 'kling-3.0/video' }],
  ['/api/admin/billing/grant', { userId: ids.user, credits: 5, note: 'a test grant' }],
]

test('POST: every field of every admin write survives every hostile value', async () => {
  for (const [path, base] of POSTS()) {
    for (const name of Object.keys(base)) {
      for (const value of HOSTILE) {
        const res = await stack.api('POST', path, { token: admin.token, body: { ...base, [name]: value } })
        check(`POST ${path} ${name}=${label(value)}`, res)
      }
    }
  }
  assert.deepEqual(failures, [])

  // Nothing above may have changed the account it was aimed at, except what a valid
  // request legitimately does (the valid-looking cases are role and price writes).
  assert.ok(await stack.one('select 1 from users where id = $1', [ids.user]), 'the target account still exists')
})

test('POST: a body of the wrong shape, or none, or not JSON, is a 400 — never a crash', async () => {
  const shapes = [null, [], 'a string', 123, true, [{ userId: ids.user }], '{"userId"', {}]
  for (const [path] of POSTS().concat([['/api/reports', {}]])) {
    for (const body of shapes) {
      const res = await fetch(`${stack.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
        body: typeof body === 'string' && body.startsWith('{"') ? body : JSON.stringify(body),
      })
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* not JSON */ }
      check(`POST ${path} body ${label(body)}`, { status: res.status, text, body: json })
    }
    for (const [type, text] of [['text/plain', 'userId=1'], ['application/x-www-form-urlencoded', 'userId=1&role=admin'], ['multipart/form-data; boundary=x', '--x--'], ['application/json', ''], [undefined, 'raw']]) {
      const res = await fetch(`${stack.base}${path}`, {
        method: 'POST',
        headers: { ...(type ? { 'content-type': type } : {}), authorization: `Bearer ${admin.token}` },
        body: text,
      })
      const t = await res.text()
      let json = null
      try { json = JSON.parse(t) } catch { /* not JSON */ }
      check(`POST ${path} content-type ${type}`, { status: res.status, text: t, body: json })
    }
  }
  assert.deepEqual(failures, [])
})

test('POST: the wrong method on an admin route is a clean refusal', async () => {
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    for (const [path] of POSTS()) {
      const res = await fetch(`${stack.base}${path}`, { method, headers: { authorization: `Bearer ${admin.token}` } })
      assert.ok(res.status < 500, `${method} ${path} → ${res.status}`)
    }
  }
})

// ── Reports ──────────────────────────────────────────────────────────────────

test('reports: every field survives every hostile value', async () => {
  const user = victim
  for (const name of ['generationId', 'reason', 'note']) {
    for (const value of HOSTILE) {
      const res = await stack.api('POST', '/api/reports', { token: user.token, body: { generationId: ids.generation, reason: 'other', note: 'n', [name]: value } })
      check(`POST /api/reports ${name}=${label(value)}`, res)
    }
  }
  assert.deepEqual(failures, [])
})

// ── The generation proxy ─────────────────────────────────────────────────────

test('proxy: hostile request bodies are refused or forwarded, never a 500', async () => {
  const user = victim
  const bodies = [
    { model: 'kling-3.0/video', input: { prompt: 'a\u0000b XXX-EXPLICIT' } },
    { model: 'kling-3.0/video', input: { prompt: 'x'.repeat(200_000) } },
    { model: 'kling-3.0/video', input: { prompt: ['XXX-EXPLICIT', { deep: 'XXX-EXPLICIT' }] } },
    { model: 'kling-3.0/video', input: { image_urls: [null, 5, {}, [], 'https://[::1]/x', 'http://', 'https://', 'https://x\u0000.com/a.png'] } },
    { model: 'kling-3.0/video', input: { image_urls: ['https://tempfile.aiquickdraw.com/\u0000.png'] } },
    { model: 'kling-3.0/video', input: 'just a string with several words' },
    { model: 'kling-3.0/video', input: JSON.stringify({ prompt: 'XXX-EXPLICIT' }) },
    { model: 'kling-3.0/video', input: null },
    { model: 'kling-3.0/video', input: [] },
    { model: ['array'], input: { prompt: 'hello there' } },
    { model: { a: 1 }, input: { prompt: 'hello there' } },
    { model: 'x'.repeat(5000), input: { prompt: 'hello there' } },
    { model: '\u0000', input: { prompt: 'hello there' } },
    { model: "'; drop table model_prices; --", input: { prompt: 'hello there' } },
    { input: { prompt: 'no model at all' } },
    {},
    [],
    null,
    'string body',
  ]
  for (const path of ['/api/kie/api/v1/jobs/createTask', '/api/kie/api/v1/veo/generate']) {
    for (const body of bodies) {
      check(`POST ${path} ${label(body)}`, await stack.api('POST', path, { token: user.token, body }))
    }
  }
  for (const body of [{ base64Data: 'not base64 !!!', uploadPath: 'images/base64' }, { base64Data: 5 }, { base64Data: ['x'] }, { base64Data: '', uploadPath: 'audio' },
    { base64Data: 'data:,', uploadPath: {} }, { base64Data: '\u0000', uploadPath: 'images/base64' }, null, [], 'x']) {
    check(`POST file-base64-upload ${label(body)}`, await stack.api('POST', '/api/kie/api/file-base64-upload', { token: user.token, body }))
  }
  assert.deepEqual(failures, [])
})

test('proxy: a NUL in a refused prompt is recorded without it, and still a clean refusal', async () => {
  const res = await stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token: victim.token, body: { model: 'm', input: { prompt: 'XXX-EXPLICIT\u0000 and more' } } })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'CONTENT_BLOCKED')
  const [e] = await stack.sql(`select excerpt from moderation_events where source = 'prompt'`)
  assert.ok(!e.excerpt.includes('\u0000'))
  assert.match(e.excerpt, /XXX-EXPLICIT/)
})

test('prompt-assist: hostile text is refused or rewritten, never a 500', async () => {
  for (const text of HOSTILE) {
    for (const kind of ['script', 'scene', 'appearance', 'nonsense', 5, null, {}]) {
      check(`prompt-assist text=${label(text)} kind=${label(kind)}`, await stack.api('POST', '/api/prompt-assist', { token: victim.token, body: { text, kind } }))
    }
    if (failures.length > 20) break
  }
  assert.deepEqual(failures, [])
})

// ── Afterwards ───────────────────────────────────────────────────────────────

test('after all of that the database is intact: tables present, constraints holding, nothing orphaned', async () => {
  for (const table of ['users', 'assets', 'generation_jobs', 'moderation_events', 'model_prices', 'admin_audit_log', 'sessions']) {
    await stack.sql(`select count(*) from ${table}`)
  }
  const orphans = await stack.sql(`select 1 from moderation_events e left join users u on u.id = e.user_id where u.id is null`)
  assert.equal(orphans.length, 0)
  const roles = await stack.sql(`select distinct role from users order by 1`)
  assert.ok(roles.every(r => ['user', 'admin'].includes(r.role)))
  assert.equal((await stack.sql(`select 1 from users where role = 'admin'`)).length >= 1, true, 'at least one administrator remains')
})
