// Several KIE keys, taken in turn (api/_lib/kieKeys.js, api/admin/kieKeys.js).
//
// Through the real app and the real database, against a stand-in for KIE that knows which key it is spoken to by:
//   · new requests rotate through the server's own key and the keys added in the panel;
//   · KIE refusing a KEY (rate limit, no credits, rejected) moves the request to the next key, and a dropped
//     connection does not, because the task may already exist;
//   · a task is always asked about with the key that started it: the proxy, a sync and the worker;
//   · the keys are sealed, never shown, and everything an admin does with them is audited;
//   · a callback signed with another account's webhook key is accepted.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack, jpeg } from '../helpers/stack.js'

const VAULT = 'vault-secret-for-the-tests-0123456789abcdef'
const OWN = 'test-kie-key'                          // the stack's KIE_API_KEY
const KEY_B = 'bbbb1111bbbb1111bbbb1111bbbb1111'
const KEY_C = 'cccc2222cccc2222cccc2222cccc2222'
const OWN_HOOK = 'own-webhook-hmac-key'
const B_HOOK = 'b-webhook-hmac-key'
const RESULT = 'https://tempfile.aiquickdraw.com/r/out.jpg'

let stack
let admin
const realFetch = globalThis.fetch

before(async () => {
  stack = await startStack({ env: { KEY_VAULT_SECRET: VAULT, KIE_WEBHOOK_SECRET: OWN_HOOK, WORKER_RATE_LIMIT_BACKOFF_MS: '5' } })
  // Results are downloaded from KIE's CDN when a job settles.
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://tempfile.aiquickdraw.com/')) {
      const body = jpeg('IMG-OK')
      return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) } })
    }
    return realFetch(input, init)
  }
})
after(async () => { globalThis.fetch = realFetch; await stack?.stop() })
beforeEach(async () => {
  await stack.reset()
  stack.kie.strictKeys = true            // KIE answers about a task only for the key that started it
  admin = await stack.createUser({ role: 'admin' })
})

// ── Helpers ──────────────────────────────────────────────────────────────────

const TASK = { model: 'kling-3.0/video', input: { prompt: 'a calm lake' } }
const createTask = user => stack.api('POST', '/api/kie/api/v1/jobs/createTask', { token: user.token, body: TASK })
const asAdmin = (method, path, body) => stack.api(method, `/api/admin/kie-keys${path}`, { token: admin.token, body })
const tokenOf = request => request.authorization.replace(/^Bearer /, '')
/** The key each createTask was sent with, in order — refused attempts included. */
const created = () => stack.kie.requests.filter(r => r.path === '/api/v1/jobs/createTask').map(tokenOf)
const polls = taskId => stack.kie.requests.filter(r => r.path === '/api/v1/jobs/recordInfo' && r.query.taskId === taskId).map(tokenOf)
const rowOf = id => stack.one('select * from kie_api_keys where id = $1', [id])
const successData = taskId => ({ taskId, state: 'success', resultJson: JSON.stringify({ resultUrls: [RESULT] }), completeTime: Date.now(), creditsConsumed: 9 })
const register = (user, taskId) => stack.api('POST', '/api/jobs/register', { token: user.token, body: { entries: [{ taskId, kind: 'image', label: 'Image', model: 'nano-banana-pro' }] } })
const jobState = async taskId => (await stack.one('select state from generation_jobs where kie_task_id = $1', [taskId]))?.state

async function addKey(label, key, extra = {}) {
  const res = await asAdmin('POST', '/add', { label, key, ...extra })
  assert.equal(res.status, 200, res.text)
  return res.body.key
}

/** Run with an environment value changed, and put it back whatever happens. */
async function withEnv(name, value, fn) {
  const before = process.env[name]
  process.env[name] = value
  try { return await fn() } finally { if (before === undefined) delete process.env[name]; else process.env[name] = before }
}

// ── The rotation ─────────────────────────────────────────────────────────────

test('new requests go to the server\'s own key and the added keys in turn', async () => {
  const u = await stack.createUser()
  await addKey('Account B', KEY_B)
  await addKey('Account C', KEY_C)
  for (let i = 0; i < 6; i++) assert.equal((await createTask(u)).status, 200)
  assert.deepEqual(created(), [OWN, KEY_B, KEY_C, OWN, KEY_B, KEY_C])
})

