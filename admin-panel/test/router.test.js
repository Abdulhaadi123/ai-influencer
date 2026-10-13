import test from 'node:test'
import assert from './assert.js'

import { parseRoute, buildRoute, withQuery, intParam, oneOf, VIEWS } from '../lib/router.js'

const ID = '0b977eac-f255-4a73-885c-745d9dd4fd07'

test('every view parses; anything else is the overview', () => {
  for (const view of VIEWS) assert.equal(parseRoute(`#/${view}`).view, view)
  for (const hash of ['', '#', '#/', '#/nope', '#/users2', '#//', '#/../admin', '#/%00', undefined, null, 5, '#/USERS', '#/ users']) {
    assert.equal(parseRoute(hash).view, 'overview', String(hash))
  }
})

test('a record id is kept only for views that have records, and only if it is a UUID', () => {
  assert.equal(parseRoute(`#/users/${ID}`).id, ID)
  assert.equal(parseRoute(`#/moderation/${ID}`).id, ID)
  assert.equal(parseRoute(`#/users/${ID.toUpperCase()}`).id, ID, 'lower-cased')
  assert.equal(parseRoute('#/users/not-a-uuid').id, null)
  assert.equal(parseRoute(`#/users/${ID}/extra`).id, ID)
  assert.equal(parseRoute(`#/jobs/${ID}`).id, null, 'jobs has no detail route')
  assert.equal(parseRoute(`#/overview/${ID}`).id, null)
  assert.equal(parseRoute('#/users/%E0%A4%A').id, null, 'a bad escape is not an id and does not throw')
  assert.equal(parseRoute(`#/users/${ID}%00`).id, null)
  assert.equal(parseRoute(`#/users/${ID}'`).id, null)
})

test('the query string is read, for any view', () => {
  const r = parseRoute('#/users?q=mia%20b&status=suspended&sort=jobs&dir=desc&page=2')
  assert.deepEqual(r.query, { q: 'mia b', status: 'suspended', sort: 'jobs', dir: 'desc', page: '2' })
  assert.deepEqual(parseRoute('#/users').query, {})
  assert.deepEqual(parseRoute('#/users?').query, {})
  assert.equal(parseRoute('#/users?q=').query.q, '')
  assert.equal(parseRoute('#/users?q=a&q=b').query.q, 'a', 'the first of a repeated key wins')
  assert.equal(parseRoute(`#/users/${ID}?status=all`).query.status, 'all')
  assert.equal(parseRoute('#/users?q=a?b=c').query.q, 'a?b=c', 'only the first ? separates')
})

test('a query can never smuggle in a prototype key', () => {
  const r = parseRoute('#/users?__proto__=x&constructor=y&prototype=z&ok=1')
  assert.deepEqual(r.query, { ok: '1' })
  assert.equal(Object.getPrototypeOf(r.query), Object.prototype)
  assert.equal({}.polluted, undefined)
})

test('buildRoute: views, ids and queries; empty values are left out', () => {
  assert.equal(buildRoute('users'), '#/users')
  assert.equal(buildRoute('users', { id: ID }), `#/users/${ID}`)
  assert.equal(buildRoute('jobs', { id: ID }), '#/jobs', 'no id for a view without records')
  assert.equal(buildRoute('users', { query: { q: 'mia', page: 2 } }), '#/users?q=mia&page=2')
  assert.equal(buildRoute('users', { query: { q: '', page: null, sort: undefined, dir: 'asc' } }), '#/users?dir=asc')
  assert.equal(buildRoute('users', { query: { q: 'a b&c=d' } }), '#/users?q=a+b%26c%3Dd')
  assert.equal(buildRoute('nope'), '#/overview')
  assert.equal(buildRoute(undefined), '#/overview')
})

test('build then parse returns what was built', () => {
  const route = { view: 'moderation', id: ID, query: { status: 'all', userId: ID, q: 'ü & % #' } }
  const back = parseRoute(buildRoute(route.view, route))
  assert.deepEqual(back, route)
})

test('withQuery changes some values and keeps the rest; null removes one', () => {
  const route = parseRoute('#/users?q=mia&status=active&page=3')
  assert.equal(withQuery(route, { page: 4 }), '#/users?q=mia&status=active&page=4')
  assert.equal(withQuery(route, { page: null }), '#/users?q=mia&status=active')
  assert.equal(withQuery(route, { q: '', status: null }), '#/users?page=3')
  assert.equal(withQuery({ ...route, id: ID }, { page: 1 }), `#/users/${ID}?q=mia&status=active&page=1`)
  assert.equal(route.query.page, '3', 'the original route is not changed')
})

test('intParam and oneOf turn what an address says into something safe', () => {
  assert.equal(intParam('3', 1), 3)
  for (const bad of ['0', '-2', '1.5', 'abc', '', undefined, null, 'Infinity', '1e3x']) assert.equal(intParam(bad, 7), 7, String(bad))
  assert.equal(intParam('1e3', 7), 1000, 'a valid number in another notation is still a number')

  assert.equal(oneOf('b', ['a', 'b'], 'a'), 'b')
  for (const bad of ['c', '', undefined, null, 0, '__proto__', 'B']) assert.equal(oneOf(bad, ['a', 'b'], 'a'), 'a', String(bad))
  assert.equal(oneOf(50, [25, 50, 100], 25), 50)
  assert.equal(oneOf(Number('x'), [25, 50, 100], 25), 25)
})
