// Security: hostile input against every endpoint a signed-in account can call.
//
// fuzz.test.js does this for the admin routes and the generation proxy, security-auth.test.js for sign-in
// and sign-up. This does it for the rest: every field of every request body and every query parameter is
// replaced, one at a time, by every awkward value there is — wrong types, huge numbers, SQL, markup, other
// accounts' ids — and the answer has to be a refusal that says why ({ error, code } as JSON) or a normal
// answer. Never a server error, never an HTML page, never somebody else's data, and nothing that changes
// what another account owns.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { startStack, jpeg } from '../helpers/stack.js'

let stack
let mia, bob
let ids          // Mia's own objects (valid values for the templates)
let foreign      // Bob's — valid ids that are not Mia's
let pool         // extra accounts, so a per-account request allowance never stands in for the thing under test

// The server fetches a generated file from KIE's own hosts when asked to ingest one. No test may reach the
// real internet, so those hosts are answered here — and every address the server tried to reach is kept,
// so a test can say which ones it was (and that it was never any other).
const realFetch = globalThis.fetch
const outbound = []
const KIE_HOST = /(^|\.)(aiquickdraw\.com|redpandaai\.co|kie\.ai)$/

before(async () => {
  // This file sends thousands of requests as one account on purpose, far past the per-account call limit
  // (api/_lib/http.js), so that limit is lifted here; test/integration/limits.test.js tests it.
  stack = await startStack({ env: { USER_REQUESTS_PER_10S: '1000000', USER_REQUESTS_PER_MINUTE: '1000000' } })
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input)
    let host = ''
    try { host = new URL(url).hostname } catch { /* not a URL */ }
    if (host === '127.0.0.1' || host === 'localhost') return realFetch(input, init)   // the app under test and its stand-ins
    outbound.push(url)
    if (KIE_HOST.test(host)) return new Response(jpeg('IMG-OK'), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    return new Response('this address is not reachable from a test', { status: 599 })
  }
})
after(async () => {
  globalThis.fetch = realFetch
  await stack?.stop()
})

const MARKER = 'BOB-SECRET-MARKER'
const BOB_TASK = 'bobs-private-task-77'     // (no marker in it: a task id sent as a hostile value may be echoed back in an error)
const failures = []

beforeEach(async () => {
  failures.length = 0
  outbound.length = 0
  await stack.reset()
  mia = await stack.createUser({ email: 'mia@test.example' })
  bob = await stack.createUser({ email: 'bob@test.example' })

  const miaAsset = await stack.putAsset({ userId: mia.id, bytes: jpeg('IMG-OK'), moderationStatus: 'clear' })
  const miaInfluencer = await stack.one(`insert into influencers (user_id, name) values ($1, 'Mia''s influencer') returning id`, [mia.id])
  const miaGeneration = await stack.one(
    `insert into generations (user_id, influencer_id, asset_id, kind, label) values ($1, $2, $3, 'image', 'x') returning id`,
    [mia.id, miaInfluencer.id, miaAsset.id],
  )
  ids = { asset: miaAsset.id, influencer: miaInfluencer.id, generation: miaGeneration.id, task: 'mia-task-1' }
  await stack.sql(`insert into generation_jobs (user_id, influencer_id, kie_task_id, kind, label, model) values ($1, $2, 'mia-task-1', 'image', 'x', 'm')`, [mia.id, miaInfluencer.id])

  const bobAsset = await stack.putAsset({ userId: bob.id, bytes: jpeg(MARKER), moderationStatus: 'clear' })
  const bobInfluencer = await stack.one(`insert into influencers (user_id, name, backstory) values ($1, $2, $2) returning id`, [bob.id, MARKER])
  const bobGeneration = await stack.one(
    `insert into generations (user_id, influencer_id, asset_id, kind, label) values ($1, $2, $3, 'image', $4) returning id`,
    [bob.id, bobInfluencer.id, bobAsset.id, MARKER],
  )
  const bobJob = await stack.one(
    `insert into generation_jobs (user_id, influencer_id, kie_task_id, kind, label, model) values ($1, $2, $3, 'image', $4, 'm') returning id`,
    [bob.id, bobInfluencer.id, BOB_TASK, MARKER],
  )
  await stack.sql(`insert into studio_settings (user_id, influencer_id, settings) values ($1, $2, $3::jsonb)`, [bob.id, bobInfluencer.id, JSON.stringify({ note: MARKER })])
  await stack.sql(`insert into task_owners (kie_task_id, user_id) values ($1, $2), ('mia-task-1', $3)`, [BOB_TASK, bob.id, mia.id])   // as the proxy records them
  foreign = { asset: bobAsset.id, influencer: bobInfluencer.id, generation: bobGeneration.id, job: bobJob.id, task: BOB_TASK }

  pool = []
})

// ── Values and plumbing ──────────────────────────────────────────────────────

/** Things a client could send in place of a sensible value. (A NUL byte has its own door: api/_lib/nul.js.) */
const hostile = () => [
  null, true, false, 0, -1, 1.5, 1e21, -1e308, 2 ** 53,
  '', ' ', '\t\n', 'x', 'x'.repeat(5_000), 'x'.repeat(70_000),
  '\u0001', '\ud800', '‮', '😀', 'ünïcödé', '\r\nX-Injected: 1',
  "'; drop table users; --", "' or '1'='1", '"; select pg_sleep(5); --', '%', '_', '\\', '%_\\',
  '../../etc/passwd', '..\\..\\windows', '<script>alert(1)</script>', '${process.exit(1)}', '{{7*7}}', '$(id)',
  'constructor', '__proto__', 'toString',
  [], [1, 2, 3], ['a', 'b'], [[]], [{}], {}, { a: 1 }, { toString: 'x' }, { length: 5 }, JSON.parse('{"__proto__":{"admin":true}}'),
  '00000000-0000-4000-8000-000000000000', 'not-a-uuid', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
  'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', 'https://evil.test/', 'javascript:alert(1)',
  // Valid ids that belong to someone else: must be "not yours", never a leak and never a crash.
  foreign.asset, foreign.influencer, foreign.generation, foreign.job, foreign.task,
]

