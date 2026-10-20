// Security: one account must never reach another's data (horizontal access).
//
// Alice owns a complete set of things — an influencer, a file, a gallery entry, a job, settings,
// creation parameters, credits. Bob, an ordinary signed-in account, tries every endpoint that takes
// an id against Alice's ids. Each attempt must be refused or answer as if the thing did not exist,
// and afterwards the database must show that nothing of Alice's was read, changed or removed.
// Alice's own calls are made too, so a refusal cannot be a vacuous one (the thing really is there).

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

import { startStack, jpeg } from '../helpers/stack.js'

let stack
let alice, bob
let aInfluencer, aAsset, aGeneration, aJob, aTask

before(async () => {
  stack = await startStack()
  alice = await stack.createUser({ email: 'alice@test.example' })
  bob = await stack.createUser({ email: 'bob@test.example' })

  const made = await stack.api('POST', '/api/influencers/create', {
    token: alice.token,
    body: { record: { name: 'Alice Persona', backstory: 'private story' }, creationParams: { prompt: 'alice secret params' } },
  })
  aInfluencer = made.body.influencer.id

  aAsset = await stack.putAsset({ userId: alice.id, bytes: jpeg('IMG-OK'), influencerId: aInfluencer })
  const gen = await stack.api('POST', '/api/generations/add', { token: alice.token, body: { assetId: aAsset.id, influencerId: aInfluencer, label: 'alice clip' } })
  aGeneration = gen.body.generation.id

  aTask = 'alice-task-0001'
  const registered = await stack.api('POST', '/api/jobs/register', { token: alice.token, body: { entries: [{ taskId: aTask, influencerId: aInfluencer, label: 'alice job' }] } })
  aJob = registered.body.jobs[0].id

  await stack.api('POST', '/api/studio-settings', { token: alice.token, body: { influencerId: aInfluencer, settings: { scene: 'alice private scene' } } })
  await stack.sql(`insert into credit_ledger (user_id, kind, delta, ref, note) values ($1, 'grant', 500, 'authz-seed', 'seed')`, [alice.id])
})
after(async () => { await stack?.stop() })

const as = who => ({
  get: (path) => stack.api('GET', path, { token: who.token }),
  post: (path, body) => stack.api('POST', path, { token: who.token, body }),
})
const A = () => as(alice)
const B = () => as(bob)
const countOf = async (table, where, params) => (await stack.one(`select count(*)::int as n from ${table} where ${where}`, params)).n

// ── The positive controls: Alice can see and use her own things ──────────────

test('control: Alice reaches all of her own data through the same endpoints', async () => {
  assert.equal((await A().get('/api/influencers')).body.influencers.length, 1)
  assert.equal((await A().get(`/api/generations/by-influencer?influencerId=${aInfluencer}`)).body.generations.length, 1)
  assert.equal((await A().get(`/api/generations/by-asset?assetId=${aAsset.id}`)).body.generation.id, aGeneration)
  assert.equal((await A().get(`/api/jobs/by-task?taskId=${aTask}`)).body.job.id, aJob)
  assert.equal((await A().get(`/api/studio-settings?influencerId=${aInfluencer}`)).body.settings.scene, 'alice private scene')
  assert.equal((await A().get(`/api/creation-params?influencerId=${aInfluencer}`)).body.params.prompt, 'alice secret params')
  const url = await A().post('/api/storage/download-url', { assetIds: [aAsset.id] })
  assert.ok(url.body.urls[aAsset.id]?.url, 'her file has a download link')
  assert.equal((await A().get('/api/billing/me')).body.balance, 500)
})

// ── Reading ──────────────────────────────────────────────────────────────────

test('Bob cannot read any of Alice\'s data, by list or by id', async () => {
  assert.deepEqual((await B().get('/api/influencers')).body.influencers, [])
  assert.deepEqual((await B().get(`/api/generations/by-influencer?influencerId=${aInfluencer}`)).body.generations, [])
  assert.equal((await B().get(`/api/generations/by-asset?assetId=${aAsset.id}`)).body.generation, null)
  assert.equal((await B().get(`/api/jobs/by-task?taskId=${aTask}`)).body.job, null)
  assert.deepEqual((await B().get('/api/jobs')).body.jobs, [])
  assert.deepEqual((await B().get('/api/jobs?active=1')).body.jobs, [])
  assert.equal((await B().get(`/api/jobs/active-count?influencerId=${aInfluencer}`)).body.count, 0)
  assert.equal((await B().get(`/api/studio-settings?influencerId=${aInfluencer}`)).body.settings, null)
  assert.equal((await B().get(`/api/creation-params?influencerId=${aInfluencer}`)).body.params, null)
  assert.equal((await B().get('/api/billing/me')).body.balance, 0, 'Alice\'s credits are not Bob\'s')

  const urls = await B().post('/api/storage/download-url', { assetIds: [aAsset.id, aAsset.id.toUpperCase()] })
  assert.deepEqual(urls.body.urls, {}, 'a file that is not yours is simply absent')
  assert.equal(JSON.stringify(urls.body).includes(aAsset.key), false, 'the storage key never appears')

  const changes = await B().get('/api/jobs/changes?since=2000-01-01T00:00:00Z')
  assert.deepEqual(changes.body.jobs, [])
})