test('with no key added the server\'s own key does everything, as before', async () => {
  const u = await stack.createUser()
  for (let i = 0; i < 3; i++) assert.equal((await createTask(u)).status, 200)
  assert.deepEqual(created(), [OWN, OWN, OWN])
})

test('requests that arrive together are spread over the keys, not piled on one', async () => {
  await addKey('Account B', KEY_B)
  await addKey('Account C', KEY_C)
  const users = await Promise.all(Array.from({ length: 10 }, () => stack.createUser()))
  const results = await Promise.all(users.flatMap(u => [createTask(u), createTask(u), createTask(u)]))
  assert.ok(results.every(r => r.status === 200), 'every one of them was served')
  const counts = {}
  for (const key of created()) counts[key] = (counts[key] ?? 0) + 1
  assert.deepEqual(counts, { [OWN]: 10, [KEY_B]: 10, [KEY_C]: 10 })
})

test('a key that has been used keeps its place in the record, and a new key is tried first', async () => {
  const u = await stack.createUser()
  await createTask(u)
  await createTask(u)
  await addKey('Account B', KEY_B)
  await createTask(u)
  assert.deepEqual(created(), [OWN, OWN, KEY_B])
  const b = await stack.one(`select uses, last_used_at from kie_api_keys where label = 'Account B'`)
  assert.equal(Number(b.uses), 1)
  assert.ok(b.last_used_at)
})

// ── A task stays with the key that started it ────────────────────────────────

test('the proxy asks KIE about a task with the key that started it', async () => {
  const u = await stack.createUser()
  await addKey('Account B', KEY_B)
  await addKey('Account C', KEY_C)
  const taskIds = []
  for (let i = 0; i < 3; i++) taskIds.push((await createTask(u)).body.data.taskId)
  const startedWith = created()
  assert.deepEqual(startedWith, [OWN, KEY_B, KEY_C])

  for (const [i, taskId] of taskIds.entries()) {
    stack.kie.tasks.set(taskId, successData(taskId))
    const res = await stack.api('GET', `/api/kie/api/v1/jobs/recordInfo?taskId=${taskId}`, { token: u.token })
    assert.equal(res.body.code, 200, `task ${i + 1} was not found: the wrong key was used`)
    assert.deepEqual(polls(taskId), [startedWith[i]])
  }
  const owners = await stack.sql('select t.kie_task_id, k.label from task_owners t left join kie_api_keys k on k.id = t.kie_key_id order by t.created_at')
  assert.deepEqual(owners.map(o => o.label), ['Server key (.env)', 'Account B', 'Account C'])
})

test('a sync asks KIE with the key that started the task', async () => {
  const u = await stack.createUser()
  await addKey('Account B', KEY_B)
  await createTask(u)                                         // the server's own key
  const taskId = (await createTask(u)).body.data.taskId       // Account B
  await register(u, taskId)
  stack.kie.tasks.set(taskId, successData(taskId))
  const res = await stack.api('GET', `/api/jobs/sync?taskId=${taskId}`, { token: u.token })
  assert.equal(res.status, 200)
  assert.equal(res.body.status.state, 'success')
  assert.deepEqual(polls(taskId), [KEY_B])
  assert.ok(!('keyId' in res.body.status) && !res.text.includes(KEY_B), 'which key it was is nobody\'s business but the server\'s')
})

test('the worker polls each running job with its own key and settles them all', async () => {
  const u = await stack.createUser()
  await addKey('Account B', KEY_B)
  await addKey('Account C', KEY_C)
  const taskIds = []
  for (let i = 0; i < 3; i++) taskIds.push((await createTask(u)).body.data.taskId)
  for (const taskId of taskIds) { await register(u, taskId); stack.kie.tasks.set(taskId, successData(taskId)) }

  const { cycle } = await stack.load('server/worker.js')
  await cycle()
  for (const taskId of taskIds) assert.equal(await jobState(taskId), 'success', taskId)
  assert.deepEqual(taskIds.map(id => polls(id)[0]), [OWN, KEY_B, KEY_C])
})

test('a task started before the pool existed (no key recorded) is followed with the server\'s own key', async () => {
  const u = await stack.createUser()
  await addKey('Account B', KEY_B)
  stack.kie.tasks.set('old-task', successData('old-task'))
  await stack.sql('insert into task_owners (kie_task_id, user_id) values ($1, $2)', ['old-task', u.id])
  const res = await stack.api('GET', '/api/kie/api/v1/jobs/recordInfo?taskId=old-task', { token: u.token })
  assert.equal(res.body.code, 200)
  assert.deepEqual(polls('old-task'), [OWN])
})