const show = v => (JSON.stringify(v) ?? String(v)).slice(0, 48)

function check(label, res) {
  if (res.status >= 500) failures.push(`${res.status}  ${label}  → ${String(res.text).slice(0, 140)}`)
  else if (res.status >= 400) {
    const shaped = res.body && typeof res.body.error === 'string' && typeof res.body.code === 'string'
    if (!shaped) failures.push(`${res.status} without a { error, code } body  ${label}  → ${String(res.text).slice(0, 100)}`)
    else if (!String(res.headers.get('content-type')).includes('application/json')) failures.push(`${res.status} not JSON  ${label}`)
  }
  if (String(res.text).includes(MARKER)) failures.push(`LEAK of another account's data  ${label}  → ${String(res.text).slice(0, 100)}`)
}

/**
 * Every way to spoil a request body, one field at a time: each field replaced by each hostile value
 * or left out, and the same for the fields one level inside it (the record of an influencer, the
 * first item of a list).
 */
function* mutations(template) {
  const bad = hostile()
  for (const [key, value] of Object.entries(template)) {
    for (const v of bad) yield [`${key}=${show(v)}`, { ...template, [key]: v }]
    const { [key]: _gone, ...without } = template
    yield [`${key} missing`, without]

    const inner = Array.isArray(value) && value.length === 1 && value[0] && typeof value[0] === 'object' && !Array.isArray(value[0])
      ? { wrap: item => [item], object: value[0] }
      : value && typeof value === 'object' && !Array.isArray(value) ? { wrap: item => item, object: value } : null
    if (inner) {
      for (const [field] of Object.entries(inner.object)) {
        for (const v of bad) yield [`${key}.${field}=${show(v)}`, { ...template, [key]: inner.wrap({ ...inner.object, [field]: v }) }]
        const { [field]: _skipped, ...rest } = inner.object
        yield [`${key}.${field} missing`, { ...template, [key]: inner.wrap(rest) }]
      }
    }
    if (Array.isArray(value) && value.length === 1 && typeof value[0] !== 'object') {
      for (const v of bad) yield [`${key}[0]=${show(v)}`, { ...template, [key]: [v] }]
    }
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

/** A URL cannot be longer than Node's header limit; the same values, cut to a size the request line allows. */
const inUrl = v => (typeof v === 'string' && v.length > 5000 ? v.slice(0, 5000) : v)

const raw = ({ method = 'POST', path, headers = {}, body }) => new Promise((resolve, reject) => {
  const { port } = new URL(stack.base)
  const req = http.request({ host: '127.0.0.1', port: Number(port), path, method, headers }, res => {
    let text = ''
    res.on('data', c => { text += c })
    res.on('end', () => { let json = null; try { json = JSON.parse(text) } catch { /* not json */ } resolve({ status: res.statusCode, text, body: json, headers: new Headers(res.headers) }) })
  })
  req.on('error', reject)
  if (body !== undefined) req.write(body)
  req.end()
})

// ── What each endpoint takes ─────────────────────────────────────────────────

const POSTS = () => [
  ['/api/influencers/create', {
    record: {
      name: 'Zed', gender: 'f', age: '25', type: 'Influencer', niche: 'fitness', niches: ['a'], niche_custom: 'c', backstory: 'b',
      intro_extrovert: 50, physical_desc: 'p', vibe_words: ['v'], main_asset_id: ids.asset, prompt: 'p', reference_asset_id: null,
      copy_attributes: ['a'], palette: ['red'], voice: 'v', content_pillars: ['x'], wardrobe_slots: [{ asset_id: ids.asset, label: 'l' }],
    },
    linkAssetIds: [ids.asset],
    creationParams: { prompt: 'p', count: 1 },
  }],
  ['/api/influencers/update', { id: ids.influencer, patch: { name: 'Renamed', backstory: 'x', intro_extrovert: 10, niches: ['n'], main_asset_id: ids.asset, wardrobe_slots: [] } }],
  ['/api/influencers/delete', { influencerId: ids.influencer }],
  ['/api/generations/add', { assetId: ids.asset, influencerId: ids.influencer, kind: 'image', label: 'Fuzz' }],
  ['/api/generations/delete', { generationId: ids.generation }],
  ['/api/jobs/register', { entries: [{ taskId: 'task-fuzz-1', influencerId: ids.influencer, kind: 'image', label: 'l', model: 'm' }] }],
  ['/api/jobs/remove', { id: ids.generation }],
  ['/api/studio-settings', { influencerId: ids.influencer, settings: { duration: 5, prompt: 'p' } }],
  ['/api/storage/upload-url', { contentType: 'image/png', byteSize: 1234, influencerId: ids.influencer }],
  ['/api/storage/download-url', { assetIds: [ids.asset], purpose: 'display', downloadName: 'file.png' }],
  ['/api/storage/confirm', { assetId: ids.asset }],
  ['/api/storage/ingest', { sourceUrl: 'https://tempfile.aiquickdraw.com/a.png', influencerId: ids.influencer }],
  ['/api/storage/delete', { assetId: ids.asset }],
  ['/api/reports', { generationId: ids.generation, reason: 'other', note: 'n' }],
]

const GETS = () => [
  ['/api/influencers', {}],
  ['/api/generations/by-asset', { assetId: ids.asset }],
  ['/api/generations/by-influencer', { influencerId: ids.influencer, beforeAt: '2026-10-01T00:00:00Z', beforeId: ids.generation, limit: 10 }],
  ['/api/jobs', { limit: 10, active: 1 }],
  ['/api/jobs/by-task', { taskId: ids.task }],
  ['/api/jobs/active-count', { influencerId: ids.influencer }],
  ['/api/jobs/changes', { since: '2026-10-01T00:00:00Z' }],
  ['/api/studio-settings', { influencerId: ids.influencer }],
  ['/api/creation-params', { influencerId: ids.influencer }],
  ['/api/billing/me', {}],
]

// ═════════════════════════════ The sweeps ═════════════════════════════════════

async function snapshotOfBob() {
  const parts = []
  for (const sql of [
    'select * from influencers where user_id = $1 order by id',
    'select * from assets where user_id = $1 order by id',
    'select * from generations where user_id = $1 order by id',
    'select * from generation_jobs where user_id = $1 order by id',
    'select * from studio_settings where user_id = $1 order by influencer_id',
    'select * from moderation_events where user_id = $1 order by id',
    'select * from credit_ledger where user_id = $1 order by id',
    'select id, email, role, status, display_name, password_hash, email_confirmed_at from users where id = $1',
  ]) parts.push(JSON.stringify(await stack.sql(sql, [bob.id])))
  return parts.join('\n')
}

test('POST: every field of every write survives every hostile value — and nothing of another account moves', async () => {
  const before = await snapshotOfBob()
  let sent = 0
  for (const [path, template] of POSTS()) {
    for (const [what, body] of mutations(template)) {
      sent++
      check(`POST ${path} ${what}`, await stack.api('POST', path, { token: mia.token, body }))
      if (failures.length > 25) break
    }
  }
  assert.ok(sent > 2000, `only ${sent} requests were sent`)
  assert.deepEqual(failures, [])
  assert.equal(await snapshotOfBob(), before, 'Bob\'s rows are exactly as they were')
  // Among those requests were addresses for the server to fetch (ingest). It fetched only KIE's.
  assert.ok(outbound.length > 0, 'the allowed address was fetched at least once')
  assert.deepEqual(outbound.filter(url => !KIE_HOST.test(new URL(url).hostname)), [], 'and nothing else, ever')
})

test('GET: every query parameter of every read survives every hostile value, given once or twice', async () => {
  const before = await snapshotOfBob()
  let sent = 0
  for (const [path, base] of GETS()) {
    for (const name of Object.keys(base)) {
      for (const v of hostile()) {
        sent++
        check(`GET ${path} ${name}=${show(v)}`, await stack.api('GET', `${path}${qsOf({ ...base, [name]: inUrl(v) })}`, { token: mia.token }))
      }
      check(`GET ${path} ${name} repeated`, await stack.api('GET', `${path}${qsOf({ ...base, [name]: [base[name], 'second'] })}`, { token: mia.token }))
      check(`GET ${path} ${name} as a list`, await stack.api('GET', `${path}?${encodeURIComponent(`${name}[]`)}=1&${encodeURIComponent(`${name}[]`)}=2`, { token: mia.token }))
      check(`GET ${path} ${name} as an object`, await stack.api('GET', `${path}?${encodeURIComponent(`${name}[a][b]`)}=1`, { token: mia.token }))
      check(`GET ${path} ${name}[toString]`, await stack.api('GET', `${path}?${encodeURIComponent(`${name}[toString]`)}=x&${encodeURIComponent(`${name}[valueOf]`)}=x`, { token: mia.token }))
    }
    for (const extra of ['?__proto__[x]=1', '?constructor[prototype][x]=1', '?limit=1e999&page=0x10', `?${'a=1&'.repeat(500)}`]) {
      check(`GET ${path}${extra.slice(0, 40)}`, await stack.api('GET', `${path}${extra}`, { token: mia.token }))
    }
  }
  assert.ok(sent > 400, `only ${sent} requests were sent`)
  assert.deepEqual(failures, [])
  assert.equal(await snapshotOfBob(), before)
})

test('a task id of any kind is a clean answer on the sync endpoint, which spends KIE requests', async () => {
  // GET /api/jobs/sync asks KIE, so it shares the generation proxy's per-account allowance. Each
  // request therefore comes from a different account, and what is under test is the task id.
  const { createSession } = await stack.load('api/_lib/sessions.js')
  const { hashPassword } = await stack.load('api/_lib/passwords.js')
  const hash = await hashPassword('a-long-test-password-1')
  for (let i = 0; i < 12; i++) {
    const u = await stack.one(`insert into users (email, password_hash, email_confirmed_at) values ($1, $2, now()) returning *`, [`pool${i}@test.example`, hash])
    pool.push((await createSession(u)).accessToken)
  }
  let n = 0
  for (const v of hostile()) {
    check(`GET /api/jobs/sync taskId=${show(v)}`, await stack.api('GET', `/api/jobs/sync${qsOf({ taskId: inUrl(v) })}`, { token: pool[n++ % pool.length] }))
  }
  // Someone else's task id: refused, and never answered with their job.
  const theirs = await stack.api('GET', `/api/jobs/sync${qsOf({ taskId: foreign.task })}`, { token: pool[0] })
  assert.equal(theirs.status, 403)
  assert.equal(theirs.body.code, 'TASK_NOT_YOURS')
  assert.deepEqual(failures, [])
})

test('a request body of the wrong shape, or none, or not JSON, is a clean 400 on every write', async () => {
  const wrong = []
  const shapes = [
    ['null', 'null'], ['an array', '[]'], ['an array of arrays', '[[],[[]]]'], ['a string', '"x"'], ['a number', '5'], ['true', 'true'],
    ['an empty object', '{}'], ['half an object', '{"a":'], ['not JSON', 'hello'], ['single quotes', "{'a':1}"], ['trailing comma', '{"a":1,}'],
    ['an empty body', ''], ['100 000 nested lists', '['.repeat(100_000) + ']'.repeat(100_000)], ['a very long number', `{"a":${'9'.repeat(5000)}}`],
    ['a duplicate key', '{"a":1,"a":2}'], ['a byte-order mark', '﻿{}'],
  ]
  for (const [path] of POSTS()) {
    for (const [what, body] of shapes) {
      const res = await raw({ path, headers: { 'content-type': 'application/json', authorization: `Bearer ${mia.token}` }, body })
      const ok = res.status < 500 && (res.status < 400 || (res.body && typeof res.body.error === 'string' && typeof res.body.code === 'string'))
      if (!ok) wrong.push(`${path} ${what} → ${res.status} ${res.text.slice(0, 80)}`)
    }
    // The wrong content type: the body is never parsed, so the handler sees nothing and says so.
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/xml', 'text/html']) {
      const res = await raw({ path, headers: { 'content-type': type, authorization: `Bearer ${mia.token}` }, body: '{"influencerId":"x"}' })
      if (res.status >= 500) wrong.push(`${path} as ${type} → ${res.status}`)
    }
    // No content type at all.
    const bare = await raw({ path, headers: { authorization: `Bearer ${mia.token}` } })
    if (bare.status >= 500) wrong.push(`${path} with no body → ${bare.status}`)
  }
  assert.deepEqual(wrong, [])
})

test('requests with odd methods, paths and headers do not break the app', async () => {
  const wrong = []
  const send = async (label, opts) => {
    try {
      const res = await raw(opts)
      if (res.status >= 500) wrong.push(`${label} → ${res.status} ${res.text.slice(0, 80)}`)
    } catch (e) {
      // The server may drop a connection it cannot parse; what matters is that it is still serving afterwards.
      if (!/ECONNRESET|socket hang up|HPE_/.test(String(e?.message ?? e) + String(e?.code ?? ''))) wrong.push(`${label} → ${e.message}`)
    }
  }
  const auth = { authorization: `Bearer ${mia.token}` }
  for (const method of ['PUT', 'PATCH', 'DELETE', 'TRACE', 'CONNECT', 'PROPFIND', 'PURGE']) {
    await send(`${method} /api/influencers`, { method, path: '/api/influencers', headers: auth })
  }
  for (const path of ['/api/influencers/', '/api//influencers', '/api/influencers%2f', '/api/%2e%2e/influencers', '/api/influencers;x=1', '/api/influencers?', '/api/influencers#x', '/%00', '/api/%00', '/api/influencers/%ff', '/' + 'a'.repeat(8000), '/api/' + '../'.repeat(50)]) {
    await send(`GET ${path.slice(0, 40)}`, { method: 'GET', path, headers: auth })
  }
  for (const [name, value] of [['authorization', 'Bearer ' + 'a'.repeat(15_000)], ['content-length', '-1'], ['x-forwarded-for', ',,,'], ['x-forwarded-for', 'a, b, c, d'], ['host', 'evil.test'], ['origin', 'null'], ['content-type', 'application/json; charset=utf-7'], ['content-type', 'application/json; charset=bogus']]) {
    await send(`header ${name}`, { method: 'POST', path: '/api/influencers/update', headers: { ...auth, 'content-type': 'application/json', [name]: value }, body: '{}' })
  }
  assert.deepEqual(wrong, [])
  // And it is still serving.
  assert.equal((await stack.api('GET', '/health')).status, 200)
  assert.equal((await stack.api('GET', '/api/auth/me', { token: mia.token })).status, 200)
})

// ═════════════════════════════ Specific rules ═════════════════════════════════

test('uploads: the declared type and size are checked at every boundary', async () => {
  const MAX = 200 * 1024 * 1024
  const ask = (contentType, byteSize, extra = {}) => stack.api('POST', '/api/storage/upload-url', { token: mia.token, body: { contentType, byteSize, ...extra } })
  const rows = async () => (await stack.sql('select count(*)::int as n from assets where user_id = $1', [mia.id]))[0].n
  const start = await rows()

  for (const [contentType, byteSize, want] of [
    ['image/png', 1, 200], ['image/jpeg', MAX, 200], ['video/mp4', 1024, 200], ['audio/mpeg', 1024, 200],
    ['image/png', MAX + 1, 413], ['image/png', 2 ** 53, 413],
    ['image/png', 0, 400], ['image/png', -1, 400], ['image/png', 1.5, 400], ['image/png', '10', 400], ['image/png', null, 400], ['image/png', undefined, 400],
    ['image/png', [10], 400], ['image/png', { n: 10 }, 400], ['image/png', true, 400], ['image/png', 1e400, 400],
    ['IMAGE/PNG', 10, 400], [' image/png', 10, 400], ['image/png; charset=x', 10, 400], ['image/png\r\nX: y', 10, 400],
    ['image/svg+xml', 10, 400], ['text/html', 10, 400], ['application/pdf', 10, 400], ['application/octet-stream', 10, 400],
    ['image/gif', 10, 400], ['', 10, 400], [null, 10, 400], [['image/png'], 10, 400], [{ toString: 'image/png' }, 10, 400], [5, 10, 400],
  ]) {
    const res = await ask(contentType, byteSize)
    // 200 or a quota/limit refusal both mean "accepted as a request"; what is wrong is accepting what should be refused.
    if (want === 200) assert.ok([200, 507].includes(res.status), `${show(contentType)} ${byteSize} → ${res.status}`)
    else assert.equal(res.status, want, `${show(contentType)} ${show(byteSize)} → ${res.status} ${res.body?.code}`)
  }
  assert.ok((await rows()) > start, 'the accepted ones made rows')

  // Nothing refused made a row.
  const before = await rows()
  await ask('image/svg+xml', 10); await ask('image/png', -5); await ask('text/html', 10)
  assert.equal(await rows(), before)

  // Somebody else's influencer: refused, with no row.
  const stranger = await ask('image/png', 10, { influencerId: foreign.influencer })
  assert.equal(stranger.status, 403)
  assert.equal(await rows(), before)
})

test('a request with a body is not read unless it comes with a session: the answer arrives while the body is still on its way', async () => {
  // A 9 MB body is declared, 2 KB of it is sent, and the rest never comes. A server that reads a body before
  // asking who sent it would sit waiting for the other 9 MB — which is what let anyone make it buffer and parse
  // 10 MB per request just to be told to sign in.
  const waitFor = (path, headers = {}, patience = 4000) => new Promise((resolve, reject) => {
    const { port } = new URL(stack.base)
    let done = false
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); req.destroy(); fn(value) }
    const req = http.request({
      host: '127.0.0.1', port: Number(port), path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(9 * 1024 * 1024), ...headers },
    }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => { let json = null; try { json = JSON.parse(text) } catch { /* not json */ } finish(resolve, { status: res.statusCode, json }) })
    })
    const timer = setTimeout(() => finish(resolve, { status: null, json: null, waiting: true }), patience)
    req.on('error', e => finish(reject, e))
    req.write(`{"padding":"${'x'.repeat(2000)}`)
  })

  const suspended = await stack.createUser({ status: 'suspended' })
  const paths = ['/api/kie/api/v1/jobs/createTask', '/api/influencers/create', '/api/admin/prices/upsert', '/api/storage/ingest', '/api/reports', '/api/nope']
  for (const path of paths) {
    for (const [who, headers] of [['nobody', {}], ['a made-up token', { authorization: 'Bearer not-a-session' }], ['a malformed header', { authorization: 'Basic abc' }]]) {
      const res = await waitFor(path, headers)
      assert.ok(!res.waiting, `${path} as ${who}: it waited for the whole body before answering`)
      assert.equal(res.status, 401, `${path} as ${who}`)
      assert.equal(res.json?.code, 'NOT_AUTHENTICATED', `${path} as ${who}`)
    }
    const refused = await waitFor(path, { authorization: `Bearer ${suspended.token}` })
    assert.equal(refused.status, 403, `${path} as a suspended account`)
  }

  // A signed-in caller's body is read as before (here: it never arrives, so the server is still waiting for it).
  const signedIn = await waitFor('/api/influencers/create', { authorization: `Bearer ${mia.token}` }, 700)
  assert.equal(signedIn.waiting, true, 'a signed-in caller is let through to the body parser')

  // The sign-in family is open to callers with no session. (It has a 16 KB ceiling of its own: a larger body is
  // discarded as it arrives and refused with a 413 when it ends — test security-auth, "unauthenticated endpoints".)
  const open = await waitFor('/api/auth/login', {}, 700)
  assert.equal(open.waiting, true, 'the sign-in endpoints are not behind the session gate')

  // A preflight and a plain read need no session to be answered by the same machinery.
  assert.equal((await stack.api('GET', '/api/auth/me')).status, 401)
  assert.equal((await raw({ method: 'OPTIONS', path: '/api/influencers', headers: { origin: 'https://nobody.example', 'access-control-request-method': 'POST' } })).status, 204)
})

