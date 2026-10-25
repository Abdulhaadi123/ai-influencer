// How much one account may write and how fast: the length of each influencer field, the number of
// influencers, and the ceiling on calls per account. None of these are things a person meets in ordinary use.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startStack } from '../helpers/stack.js'

let stack
before(async () => { stack = await startStack() })
after(async () => { delete process.env.MAX_INFLUENCERS_PER_USER; await stack?.stop() })
beforeEach(async () => { delete process.env.MAX_INFLUENCERS_PER_USER; await stack.reset() })

const create = (token, record) => stack.api('POST', '/api/influencers/create', { token, body: { record } })
const update = (token, id, patch) => stack.api('POST', '/api/influencers/update', { token, body: { id, patch } })

test('a name is tidied to one line, and every text field has its own ceiling', async () => {
  const u = await stack.createUser()
  const res = await create(u.token, {
    name: '  Ana\nMaria   Silva  ',
    gender: 'x'.repeat(100),
    niche: 'n'.repeat(500),
    backstory: 'b'.repeat(10_000),
    physical_desc: 'p'.repeat(10_000),
    prompt: 'q'.repeat(30_000),
    location: 'l'.repeat(1_000),
  })
  assert.equal(res.status, 201)
  const i = res.body.influencer
  assert.equal(i.name, 'Ana Maria Silva', 'line breaks and runs of spaces are gone')
  assert.equal(i.gender.length, 40)
  assert.equal(i.niche.length, 100)
  assert.equal(i.backstory.length, 4_000)
  assert.equal(i.physical_desc.length, 4_000)
  assert.equal(i.prompt.length, 12_000)
  assert.equal(i.location.length, 200)
})

test('an edit is held to the same ceilings, and an empty name stays empty rather than becoming "null"', async () => {
  const u = await stack.createUser()
  const id = (await create(u.token, { name: 'Ana' })).body.influencer.id

  const longName = await update(u.token, id, { name: 'z'.repeat(400) })
  assert.equal(longName.status, 200)
  assert.equal(longName.body.influencer.name.length, 100)

  const blank = await update(u.token, id, { name: '   ' })
  assert.equal(blank.body.influencer.name, '')
  const gone = await update(u.token, id, { name: null })
  assert.equal(gone.body.influencer.name, '')
})

test('wardrobe slots must be objects: a null or a number would stop the roster opening in the app', async () => {
  const u = await stack.createUser()
  for (const slots of [[null], [5], ['x'], [[]], [{ name: 'ok' }, null]]) {
    const res = await create(u.token, { name: 'Ana', wardrobe_slots: slots })
    assert.equal(res.status, 400, JSON.stringify(slots))
    assert.match(res.body.error, /list of objects/)
  }
  const fine = await create(u.token, { name: 'Ana', wardrobe_slots: [{ id: 1, name: 'Casual', asset_id: null }] })
  assert.equal(fine.status, 201)
  assert.equal((await create(u.token, { name: 'Bo', wardrobe_slots: [] })).status, 201)
})

test('an age is optional, and otherwise a whole number from 18 to 99', async () => {
  const u = await stack.createUser()
  for (const [age, stored] of [['25', '25'], [' 18 ', '18'], ['99', '99'], ['', ''], ['   ', ''], [null, null]]) {
    const res = await create(u.token, { name: 'Ana', age })
    assert.equal(res.status, 201, JSON.stringify(age))
    assert.equal(res.body.influencer.age, stored, JSON.stringify(age))
  }
  for (const age of ['17', '5', '0', '100', '269', 'abc', '2.5', '-20', '1'.repeat(50)]) {
    const res = await create(u.token, { name: 'Ana', age })
    assert.equal(res.status, 400, age)
    assert.equal(res.body.code, 'BAD_AGE', age)
  }
  const id = (await create(u.token, { name: 'Bo', age: '30' })).body.influencer.id
  assert.equal((await update(u.token, id, { age: '12' })).status, 400, 'an edit is checked too')
  assert.equal((await update(u.token, id, { backstory: 'x' })).status, 200, 'an edit that does not touch the age is not')
})

test('ordinary values pass through untouched', async () => {
  const u = await stack.createUser()
  const res = await create(u.token, { name: 'Camila', gender: 'Female', age: '27', niche: 'Fitness', backstory: 'Grew up by the sea.' })
  assert.equal(res.status, 201)
  assert.deepEqual(
    [res.body.influencer.name, res.body.influencer.gender, res.body.influencer.age, res.body.influencer.niche, res.body.influencer.backstory],
    ['Camila', 'Female', '27', 'Fitness', 'Grew up by the sea.'],
  )
})

test('an account cannot hold more influencers than the limit; another account is not affected, and deleting makes room', async () => {
  process.env.MAX_INFLUENCERS_PER_USER = '2'
  const a = await stack.createUser()
  const b = await stack.createUser()

  assert.equal((await create(a.token, { name: 'One' })).status, 201)
  const second = await create(a.token, { name: 'Two' })
  assert.equal(second.status, 201)

  const third = await create(a.token, { name: 'Three' })
  assert.equal(third.status, 409)
  assert.equal(third.body.code, 'INFLUENCER_LIMIT')
  assert.match(third.body.error, /limit of 2 influencers/)
  assert.equal((await stack.sql('select count(*)::int as n from influencers where user_id = $1', [a.id]))[0].n, 2, 'nothing was saved')

  assert.equal((await create(b.token, { name: 'Other' })).status, 201, 'the limit is per account')

  const del = await stack.api('POST', '/api/influencers/delete', { token: a.token, body: { influencerId: second.body.influencer.id } })
  assert.ok([200, 204].includes(del.status), `delete ${del.status}`)
  assert.equal((await create(a.token, { name: 'Three' })).status, 201)
})

test('one account may make 150 calls in ten seconds and then waits; nobody else is slowed', async () => {
  const busy = await stack.createUser()
  const calm = await stack.createUser()

  let refused = null
  let allowed = 0
  for (let n = 0; n < 160; n++) {
    const res = await stack.api('GET', '/api/auth/me', { token: busy.token })
    if (res.status === 200) allowed++
    else { refused = res; break }
  }
  assert.equal(allowed, 150)
  assert.equal(refused?.status, 429)
  assert.equal(refused.body.code, 'RATE_LIMITED')
  assert.match(refused.body.error, /Too many requests/)

  assert.equal((await stack.api('GET', '/api/auth/me', { token: calm.token })).status, 200, 'another account is unaffected')
})