// ── KIE refuses a key ────────────────────────────────────────────────────────

const REFUSALS = [
  ['rate limited (HTTP 429)', { status: 429, body: { code: 429, msg: 'Rate limited' } }, 'rate_limited'],
  ['rate limited (inside an HTTP 200)', { status: 200, body: { code: 429, msg: 'Rate limited' } }, 'rate_limited'],
  ['out of credits (HTTP 402)', { status: 402, body: { code: 402, msg: 'Insufficient credits' } }, 'no_credits'],
  ['out of credits (inside an HTTP 200)', { status: 200, body: { code: 402, msg: 'Insufficient credits' } }, 'no_credits'],
  ['rejected (HTTP 401)', { status: 401, body: { code: 401, msg: 'Unauthorized' } }, 'rejected'],
  ['rejected (inside an HTTP 200)', { status: 200, body: { code: 401, msg: 'Unauthorized' } }, 'rejected'],
]

for (const [name, answer, problem] of REFUSALS) {
  test(`KIE refusing a key (${name}) moves the request to the next key and notes why`, async () => {
    const u = await stack.createUser()
    const b = await addKey('Account B', KEY_B)
    await addKey('Account C', KEY_C)
    stack.kie.byKey.set(KEY_B, { answer })

    const first = await createTask(u)                       // the server's own key
    const second = await createTask(u)                      // Account B's turn: refused, so Account C
    assert.equal(first.status, 200)
    assert.equal(second.status, 200, 'the person never sees the refusal')
    assert.ok(second.body.data.taskId)
    assert.deepEqual(created(), [OWN, KEY_B, KEY_C])

    const row = await rowOf(b.id)
    assert.equal(row.problem, problem)
    assert.ok(new Date(row.cooldown_until) > new Date(), 'and it waits at the back of the line')
  })
}

test('a refused key is left alone until its wait is over, then tried again and cleared when it works', async () => {
  const u = await stack.createUser()
  const b = await addKey('Account B', KEY_B)
  await addKey('Account C', KEY_C)
  stack.kie.byKey.set(KEY_B, { answer: REFUSALS[0][1] })
  for (let i = 0; i < 6; i++) assert.equal((await createTask(u)).status, 200)
  assert.equal(created().filter(k => k === KEY_B).length, 1, 'asked once, refused, then not asked again')

  // KIE lets it through again, and its wait is over: it has been idle longest, so it goes next.
  stack.kie.byKey.delete(KEY_B)
  await stack.sql(`update kie_api_keys set cooldown_until = now() - interval '1 second' where id = $1`, [b.id])
  await createTask(u)
  assert.equal(created().at(-1), KEY_B)
  const row = await rowOf(b.id)
  assert.equal(row.problem, null)
  assert.equal(row.cooldown_until, null)
})

test('when every key is refused the person gets KIE\'s refusal as it came, after each key was tried once', async () => {
  const u = await stack.createUser()
  await addKey('Account B', KEY_B)
  await addKey('Account C', KEY_C)
  for (const key of [OWN, KEY_B, KEY_C]) stack.kie.byKey.set(key, { answer: { status: 429, body: { code: 429, msg: 'Rate limited' } } })
  const res = await createTask(u)
  assert.equal(res.status, 429)
  assert.deepEqual(res.body, { code: 429, msg: 'Rate limited' })
  assert.deepEqual([...created()].sort(), [OWN, KEY_B, KEY_C].sort(), 'each key once')

  // Asking again goes on trying them: a key that MIGHT be free again is worth a question.
  stack.kie.byKey.delete(KEY_C)
  assert.equal((await createTask(u)).status, 200)
})

test('when every key is rejected the person is told generation is unavailable, not that their session ended', async () => {
  const u = await stack.createUser()
  await addKey('Account B', KEY_B)
  for (const key of [OWN, KEY_B]) stack.kie.byKey.set(key, { answer: { status: 401, body: { code: 401, msg: 'Unauthorized' } } })
  const res = await createTask(u)
  assert.equal(res.status, 502)
  assert.equal(res.body.code, 'ENGINE_KEY_REJECTED')
})