test('the file name offered for a download cannot become a header of its own', async () => {
  for (const name of ['a"; filename*=UTF-8\'\'evil.html', 'a\r\nContent-Type: text/html', 'x'.repeat(5000), '../../etc/passwd', 'ünï.png', '<b>.png', '%0d%0aX: y']) {
    const res = await stack.api('POST', '/api/storage/download-url', { token: mia.token, body: { assetIds: [ids.asset], downloadName: name } })
    assert.equal(res.status, 200, show(name))
    const { url } = res.body.urls[ids.asset]
    const disposition = new URL(url).searchParams.get('response-content-disposition')
    assert.match(disposition, /^attachment; filename="[\w.\-]*"$/, `${show(name)} → ${disposition}`)
  }
})

test('ingest only ever fetches from KIE\'s own hosts, however the address is dressed up', async () => {
  const { isAllowedResultSource } = await stack.load('api/_lib/results.js')
  const allowed = [
    'https://tempfile.aiquickdraw.com/a.png', 'https://aiquickdraw.com/a.png', 'https://TEMPFILE.AIQUICKDRAW.COM/a.png',
    'https://kieai.redpandaai.co/x.mp4', 'https://cdn.kie.ai/a.jpg',
  ]
  const refused = [
    'http://tempfile.aiquickdraw.com/a.png',                       // not https
    'https://aiquickdraw.com.evil.test/a.png',                     // our name inside theirs
    'https://evil.test/aiquickdraw.com',                           // in the path
    'https://evil.test/?u=https://aiquickdraw.com/',               // in the query
    'https://evil.test#.aiquickdraw.com/',                         // in the fragment
    'https://tempfile.aiquickdraw.com@evil.test/a.png',            // userinfo trick
    'https://tempfile.aiquickdraw.com:pass@evil.test/a.png',
    'https://evil.test\\@tempfile.aiquickdraw.com/a.png',          // backslash trick
    'https://evil.test%2f@tempfile.aiquickdraw.com/',
    'https://notaiquickdraw.com/a.png', 'https://xaiquickdraw.com/a.png', 'https://aiquickdraw.com.cn/a.png', 'https://kie.ai.evil.test/a.png', 'https://evilkie.ai/a.png',
    'https://tempfile.aiquickdraw.com./a.png',                     // a trailing dot is a different name to a lazy check
    'https://127.0.0.1/a.png', 'https://localhost/a.png', 'https://[::1]/a.png', 'https://169.254.169.254/latest/meta-data/', 'https://0x7f000001/', 'https://2130706433/', 'https://10.0.0.1/',
    'https://metadata.google.internal/', 'ftp://tempfile.aiquickdraw.com/a.png', 'file:///etc/passwd', 'gopher://tempfile.aiquickdraw.com/', 'data:image/png;base64,AAAA', 'javascript:alert(1)',
    '//tempfile.aiquickdraw.com/a.png', 'tempfile.aiquickdraw.com/a.png', '', ' ', 'https://', 'https:///a.png', 'not a url',
    ' https://tempfile.aiquickdraw.com/a.png' + '\u0000', 5, null, undefined, {}, [], ['https://tempfile.aiquickdraw.com/a.png'],
  ]
  for (const url of allowed) assert.equal(isAllowedResultSource(url), true, String(url))
  for (const url of refused) {
    let ok
    try { ok = isAllowedResultSource(url) } catch { ok = 'threw' }
    assert.equal(ok, false, `${show(url)} must not be fetched (${ok})`)
  }

  // And the endpoint says so before it does anything: no request leaves the server for any of them.
  outbound.length = 0
  for (const url of refused.filter(u => typeof u === 'string' && !u.includes('\u0000'))) {
    const res = await stack.api('POST', '/api/storage/ingest', { token: mia.token, body: { sourceUrl: url } })
    assert.equal(res.status, 400, show(url))
    assert.equal(res.body.code, 'BAD_SOURCE', show(url))
  }
  assert.deepEqual(outbound, [], 'nothing was requested for any refused address')
  assert.equal((await stack.sql('select count(*)::int as n from assets where origin = $1', ['generated']))[0].n, 0)

  // Control: an allowed address is fetched, once, and stored.
  const ok = await stack.api('POST', '/api/storage/ingest', { token: mia.token, body: { sourceUrl: 'https://tempfile.aiquickdraw.com/a.png' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(outbound, ['https://tempfile.aiquickdraw.com/a.png'])
})

test('a redirect from an allowed host to anywhere else is not followed', async () => {
  const { fetchAllowedSource } = await stack.load('api/_lib/results.js')
  const seen = []
  const redirectingTo = location => async url => {
    seen.push(String(url))
    return new Response(null, { status: 302, headers: { location } })
  }
  for (const location of [
    'http://169.254.169.254/latest/meta-data/', 'https://evil.test/a.png', 'file:///etc/passwd', 'http://tempfile.aiquickdraw.com/a.png',
    '//evil.test/a.png', 'https://tempfile.aiquickdraw.com@evil.test/a.png',
  ]) {
    seen.length = 0
    await assert.rejects(fetchAllowedSource('https://tempfile.aiquickdraw.com/a.png', redirectingTo(location)), e => e.code === 'BAD_SOURCE', location)
    assert.deepEqual(seen, ['https://tempfile.aiquickdraw.com/a.png'], `${location}: only the first address was ever requested`)
  }

  // An allowed hop to an allowed host is followed, but not for ever.
  let hops = 0
  await assert.rejects(
    fetchAllowedSource('https://tempfile.aiquickdraw.com/a.png', async () => { hops++; return new Response(null, { status: 302, headers: { location: 'https://tempfile.aiquickdraw.com/a.png' } }) }),
    e => e.code === 'SOURCE_UNAVAILABLE',
  )
  assert.ok(hops <= 5, `${hops} hops`)
})

test('every id-taking field refuses another account\'s object without revealing whether it exists', async () => {
  const wrong = []
  const asMia = (path, body) => stack.api('POST', path, { token: mia.token, body })
  const nonexistent = '11111111-1111-4111-8111-111111111111'
  const cases = [
    ['/api/influencers/update', k => ({ id: k.influencer, patch: { name: 'hijack' } })],
    ['/api/influencers/delete', k => ({ influencerId: k.influencer })],
    ['/api/generations/add', k => ({ assetId: k.asset, influencerId: null })],
    ['/api/generations/add', k => ({ assetId: ids.asset, influencerId: k.influencer })],
    ['/api/generations/delete', k => ({ generationId: k.generation })],
    ['/api/jobs/remove', k => ({ id: k.job })],
    ['/api/jobs/register', k => ({ entries: [{ taskId: 'fresh-task', influencerId: k.influencer }] })],
    ['/api/studio-settings', k => ({ influencerId: k.influencer, settings: { a: 1 } })],
    ['/api/storage/upload-url', k => ({ contentType: 'image/png', byteSize: 10, influencerId: k.influencer })],
    ['/api/storage/confirm', k => ({ assetId: k.asset })],
    ['/api/storage/delete', k => ({ assetId: k.asset })],
    ['/api/storage/ingest', k => ({ sourceUrl: 'https://tempfile.aiquickdraw.com/a.png', influencerId: k.influencer })],
    ['/api/reports', k => ({ generationId: k.generation, reason: 'other' })],
  ]
  // Deleting something that is not there is not an error ("make it gone" is already true), so these answer the
  // same for another account's id as for one that never existed — which is the point: no way to tell the two apart.
  const IDEMPOTENT = new Set(['/api/generations/delete', '/api/jobs/remove', '/api/storage/delete'])
  const before = await snapshotOfBob()

  for (const [path, body] of cases) {
    const theirs = await asMia(path, body(foreign))
    const nothing = await asMia(path, body({ asset: nonexistent, influencer: nonexistent, generation: nonexistent, job: nonexistent }))
    if (theirs.status >= 500 || nothing.status >= 500) wrong.push(`${path} → ${theirs.status} / ${nothing.status}`)
    if (IDEMPOTENT.has(path)) {
      if (theirs.status !== nothing.status) wrong.push(`${path} answers differently for another account's id (${theirs.status}) and a missing one (${nothing.status})`)
    } else {
      if (theirs.status < 400) wrong.push(`${path} accepted another account's id → ${theirs.status}`)
      if (nothing.status < 400 && path !== '/api/jobs/register') wrong.push(`${path} accepted an id that does not exist → ${nothing.status}`)
    }
    for (const r of [theirs, nothing]) if (r.text.includes(MARKER)) wrong.push(`${path} leaked`)
  }
  assert.deepEqual(wrong, [])
  assert.equal(await snapshotOfBob(), before, 'and none of it touched Bob\'s rows')
})

test('what one account stores can never be seen through another account\'s lists, counts or cursors', async () => {
  const wrong = []
  const reads = [
    '/api/influencers', '/api/jobs', '/api/jobs?active=1', '/api/jobs/active-count', '/api/jobs/changes?since=2000-01-01T00:00:00Z',
    `/api/generations/by-influencer?influencerId=${foreign.influencer}`, `/api/generations/by-asset?assetId=${foreign.asset}`,
    `/api/generations/by-influencer?influencerId=${ids.influencer}&beforeId=${foreign.generation}&beforeAt=2100-01-01T00:00:00Z`,
    `/api/studio-settings?influencerId=${foreign.influencer}`, `/api/creation-params?influencerId=${foreign.influencer}`,
    `/api/jobs/by-task?taskId=${encodeURIComponent(foreign.task)}`, '/api/billing/me',
  ]
  for (const path of reads) {
    const res = await stack.api('GET', path, { token: mia.token })
    if (res.status >= 500) wrong.push(`${path} → ${res.status}`)
    if (res.text.includes(MARKER) || res.text.includes(bob.email) || res.text.includes(bob.id) || res.text.includes(foreign.influencer) || res.text.includes(foreign.asset)) wrong.push(`${path} showed something of Bob's`)
  }
  const urls = await stack.api('POST', '/api/storage/download-url', { token: mia.token, body: { assetIds: [foreign.asset, ids.asset] } })
  assert.deepEqual(Object.keys(urls.body.urls), [ids.asset], 'a link is signed for the account\'s own file only')
  assert.deepEqual(wrong, [])
})

test('a half-emoji (a lone surrogate) in a saved document is mended, not a server error — in a setting, a wardrobe slot and the creation parameters', async () => {
  const half = 'broken\ud800end'
  const mended = 'broken�end'

  const saved = await stack.api('POST', '/api/studio-settings', { token: mia.token, body: { influencerId: ids.influencer, settings: { prompt: half, [`k${half}`]: [half, { deeper: half }] } } })
  assert.equal(saved.status, 204)
  const read = await stack.api('GET', `/api/studio-settings?influencerId=${ids.influencer}`, { token: mia.token })
  assert.deepEqual(read.body.settings, { prompt: mended, [`k${mended}`]: [mended, { deeper: mended }] })

  const created = await stack.api('POST', '/api/influencers/create', {
    token: mia.token,
    body: { record: { name: half, wardrobe_slots: [{ label: half }] }, creationParams: { prompt: half } },
  })
  assert.equal(created.status, 201, created.text)
  assert.equal(created.body.influencer.name, mended)
  assert.deepEqual(created.body.influencer.wardrobe_slots, [{ label: mended }])
  const params = await stack.api('GET', `/api/creation-params?influencerId=${created.body.influencer.id}`, { token: mia.token })
  assert.deepEqual(params.body.params, { prompt: mended })

  // A well-formed emoji is left alone.
  const fine = await stack.api('POST', '/api/studio-settings', { token: mia.token, body: { influencerId: ids.influencer, settings: { mood: '😀 ünï' } } })
  assert.equal(fine.status, 204)
  assert.deepEqual((await stack.api('GET', `/api/studio-settings?influencerId=${ids.influencer}`, { token: mia.token })).body.settings, { mood: '😀 ünï' })
})

test('a key named __proto__ in a saved document stays an ordinary key and changes nothing for anyone', async () => {
  const body = `{"influencerId":"${ids.influencer}","settings":{"__proto__":{"polluted":"yes"},"a\\ud800":{"__proto__":"x"}}}`
  const res = await raw({ path: '/api/studio-settings', headers: { 'content-type': 'application/json', authorization: `Bearer ${mia.token}` }, body })
  assert.equal(res.status, 204, res.text)
  const read = await stack.api('GET', `/api/studio-settings?influencerId=${ids.influencer}`, { token: mia.token })
  assert.equal(read.body.settings.polluted, undefined)
  assert.equal(({}).polluted, undefined, 'Object.prototype is untouched')
  assert.deepEqual(Object.keys(read.body.settings).sort(), ['__proto__', 'a�'])
})

test('a number in a request is a number: text that is one is accepted, null is the default, and nothing else is', async () => {
  const create = value => stack.api('POST', '/api/influencers/create', { token: mia.token, body: { record: { name: 'N', intro_extrovert: value } } })
  for (const [value, want] of [[0, 0], [100, 100], ['55', 55], [' 7 ', 7], [null, 50], [12.0, 12]]) {
    const res = await create(value)
    assert.equal(res.status, 201, `${show(value)} → ${res.text}`)
    assert.equal(res.body.influencer.intro_extrovert, want, show(value))
  }
  for (const bad of [-1, 101, 1.5, '1.5', 'abc', '', ' ', true, false, [], [5], {}, { toString: 'x' }, 1e21, '1e3', 'NaN', 'Infinity']) {
    const res = await create(bad)
    assert.equal(res.status, 400, `${show(bad)} → ${res.status}`)
    assert.equal(res.body.code, 'BAD_REQUEST')
  }
})

test('page sizes and cursors in a query string: fractions are cut, junk falls back or is a 400 — never a 500', async () => {
  for (let i = 0; i < 5; i++) {
    const asset = await stack.putAsset({ userId: mia.id, bytes: jpeg(`IMG-${i}`), moderationStatus: 'clear' })
    await stack.sql(`insert into generations (user_id, influencer_id, asset_id, kind, label) values ($1, $2, $3, 'image', $4)`, [mia.id, ids.influencer, asset.id, `g${i}`])
    await stack.sql(`insert into generation_jobs (user_id, kie_task_id, kind, label, model) values ($1, $2, 'image', 'x', 'm')`, [mia.id, `extra-${i}`])
  }
  const gallery = query => stack.api('GET', `/api/generations/by-influencer?influencerId=${ids.influencer}${query}`, { token: mia.token })
  const queue = query => stack.api('GET', `/api/jobs${query}`, { token: mia.token })

  assert.equal((await gallery('&limit=2.7')).body.generations.length, 2, '2.7 is 2')
  assert.equal((await gallery('&limit=1.5')).body.generations.length, 1)
  assert.equal((await gallery('&limit=-3')).body.generations.length, 1, 'below the least is the least')
  assert.equal((await gallery('&limit=99999')).body.generations.length, 6, 'above the most is the most (all six exist)')
  for (const junk of ['abc', '0', '', '1e999', 'Infinity', 'NaN', '%20', '0x10']) assert.equal((await gallery(`&limit=${junk}`)).status, 200, junk)
  assert.equal((await queue('?limit=1.5')).body.jobs.length, 1)
  assert.equal((await queue('?limit=2.9')).body.jobs.length, 2)
  assert.equal((await queue('?limit=abc')).status, 200)

  // A cursor taken from the last answer continues exactly where it ended.
  const first = (await gallery('&limit=2')).body
  assert.equal(first.hasMore, true)
  const last = first.generations.at(-1)
  const next = (await gallery(`&limit=2&beforeAt=${encodeURIComponent(last.created_at)}&beforeId=${last.id}`)).body
  assert.equal(next.generations.length, 2)
  assert.ok(!next.generations.some(g => first.generations.some(f => f.id === g.id)), 'no entry twice')

  // A cursor that is not a time is the caller's mistake; half a cursor is no cursor.
  for (const bad of ['garbage', '2026-13-45', 'x'.repeat(100), '%00']) {
    const res = await gallery(`&beforeAt=${bad}&beforeId=${last.id}`)
    assert.ok([400].includes(res.status), `${bad} → ${res.status}`)
  }
  assert.equal((await gallery(`&beforeAt=${encodeURIComponent(last.created_at)}`)).status, 200)
  assert.equal((await gallery(`&beforeId=${last.id}`)).status, 200)
  assert.equal((await stack.api('GET', '/api/jobs/changes?since=garbage', { token: mia.token })).status, 400)
  assert.equal((await stack.api('GET', '/api/jobs/changes?since=2026-10-01T00:00:00Z', { token: mia.token })).status, 200)
})

test('a body in a charset or encoding the server does not read is the caller\'s mistake (415 or 400), not a server error', async () => {
  const send = (headers, body = '{}') => raw({ path: '/api/studio-settings', headers: { authorization: `Bearer ${mia.token}`, 'content-type': 'application/json', ...headers }, body })
  for (const [what, res] of [
    ['charset bogus', await send({ 'content-type': 'application/json; charset=bogus' })],
    ['charset latin1', await send({ 'content-type': 'application/json; charset=latin1' })],
    ['brotli', await send({ 'content-encoding': 'br' })],
    ['gzip that is not gzip', await send({ 'content-encoding': 'gzip' })],
    ['an encoding nobody has heard of', await send({ 'content-encoding': 'rot13' })],
  ]) {
    assert.ok(res.status === 415 || res.status === 400, `${what} → ${res.status} ${res.text.slice(0, 80)}`)
    assert.ok(typeof res.body?.error === 'string' && typeof res.body?.code === 'string', what)
  }
  assert.equal((await send({ 'content-type': 'application/json; charset=bogus' })).body.code, 'UNSUPPORTED_MEDIA_TYPE')
})

test('every answer from /api says it is not to be kept or guessed at, whatever it is — a refusal and a parse error included', async () => {
  const wrong = []
  const ask = [
    ['GET', '/api/auth/me', mia.token], ['GET', '/api/auth/me'], ['GET', '/api/influencers', mia.token], ['GET', '/api/billing/me', mia.token],
    ['GET', '/api/admin/stats', mia.token], ['GET', '/api/nope'], ['POST', '/api/auth/login'], ['OPTIONS', '/api/influencers'],
  ]
  for (const [method, path, token] of ask) {
    const res = await raw({ method, path, headers: token ? { authorization: `Bearer ${token}` } : {} })
    if (!/no-store/.test(res.headers.get('cache-control') ?? '')) wrong.push(`${method} ${path} (${res.status}) cache-control: ${res.headers.get('cache-control')}`)
    if (res.headers.get('x-content-type-options') !== 'nosniff') wrong.push(`${method} ${path} (${res.status}) has no nosniff`)
  }
  const broken = await raw({ path: '/api/influencers/create', headers: { 'content-type': 'application/json', authorization: `Bearer ${mia.token}` }, body: '{"record":' })
  assert.equal(broken.status, 400)
  if (!/no-store/.test(broken.headers.get('cache-control') ?? '') || broken.headers.get('x-content-type-options') !== 'nosniff') wrong.push('the answer to a body that does not parse')
  assert.deepEqual(wrong, [])
})

test('after all of it the database is intact: nothing orphaned, nothing of another account changed, constraints holding', async () => {
  // A little of everything first.
  for (const [path, template] of POSTS().slice(0, 6)) {
    let n = 0
    for (const [, body] of mutations(template)) { if (n++ % 9 === 0) await stack.api('POST', path, { token: mia.token, body }) }
  }
  for (const [table, column] of [['influencers', 'user_id'], ['assets', 'user_id'], ['generations', 'user_id'], ['generation_jobs', 'user_id'], ['studio_settings', 'user_id'], ['creation_params', 'user_id']]) {
    const orphans = await stack.one(`select count(*)::int as n from ${table} t where not exists (select 1 from users u where u.id = t.${column})`)
    assert.equal(orphans.n, 0, `${table} has rows with no owner`)
  }
  const crossed = await stack.one(
    `select count(*)::int as n from generations g
       join assets a on a.id = g.asset_id
      where a.user_id <> g.user_id`,
  )
  assert.equal(crossed.n, 0, 'no gallery entry points at another account\'s file')
  const wardrobe = await stack.sql(`select user_id, wardrobe_slots, main_asset_id from influencers`)
  for (const row of wardrobe) {
    for (const slot of row.wardrobe_slots || []) {
      if (!slot?.asset_id) continue
      const owner = await stack.one('select user_id from assets where id = $1', [slot.asset_id])
      assert.equal(owner?.user_id, row.user_id, 'a wardrobe slot points at the influencer owner\'s own file')
    }
  }
  assert.equal((await stack.one('select count(*)::int as n from users')).n, 2)
  assert.equal((await stack.api('GET', '/api/auth/me', { token: bob.token })).status, 200)
})