// ── Writing: nothing of Alice's may change ───────────────────────────────────

test('Bob cannot change or delete Alice\'s influencer, file, gallery entry or job — and nothing of hers moves', async () => {
  const before = {
    influencer: await stack.one('select name, backstory, updated_at from influencers where id = $1', [aInfluencer]),
    asset: await stack.one('select s3_key from assets where id = $1', [aAsset.id]),
  }

  assert.equal((await B().post('/api/influencers/update', { id: aInfluencer, patch: { name: 'HACKED', backstory: 'HACKED' } })).status, 404)
  assert.equal((await B().post('/api/influencers/delete', { influencerId: aInfluencer })).status, 404)
  assert.equal((await B().post('/api/generations/delete', { generationId: aGeneration })).status, 204, 'answers as if already gone')
  assert.equal((await B().post('/api/storage/delete', { assetId: aAsset.id })).status, 204, 'answers as if already gone')
  assert.equal((await B().post('/api/storage/confirm', { assetId: aAsset.id })).status, 404)
  assert.equal((await B().post('/api/jobs/remove', { id: aJob })).status, 204)
  assert.equal((await B().post('/api/jobs/clear-settled', {})).status, 204)

  assert.deepEqual(await stack.one('select name, backstory, updated_at from influencers where id = $1', [aInfluencer]), before.influencer)
  assert.ok(await stack.one('select 1 from assets where id = $1', [aAsset.id]), 'her file row is still there')
  assert.ok(stack.s3.objects.has(before.asset.s3_key), 'and so is the object in the bucket')
  assert.ok(await stack.one('select 1 from generations where id = $1', [aGeneration]), 'her gallery entry is still there')
  assert.ok(await stack.one('select 1 from generation_jobs where id = $1', [aJob]), 'her job is still there')
})

test('Bob cannot attach Alice\'s files or influencer to anything of his own', async () => {
  const mine = (await B().post('/api/influencers/create', { record: { name: 'Bob Persona' } })).body.influencer.id
  const bAsset = await stack.putAsset({ userId: bob.id, bytes: jpeg('IMG-OK') })

  for (const column of ['main_asset_id', 'reference_asset_id', 'character_sheet_asset_id', 'closeup1_asset_id', 'closeup2_asset_id']) {
    const res = await B().post('/api/influencers/update', { id: mine, patch: { [column]: aAsset.id } })
    assert.equal(res.status, 403, `${column} -> Alice's file`)
  }
  assert.equal((await B().post('/api/influencers/update', { id: mine, patch: { wardrobe_slots: [{ asset_id: aAsset.id }] } })).status, 403, 'a wardrobe slot too')
  assert.equal((await B().post('/api/influencers/create', { record: { name: 'x', main_asset_id: aAsset.id } })).status, 403)
  assert.equal((await B().post('/api/influencers/create', { record: { name: 'x' }, linkAssetIds: [aAsset.id] })).status, 403)

  assert.equal((await B().post('/api/generations/add', { assetId: aAsset.id })).status, 403, 'filing her file in his gallery')
  assert.equal((await B().post('/api/generations/add', { assetId: bAsset.id, influencerId: aInfluencer })).status, 403, 'filing his file under her influencer')
  assert.equal((await B().post('/api/jobs/register', { entries: [{ taskId: 'bob-task-1', influencerId: aInfluencer }] })).status, 403)
  assert.equal((await B().post('/api/studio-settings', { influencerId: aInfluencer, settings: { x: 1 } })).status, 403)
  assert.equal((await B().post('/api/storage/upload-url', { contentType: 'image/jpeg', byteSize: 10, influencerId: aInfluencer })).status, 403)
  assert.equal((await B().post('/api/storage/ingest', { sourceUrl: 'https://tempfile.aiquickdraw.com/x.png', influencerId: aInfluencer })).status, 403)

  assert.equal(await countOf('assets', 'influencer_id = $1 and user_id = $2', [aInfluencer, bob.id]), 0)
  assert.equal(await countOf('generations', 'user_id = $1', [bob.id]), 0)
  assert.equal((await stack.one('select settings from studio_settings where user_id = $1 and influencer_id = $2', [alice.id, aInfluencer])).settings.scene, 'alice private scene')
})