test('a dropped connection is not tried on another key, because the task may already exist', async () => {
  const u = await stack.createUser()
  await addKey('Account B', KEY_B)
  await addKey('Account C', KEY_C)
  stack.kie.byKey.set(KEY_B, { drop: true })
  assert.equal((await createTask(u)).status, 200)          // the server's own key
  const cut = await createTask(u)                           // Account B: the connection is cut mid-request
  assert.equal(cut.status, 502)
  assert.equal(cut.body.code, 'ENGINE_UNREACHABLE')
  assert.deepEqual(created(), [OWN, KEY_B], 'Account C was not asked: a second task could have been started')
})

test('the engine check works while some keys are refused, and the balance stays hidden', async () => {
  const u = await stack.createUser()
  await addKey('Account B', KEY_B)
  stack.kie.byKey.set(OWN, { answer: { status: 200, body: { code: 402, msg: 'Insufficient credits' } } })
  const res = await stack.api('GET', '/api/kie/api/v1/chat/credit', { token: u.token })
  assert.equal(res.status, 200)
  assert.equal(res.body.code, 200, 'one working key is enough for generation to work')
  assert.equal(res.body.data, null)
})

// ── Pausing, and a key that cannot be opened ─────────────────────────────────

test('a paused key is left out of the rotation, the server\'s own key can be paused too, and a running task is still followed', async () => {
  const u = await stack.createUser()
  const b = await addKey('Account B', KEY_B)
  const c = await addKey('Account C', KEY_C)
  const ownRow = await stack.one(`select id from kie_api_keys where source = 'env'`)
  const earlier = (await createTask(u)).body.data.taskId       // the server's own key
  stack.kie.tasks.set(earlier, successData(earlier))

  assert.equal((await asAdmin('POST', '/update', { id: b.id, enabled: false })).status, 200)
  for (let i = 0; i < 4; i++) await createTask(u)
  assert.ok(!created().slice(1).includes(KEY_B), 'Account B took no turn while paused')

  assert.equal((await asAdmin('POST', '/update', { id: ownRow.id, enabled: false })).status, 200)
  const before = created().length
  for (let i = 0; i < 3; i++) await createTask(u)
  assert.deepEqual(created().slice(before), [KEY_C, KEY_C, KEY_C], 'only Account C was left')

  assert.equal((await asAdmin('POST', '/update', { id: c.id, enabled: false })).status, 200)
  const none = await createTask(u)
  assert.equal(none.status, 503)
  assert.equal(none.body.code, 'ENGINE_NOT_CONFIGURED')
  assert.equal(created().length, before + 3, 'nothing was sent')

  // Pausing stops new work only: a task already running with a paused key is still followed with it.
  const followed = await stack.api('GET', `/api/kie/api/v1/jobs/recordInfo?taskId=${earlier}`, { token: u.token })
  assert.equal(followed.body.code, 200)

  assert.equal((await asAdmin('POST', '/update', { id: b.id, enabled: true })).status, 200)
  assert.equal((await createTask(u)).status, 200)
  assert.equal(created().at(-1), KEY_B)
})

test('a key sealed under another KEY_VAULT_SECRET is skipped and flagged, never a failure, and works again when the secret is back', async () => {
  const u = await stack.createUser()
  const b = await addKey('Account B', KEY_B)
  await withEnv('KEY_VAULT_SECRET', 'a-different-vault-secret-0123456789abcdef', async () => {
    for (let i = 0; i < 4; i++) assert.equal((await createTask(u)).status, 200)
    assert.deepEqual(created(), [OWN, OWN, OWN, OWN], 'the key that cannot be opened took no turn')
    const listed = (await asAdmin('GET', '')).body
    assert.equal(listed.keys.find(k => k.id === b.id).state, 'unreadable')
    const checked = await asAdmin('POST', '/check', { id: b.id })
    assert.equal(checked.status, 409)
    assert.equal(checked.body.code, 'KEY_UNREADABLE')
  })
  await stack.sql('update kie_api_keys set cooldown_until = null, problem = null where id = $1', [b.id])
  await createTask(u)
  await createTask(u)
  assert.ok(created().slice(4).includes(KEY_B))
  assert.equal((await asAdmin('GET', '')).body.keys.find(k => k.id === b.id).state, 'active')
})

// ── The worker, when one key is rate limited ─────────────────────────────────

