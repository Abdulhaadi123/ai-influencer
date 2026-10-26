// Paging the gallery and the queue (api/_lib/paging.js): every row once, in order, however the rows
// were written — and the queue's totals, which a screen showing one page cannot count for itself.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack } from '../helpers/stack.js'

let stack
before(async () => { stack = await startStack({}) })
after(async () => { await stack?.stop() })
beforeEach(() => stack.reset())

/** One moment, to the microsecond, that every row written by one statement shares. */
const SAME_MOMENT = '2026-10-01T10:00:00.123456Z'

async function influencerOf(user) {
  return (await stack.one(`insert into influencers (user_id, name) values ($1, 'Pia') returning id`, [user.id])).id
}

/** `count` gallery entries in ONE statement, so they share a timestamp to the microsecond. */
async function galleryBatch(user, influencerId, count, { kind = () => 'image', at = SAME_MOMENT } = {}) {
  const assets = []
  for (let i = 0; i < count; i++) {
    assets.push((await stack.putAsset({ userId: user.id, bytes: Buffer.from(`file-${i}-${Math.random()}`), moderationStatus: 'clear' })).id)
  }
  const kinds = assets.map((_, i) => kind(i))
  await stack.sql(
    `insert into generations (user_id, influencer_id, asset_id, kind, label, created_at)
     select $1, $2, a.asset, a.kind::asset_kind, 'g', $5::timestamptz from unnest($3::uuid[], $4::text[]) as a(asset, kind)`,
    [user.id, influencerId, assets, kinds, at],
  )
}