test('Bob cannot report Alice\'s gallery entry, and a malformed id is a 400 — never a 500', async () => {
  assert.equal((await B().post('/api/reports', { generationId: aGeneration, reason: 'other' })).status, 404)
  assert.equal(await countOf('moderation_events', 'source = $1', ['report']), 0)

  for (const bad of ['not-a-uuid', '', null, 123, {}, [], "' or '1'='1", '00000000-0000-0000-0000-00000000000g']) {
    for (const [path, body] of [
      ['/api/influencers/delete', { influencerId: bad }],
      ['/api/influencers/update', { id: bad, patch: {} }],
      ['/api/generations/delete', { generationId: bad }],
      ['/api/storage/delete', { assetId: bad }],
      ['/api/storage/confirm', { assetId: bad }],
      ['/api/jobs/remove', { id: bad }],
      ['/api/reports', { generationId: bad, reason: 'other' }],
    ]) {
      const res = await B().post(path, body)
      assert.equal(res.status, 400, `${path} with ${JSON.stringify(bad)}`)
    }
  }
})

// ── Strangers' tasks: a task id is a bearer secret, so it must be tied to who made it ──

test('a task made through the proxy belongs to its creator: nobody else can register, sync or look it up', async () => {
  const created = await A().post('/api/kie/api/v1/jobs/createTask', { model: 'kling-3.0/video', input: { prompt: 'a calm walk' } })
  assert.equal(created.status, 200)
  const taskId = created.body.data.taskId

  // What Alice can do with her own task.
  assert.equal((await A().get(`/api/kie/api/v1/jobs/recordInfo?taskId=${taskId}`)).status, 200)
  assert.equal((await A().post('/api/jobs/register', { entries: [{ taskId }] })).status, 201)
  assert.equal((await A().get(`/api/jobs/sync?taskId=${taskId}`)).status, 200)

  // What Bob cannot do with it, even though he knows the id.
  const lookup = await B().get(`/api/kie/api/v1/jobs/recordInfo?taskId=${taskId}`)
  assert.equal(lookup.status, 403)
  assert.equal(lookup.body.code, 'TASK_NOT_YOURS')
  assert.equal((await B().get(`/api/kie/api/v1/veo/record-info?taskId=${taskId}`)).status, 403)
  const claim = await B().post('/api/jobs/register', { entries: [{ taskId }] })
  assert.equal(claim.status, 403)
  assert.equal(claim.body.code, 'TASK_NOT_YOURS')
  assert.equal((await B().get(`/api/jobs/sync?taskId=${taskId}`)).status, 403)
  assert.equal(await countOf('generation_jobs', 'user_id = $1', [bob.id]), 0, 'no job of his points at her task')
})

test('a task that has no recorded creator (one from before this rule) still works for whoever registered it first', async () => {
  const legacy = 'legacy-task-without-owner'
  assert.equal(await countOf('task_owners', 'kie_task_id = $1', [legacy]), 0)
  assert.equal((await A().post('/api/jobs/register', { entries: [{ taskId: legacy }] })).status, 201)
  assert.equal((await A().get(`/api/jobs/sync?taskId=${legacy}`)).status, 200)
})

// ── Credits ──────────────────────────────────────────────────────────────────

test('credits are only ever added by the server: nothing an account sends can move a balance', async () => {
  for (const path of ['/api/billing/grant', '/api/billing/add', '/api/admin/billing/grant']) {
    const res = await B().post(path, { userId: bob.id, credits: 1000, note: 'free money' })
    assert.ok([403, 404].includes(res.status), `${path} -> ${res.status}`)
  }
  assert.equal((await B().get('/api/billing/me')).body.balance, 0)
  const body = await B().post('/api/auth/me', { displayName: 'Bob', balance: 1e9, credits: 1e9 })
  assert.equal(body.status, 200)
  assert.equal((await B().get('/api/billing/me')).body.balance, 0)
})