test('a key KIE rate-limits holds back only its own jobs; the others are settled in the same cycle', async () => {
  const u = await stack.createUser()
  const b = await addKey('Account B', KEY_B)
  const a = (await createTask(u)).body.data.taskId             // the server's own key
  const bTask = (await createTask(u)).body.data.taskId         // Account B
  for (const taskId of [a, bTask]) { await register(u, taskId); stack.kie.tasks.set(taskId, successData(taskId)) }
  stack.kie.byKey.set(KEY_B, { answer: { status: 429, body: { code: 429, msg: 'Rate limited' } } })

  const { cycle } = await stack.load('server/worker.js')
  await cycle()
  assert.equal(await jobState(a), 'success', 'the job on the free key was settled')
  assert.notEqual(await jobState(bTask), 'success', 'the job on the limited key waits')
  assert.equal((await rowOf(b.id)).problem, 'rate_limited')

  stack.kie.byKey.delete(KEY_B)
  await cycle()
  assert.equal(await jobState(bTask), 'success', 'and is settled once KIE lets that key through')
})

// ── Callbacks from another KIE account ───────────────────────────────────────

const sign = async (taskId, secret) => {
  const { signPayload } = await stack.load('api/kie-callback.js')
  const timestamp = Math.floor(Date.now() / 1000)
  return { 'x-webhook-timestamp': String(timestamp), 'x-webhook-signature': signPayload(taskId, timestamp, secret) }
}
const callback = async (taskId, secret) => stack.api('POST', '/webhooks/kie', {
  body: { code: 200, data: successData(taskId) }, headers: await sign(taskId, secret),
})

test('a task asks for a callback only if this server holds the webhook key of the account that will send it', async () => {
  const u = await stack.createUser()
  await addKey('Account B', KEY_B, { webhookSecret: B_HOOK })
  await addKey('Account C', KEY_C)                          // no webhook key stored
  for (let i = 0; i < 3; i++) await createTask(u)
  const sent = stack.kie.requests.filter(r => r.path === '/api/v1/jobs/createTask')
  assert.equal(sent[0].body.callBackUrl, 'https://api.test.example/webhooks/kie', 'the server\'s own key: KIE_WEBHOOK_SECRET')
  assert.equal(sent[1].body.callBackUrl, 'https://api.test.example/webhooks/kie', 'Account B: its own webhook key is stored')
  assert.equal('callBackUrl' in sent[2].body, false, 'Account C: nothing could verify it, so the worker collects instead')
})

test('a callback signed with the webhook key stored for Account B is accepted, like one signed with the server\'s own; any other is refused', async () => {
  const u = await stack.createUser()
  await addKey('Account B', KEY_B, { webhookSecret: B_HOOK })
  await createTask(u)
  const bTask = (await createTask(u)).body.data.taskId
  await register(u, bTask)

  assert.equal((await callback(bTask, 'a-secret-nobody-has')).status, 401)
  assert.notEqual(await jobState(bTask), 'success')

  assert.equal((await callback(bTask, B_HOOK)).status, 200)
  await stack.waitFor(async () => (await jobState(bTask)) === 'success', { what: 'the callback to settle the job' })

  const ownTask = (await createTask(u)).body.data.taskId
  await register(u, ownTask)
  assert.equal((await callback(ownTask, OWN_HOOK)).status, 200)
  await stack.waitFor(async () => (await jobState(ownTask)) === 'success', { what: 'the server\'s own webhook key to be accepted too' })
})

// ── The admin endpoints ──────────────────────────────────────────────────────

test('the list starts with the server\'s own key and says whether keys can be stored', async () => {
  const res = await asAdmin('GET', '')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'private, no-store')
  assert.equal(res.body.vault.configured, true)
  assert.equal(res.body.keys.length, 1)
  const [own] = res.body.keys
  assert.equal(own.source, 'env')
  assert.equal(own.state, 'active')
  assert.equal(own.hint, '…-key', 'only the end of it')
  assert.equal(own.callbacks, true)
  assert.ok(!res.text.includes(OWN), 'never the key itself')
  assert.equal((await withEnv('KEY_VAULT_SECRET', '', () => asAdmin('GET', ''))).body.vault.configured, false)
  assert.equal((await withEnv('KIE_API_KEY', '', () => asAdmin('GET', ''))).body.keys[0].state, 'missing')
})