/** Every row of a list, a page at a time, following `nextCursor`; fails on a loop. */
async function walk(user, path, key, limit) {
  const rows = []
  let cursor = null
  for (let pages = 0; pages < 100; pages++) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await stack.api('GET', `${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { token: user.token })
    assert.equal(res.status, 200, res.text)
    rows.push(...res.body[key])
    if (!res.body.hasMore) {
      assert.equal(res.body.nextCursor, null, 'the last page says there is nowhere to continue')
      return rows
    }
    assert.equal(res.body.nextCursor, res.body[key].at(-1).cursor, 'nextCursor is the last row\'s cursor')
    cursor = res.body.nextCursor
  }
  assert.fail('paging never ended')
}

const ids = rows => rows.map(r => r.id)

test('gallery: entries that share a timestamp to the microsecond are each reached once, a page at a time', async () => {
  const u = await stack.createUser()
  const inf = await influencerOf(u)
  await galleryBatch(u, inf, 7)

  const everything = await stack.sql(`select id from generations where influencer_id = $1 order by created_at desc, id desc`, [inf])
  for (const size of [1, 2, 3, 7, 30]) {
    const rows = await walk(u, `/api/generations/by-influencer?influencerId=${inf}`, 'generations', size)
    assert.deepEqual(ids(rows), ids(everything), `pages of ${size}: all seven, once each, newest first`)
  }
})

test('gallery: the cursor is the row\'s own moment to the microsecond and its id, and compares in row order', async () => {
  const u = await stack.createUser()
  const inf = await influencerOf(u)
  await galleryBatch(u, inf, 2)
  await galleryBatch(u, inf, 1, { at: '2026-10-01T10:00:00.123457Z' })

  const { body } = await stack.api('GET', `/api/generations/by-influencer?influencerId=${inf}`, { token: u.token })
  const cursors = body.generations.map(g => g.cursor)
  assert.match(cursors[0], /^2026-10-01T10:00:00\.123457Z\|[0-9a-f-]{36}$/)
  assert.equal(cursors[0].split('|')[1], body.generations[0].id)
  assert.deepEqual([...cursors].sort().reverse(), cursors, 'newest first is also descending string order')
})

test('gallery: the older beforeAt / beforeId form is still answered, for app builds that send it', async () => {
  const u = await stack.createUser()
  const inf = await influencerOf(u)
  await galleryBatch(u, inf, 2, { at: '2026-10-01T10:00:00Z' })
  await galleryBatch(u, inf, 1, { at: '2026-10-01T11:00:00Z' })
  const first = (await stack.api('GET', `/api/generations/by-influencer?influencerId=${inf}&limit=1`, { token: u.token })).body
  const last = first.generations[0]
  const next = await stack.api('GET', `/api/generations/by-influencer?influencerId=${inf}&beforeAt=${encodeURIComponent(last.created_at)}&beforeId=${last.id}`, { token: u.token })
  assert.equal(next.status, 200)
  assert.equal(next.body.generations.length, 2)
  assert.ok(!next.body.generations.some(g => g.id === last.id))
})

test('gallery: kind pages through images or videos alone, and its totals match', async () => {
  const u = await stack.createUser()
  const inf = await influencerOf(u)
  // Videos and images interleaved, in three moments.
  await galleryBatch(u, inf, 5, { kind: i => (i % 2 ? 'image' : 'video'), at: '2026-10-01T09:00:00Z' })
  await galleryBatch(u, inf, 4, { kind: () => 'video', at: '2026-10-01T10:00:00Z' })
  await galleryBatch(u, inf, 1, { kind: () => 'image', at: '2026-10-01T08:00:00Z' })

  const images = await walk(u, `/api/generations/by-influencer?influencerId=${inf}&kind=image`, 'generations', 2)
  const videos = await walk(u, `/api/generations/by-influencer?influencerId=${inf}&kind=video`, 'generations', 2)
  assert.deepEqual(images.map(g => g.kind), ['image', 'image', 'image'])
  assert.deepEqual(videos.map(g => g.kind), Array(7).fill('video'))
  const want = kind => stack.sql(`select id from generations where influencer_id = $1 and kind = $2 order by created_at desc, id desc`, [inf, kind])
  assert.deepEqual(ids(images), ids(await want('image')))
  assert.deepEqual(ids(videos), ids(await want('video')))

  for (const bad of ['audio', 'IMAGE', 'x', '']) {
    const res = await stack.api('GET', `/api/generations/by-influencer?influencerId=${inf}&kind=${bad}`, { token: u.token })
    assert.equal(res.status, 400, `kind=${bad}`)
  }
})

test('roster: the newest few carry cursors, and paging on from the oldest of them misses nothing', async () => {
  const u = await stack.createUser()
  const inf = await influencerOf(u)
  await galleryBatch(u, inf, 15)

  const roster = (await stack.api('GET', '/api/influencers', { token: u.token })).body
  const preview = roster.generations.filter(g => g.influencer_id === inf)
  assert.equal(preview.length, 12)
  const rest = await stack.api('GET', `/api/generations/by-influencer?influencerId=${inf}&cursor=${encodeURIComponent(preview.at(-1).cursor)}`, { token: u.token })
  const all = await stack.sql(`select id from generations where influencer_id = $1 order by created_at desc, id desc`, [inf])
  assert.deepEqual([...ids(preview), ...ids(rest.body.generations)], ids(all), 'the twelve, then the other three')
})

let task = 0
/** `count` jobs in ONE statement (as /api/jobs/register writes a batch), sharing a timestamp. */
async function jobBatch(user, count, { state = 'success', at = SAME_MOMENT, assetId = null, resultUrl = null, completedAgo = null } = {}) {
  await stack.sql(
    `insert into generation_jobs (user_id, kie_task_id, kind, label, model, state, asset_id, result_url, created_at, completed_at)
     select $1, 'page-' || ($2::int + g), 'image', 'Image', 'nano-banana-pro', $4, $5, $6, $7::timestamptz,
            case when $8::text is null then null else now() - $8::interval end
       from generate_series(1, $3::int) g`,
    [user.id, task, count, state, assetId, resultUrl, at, completedAgo],
  )
  task += count
}

test('queue: a batch written in one statement is paged without a gap or a repeat, newest first', async () => {
  const u = await stack.createUser()
  const stranger = await stack.createUser()
  await jobBatch(u, 20)
  await jobBatch(u, 3, { at: '2026-10-02T00:00:00Z' })
  await jobBatch(stranger, 5)

  const everything = await stack.sql(`select id from generation_jobs where user_id = $1 order by created_at desc, id desc`, [u.id])
  for (const size of [1, 3, 7, 23, 60]) {
    const rows = await walk(u, '/api/jobs', 'jobs', size)
    assert.deepEqual(ids(rows), ids(everything), `pages of ${size}`)
  }
  assert.ok(!('kie_credits' in (await walk(u, '/api/jobs', 'jobs', 60))[0]), 'still nothing of the studio\'s cost')
})

test('queue: a job started between two pages does not shift the next page — no repeat, no gap', async () => {
  const u = await stack.createUser()
  await jobBatch(u, 6, { at: '2026-10-01T10:00:00Z' })
  const first = (await stack.api('GET', '/api/jobs?limit=3', { token: u.token })).body
  await jobBatch(u, 2, { at: '2026-10-03T00:00:00Z' })   // newer than everything: belongs before page one
  const second = (await stack.api('GET', `/api/jobs?limit=3&cursor=${encodeURIComponent(first.nextCursor)}`, { token: u.token })).body
  const old = await stack.sql(`select id from generation_jobs where user_id = $1 and created_at < '2026-10-02' order by created_at desc, id desc`, [u.id])
  assert.deepEqual([...ids(first.jobs), ...ids(second.jobs)], ids(old))
  assert.equal(second.hasMore, false)
})

test('queue: only running jobs, in pages, with active=1', async () => {
  const u = await stack.createUser()
  await jobBatch(u, 4, { state: 'generating' })
  await jobBatch(u, 3, { state: 'success' })
  const rows = await walk(u, '/api/jobs?active=1', 'jobs', 3)
  assert.equal(rows.length, 4)
  assert.ok(rows.every(j => j.state === 'generating'))
})

test('queue: summary=1 counts the whole account in the app\'s three groups, and only when asked', async () => {
  const u = await stack.createUser()
  const stranger = await stack.createUser()
  const asset = await stack.putAsset({ userId: u.id, bytes: Buffer.from('kept'), moderationStatus: 'clear' })
  await jobBatch(u, 2, { state: 'waiting' })
  await jobBatch(u, 1, { state: 'queuing' })
  await jobBatch(u, 3, { state: 'generating' })
  await jobBatch(u, 2, { state: 'success', resultUrl: 'https://tempfile.aiquickdraw.com/r.png', completedAgo: '1 hour' })      // ready
  await jobBatch(u, 1, { state: 'success', resultUrl: 'https://tempfile.aiquickdraw.com/r.png', completedAgo: '30 hours' })    // expired
  await jobBatch(u, 1, { state: 'success', resultUrl: 'https://tempfile.aiquickdraw.com/r.png', assetId: asset.id, completedAgo: '1 hour' })  // saved
  await jobBatch(u, 1, { state: 'success' })   // saved once, file since deleted
  await jobBatch(u, 2, { state: 'fail' })
  await jobBatch(stranger, 4, { state: 'generating' })

  const res = await stack.api('GET', '/api/jobs?limit=2&summary=1', { token: u.token })
  assert.deepEqual(res.body.summary, { active: 6, ready: 2, settled: 5 })
  assert.equal(res.body.jobs.length, 2, 'the page is still one page')
  assert.ok(!('summary' in (await stack.api('GET', '/api/jobs?limit=2', { token: u.token })).body), 'not asked for, not counted')
})

test('a cursor that is not one is the caller\'s mistake (400), and another account\'s is only a position', async () => {
  const u = await stack.createUser()
  const stranger = await stack.createUser()
  const inf = await influencerOf(u)
  await galleryBatch(u, inf, 2)
  await jobBatch(u, 2)
  await jobBatch(stranger, 2, { at: '2026-10-05T00:00:00Z' })
  const uuid = (await stack.one('select gen_random_uuid() as id')).id

  const bad = [
    'garbage', '', '%00', 'x'.repeat(200),
    `2026-10-01T10:00:00.123Z|${uuid}`,            // milliseconds: the old, inexact form
    `2026-02-31T10:00:00.000000Z|${uuid}`,         // a day that does not exist
    `2026-13-01T10:00:00.000000Z|${uuid}`,
    `2026-10-01T10:00:00.000000Z|not-a-uuid`,
    `2026-10-01T10:00:00.000000Z`,
    `|${uuid}`,
  ]
  for (const c of bad) {
    for (const path of ['/api/jobs?', `/api/generations/by-influencer?influencerId=${inf}&`]) {
      const res = await stack.api('GET', `${path}cursor=${encodeURIComponent(c)}`, { token: u.token })
      assert.equal(res.status, 400, `${path} cursor=${c} → ${res.status}`)
    }
  }
  const twice = await stack.api('GET', `/api/jobs?cursor=a&cursor=b`, { token: u.token })
  assert.equal(twice.status, 400, 'a cursor given twice is not a cursor')

  const theirs = (await stack.api('GET', '/api/jobs?limit=1', { token: stranger.token })).body.jobs[0].cursor
  const res = await stack.api('GET', `/api/jobs?cursor=${encodeURIComponent(theirs)}`, { token: u.token })
  assert.equal(res.status, 200)
  assert.equal(res.body.jobs.length, 2, 'only this account\'s own rows, older than that moment')
  assert.ok(res.body.jobs.every(j => !res.text.includes(stranger.id)))
})