test('only an administrator may use these endpoints', async () => {
  const u = await stack.createUser()
  for (const [method, path, body] of [['GET', ''], ['POST', '/add', { label: 'x', key: KEY_B }], ['POST', '/update', { id: 'x' }], ['POST', '/check', { id: 'x' }], ['POST', '/delete', { id: 'x' }]]) {
    assert.equal((await stack.api(method, `/api/admin/kie-keys${path}`, { token: u.token, body })).status, 403, path)
    assert.equal((await stack.api(method, `/api/admin/kie-keys${path}`, { body })).status, 401, path)
  }
  assert.equal((await stack.sql(`select 1 from kie_api_keys where source = 'panel'`)).length, 0)
})

test('adding a key: asked of KIE first, sealed in the database, never shown again, and audited without it', async () => {
  const added = await addKey('Account B', KEY_B, { webhookSecret: B_HOOK })
  assert.equal(added.label, 'Account B')
  assert.equal(added.source, 'panel')
  assert.equal(added.hint, '…1111')
  assert.equal(added.state, 'active')
  assert.equal(added.balance, 12345, 'what KIE said was left on it')
  assert.equal(added.callbacks, true)
  assert.deepEqual(stack.kie.requests.filter(r => r.path === '/api/v1/chat/credit').map(tokenOf), [KEY_B], 'KIE was asked with the new key')

  const row = await rowOf(added.id)
  assert.match(row.key_enc, /^v1\./)
  assert.match(row.webhook_enc, /^v1\./)
  for (const secret of [KEY_B, B_HOOK]) {
    assert.ok(!JSON.stringify(row).includes(secret), 'the database holds ciphertext only')
    assert.ok(!(await asAdmin('GET', '')).text.includes(secret), 'and the list never shows it')
    assert.ok(!JSON.stringify(added).includes(secret))
  }
  const [entry] = await stack.sql(`select admin_email, target_id, details from admin_audit_log where action = 'kie-key.add'`)
  assert.equal(entry.admin_email, admin.email)
  assert.equal(entry.target_id, added.id)
  assert.deepEqual(entry.details, { label: 'Account B', hint: '…1111', checked: true, webhookKey: true })
  assert.ok(!JSON.stringify(entry).includes(KEY_B))

  // The sealed value opens only for its own row.
  const { unseal } = await stack.load('api/_lib/keyVault.js')
  assert.equal(unseal(row.key_enc, `kie-key:${added.id}`), KEY_B)
  assert.throws(() => unseal(row.key_enc, 'kie-key:another-row'))
})

test('a key is refused when it is a duplicate, malformed, not accepted by KIE, or the vault is not set up, and then nothing is stored', async () => {
  await addKey('Account B', KEY_B)
  const refused = async (body, status, code) => {
    const res = await asAdmin('POST', '/add', body)
    assert.equal(res.status, status, JSON.stringify(body))
    if (code) assert.equal(res.body.code, code)
    return res
  }
  await refused({ label: 'Again', key: KEY_B }, 409, 'DUPLICATE_KEY')
  await refused({ label: 'Padded', key: `  ${KEY_B}  ` }, 409, 'DUPLICATE_KEY')
  await withEnv('KIE_API_KEY', KEY_C, () => refused({ label: 'The server\'s own', key: KEY_C }, 409, 'DUPLICATE_KEY'))
  await refused({ label: 'Short', key: 'short' }, 400)
  await refused({ label: 'Spaces', key: 'aaaa bbbb cccc dddd eeee' }, 400)
  await refused({ label: 'Control', key: `${KEY_C}\n${KEY_C}` }, 400)
  await refused({ label: 'Long', key: 'x'.repeat(257) }, 400)
  await refused({ label: 'No key' }, 400)
  await refused({ key: KEY_C }, 400)
  await refused({ label: '   ', key: KEY_C }, 400)
  await refused({ label: 'x'.repeat(61), key: KEY_C }, 400)
  await refused({ label: 'Number', key: 12345678901234567890 }, 400)
  await refused({ label: 'Webhook too short', key: KEY_C, webhookSecret: 'abc' }, 400)

  stack.kie.byKey.set(KEY_C, { answer: { status: 401, body: { code: 401, msg: 'Unauthorized' } } })
  await refused({ label: 'Wrong key', key: KEY_C }, 422, 'KEY_REJECTED')
  stack.kie.byKey.set(KEY_C, { drop: true })
  await refused({ label: 'Offline', key: KEY_C }, 502, 'KIE_UNREACHABLE')
  assert.equal((await stack.sql(`select 1 from kie_api_keys where source = 'panel'`)).length, 1, 'only Account B was kept')

  const unchecked = await asAdmin('POST', '/add', { label: 'Added unchecked', key: KEY_C, verify: false })
  assert.equal(unchecked.status, 200, 'verify: false keeps a key without asking KIE (for when KIE is down)')
  assert.equal(unchecked.body.key.balance, null)

  await withEnv('KEY_VAULT_SECRET', 'too short', () => refused({ label: 'No vault', key: 'dddd3333dddd3333dddd3333dddd3333' }, 503, 'VAULT_NOT_CONFIGURED'))
})

test('a key can be renamed, paused, given a webhook key or have it removed, each audited; the server\'s own key has no webhook key here', async () => {
  const b = await addKey('Account B', KEY_B)
  const ownRow = await stack.one(`select id from kie_api_keys where source = 'env'`)

  const renamed = await asAdmin('POST', '/update', { id: b.id, label: 'Account B (spare)' })
  assert.equal(renamed.body.key.label, 'Account B (spare)')
  assert.equal(renamed.body.key.callbacks, false)
  const paused = await asAdmin('POST', '/update', { id: b.id, enabled: false })
  assert.equal(paused.body.key.state, 'paused')
  const hooked = await asAdmin('POST', '/update', { id: b.id, webhookSecret: B_HOOK })
  assert.equal(hooked.body.key.callbacks, true)
  assert.match((await rowOf(b.id)).webhook_enc, /^v1\./)
  const unhooked = await asAdmin('POST', '/update', { id: b.id, webhookSecret: null })
  assert.equal(unhooked.body.key.callbacks, false)
  assert.equal((await rowOf(b.id)).webhook_enc, null)

  assert.equal((await asAdmin('POST', '/update', { id: ownRow.id, webhookSecret: B_HOOK })).status, 400)
  assert.equal((await asAdmin('POST', '/update', { id: ownRow.id, enabled: false })).body.key.state, 'paused')

  assert.equal((await asAdmin('POST', '/update', { id: b.id })).status, 400, 'nothing to change')
  assert.equal((await asAdmin('POST', '/update', { id: b.id, enabled: 'yes' })).status, 400)
  assert.equal((await asAdmin('POST', '/update', { id: b.id, label: '' })).status, 400)
  assert.equal((await asAdmin('POST', '/update', { id: 'not-an-id', enabled: true })).status, 400)
  assert.equal((await asAdmin('POST', '/update', { id: '11111111-1111-4111-8111-111111111111', enabled: true })).status, 404)

  const log = await stack.sql(`select details from admin_audit_log where action = 'kie-key.update' order by id`)
  assert.equal(log.length, 5)
  assert.deepEqual(log[2].details, { label: 'Account B (spare)', webhookKey: 'set' })
  assert.ok(!JSON.stringify(log).includes(B_HOOK))
})

test('Check asks KIE what is left, clears an earlier refusal, and flags a key KIE no longer accepts', async () => {
  const u = await stack.createUser()
  const b = await addKey('Account B', KEY_B)
  await addKey('Account C', KEY_C)
  stack.kie.byKey.set(KEY_B, { answer: { status: 200, body: { code: 402, msg: 'Insufficient credits' } } })
  await createTask(u)
  await createTask(u)
  assert.equal((await rowOf(b.id)).problem, 'no_credits')

  // The account is topped up; a person presses Check.
  stack.kie.byKey.delete(KEY_B)
  const ok = await asAdmin('POST', '/check', { id: b.id })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.result, 'ok')
  assert.equal(ok.body.key.balance, 12345)
  assert.equal(ok.body.key.state, 'active')
  assert.equal(ok.body.key.problem, null)
  assert.ok(ok.body.key.balanceAt)

  stack.kie.byKey.set(KEY_B, { answer: { status: 401, body: { code: 401, msg: 'Unauthorized' } } })
  const rejected = await asAdmin('POST', '/check', { id: b.id })
  assert.equal(rejected.body.result, 'rejected')
  assert.equal(rejected.body.key.state, 'cooling')
  assert.equal(rejected.body.key.problem, 'rejected')

  stack.kie.byKey.set(KEY_B, { drop: true })
  assert.equal((await asAdmin('POST', '/check', { id: b.id })).status, 502)
  assert.equal((await asAdmin('POST', '/check', { id: '11111111-1111-4111-8111-111111111111' })).status, 404)
  assert.equal((await asAdmin('POST', '/check', { id: 'nope' })).status, 400)
  const ownRow = await stack.one(`select id from kie_api_keys where source = 'env'`)
  assert.equal((await asAdmin('POST', '/check', { id: ownRow.id })).body.result, 'ok')
  assert.equal((await withEnv('KIE_API_KEY', '', () => asAdmin('POST', '/check', { id: ownRow.id }))).status, 400)
})

test('a key cannot be removed while a generation started with it is running, nor can the server\'s own', async () => {
  const u = await stack.createUser()
  const b = await addKey('Account B', KEY_B)
  const ownRow = await stack.one(`select id from kie_api_keys where source = 'env'`)
  await createTask(u)
  const bTask = (await createTask(u)).body.data.taskId
  await register(u, bTask)

  const own = await asAdmin('POST', '/delete', { id: ownRow.id })
  assert.equal(own.status, 400)
  const busy = await asAdmin('POST', '/delete', { id: b.id })
  assert.equal(busy.status, 409)
  assert.equal(busy.body.code, 'KEY_IN_USE')
  assert.match(busy.body.error, /1 generation is still running/)
  assert.ok(await rowOf(b.id), 'and it is still there')

  stack.kie.tasks.set(bTask, successData(bTask))
  await stack.api('GET', `/api/jobs/sync?taskId=${bTask}`, { token: u.token })
  assert.equal(await jobState(bTask), 'success')

  assert.equal((await asAdmin('POST', '/delete', { id: b.id })).status, 200)
  assert.equal(await rowOf(b.id), null)
  assert.equal((await stack.one('select kie_key_id from task_owners where kie_task_id = $1', [bTask])).kie_key_id, null, 'what it started is kept, with no key named')
  assert.equal((await asAdmin('POST', '/delete', { id: b.id })).status, 404)
  const [entry] = await stack.sql(`select details from admin_audit_log where action = 'kie-key.delete'`)
  assert.deepEqual(entry.details, { label: 'Account B' })
  assert.deepEqual((await asAdmin('GET', '')).body.keys.map(k => k.source), ['env'])
})

test('the list counts what is running on each key and when each was last used', async () => {
  const u = await stack.createUser()
  const b = await addKey('Account B', KEY_B)
  const ownTask = (await createTask(u)).body.data.taskId
  const bTask = (await createTask(u)).body.data.taskId
  const b2 = (await createTask(u)).body.data.taskId       // the server's own key again
  void b2
  for (const id of [ownTask, bTask]) await register(u, id)
  const keys = (await asAdmin('GET', '')).body.keys
  const own = keys.find(k => k.source === 'env')
  const listedB = keys.find(k => k.id === b.id)
  assert.deepEqual([own.uses, listedB.uses], [2, 1])
  assert.deepEqual([own.running, listedB.running], [1, 1])
  assert.ok(own.lastUsedAt && listedB.lastUsedAt)
})

// ── The start-up log ─────────────────────────────────────────────────────────

test('at start-up the log says how many keys take turns, and when keys added in the panel cannot be used', async () => {
  const { describeKeyPool } = await stack.load('api/_lib/kieKeys.js')
  assert.deepEqual(await describeKeyPool(), [{ level: 'info', text: 'KIE keys taking turns: 1 (the server\'s own key).' }])

  await addKey('Account B', KEY_B)
  assert.deepEqual(await describeKeyPool(), [{ level: 'info', text: 'KIE keys taking turns: 2 (the server\'s own key and 1 added in the admin panel).' }])

  await withEnv('KEY_VAULT_SECRET', '', async () => {
    const lines = await describeKeyPool()
    assert.match(lines[0].text, /taking turns: 1 \(/, 'the panel key cannot be opened, so it does not count')
    assert.equal(lines[1].level, 'error')
    assert.match(lines[1].text, /KEY_VAULT_SECRET is not set/)
  })
  await withEnv('KIE_API_KEY', '', () => withEnv('KEY_VAULT_SECRET', '', async () => {
    const [first] = await describeKeyPool()
    assert.equal(first.level, 'error')
    assert.match(first.text, /No KIE key is in rotation/)
  }))
})
