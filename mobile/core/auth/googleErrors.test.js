import { test } from 'node:test'
import assert from 'node:assert/strict'

import { explainGoogleError, GOOGLE_CANCELLED, GOOGLE_FAILED } from './googleErrors.js'

const codes = { SIGN_IN_CANCELLED: '12501', IN_PROGRESS: '12502', PLAY_SERVICES_NOT_AVAILABLE: '2' }
const fail = (code, message = '') => Object.assign(new Error(message), { code })

test('closing the account picker is not an error: nothing is shown', () => {
  const r = explainGoogleError(fail('12501', 'cancelled'), codes)
  assert.equal(r.cancelled, true)
  assert.equal(r.code, GOOGLE_CANCELLED)
  assert.equal(r.message, '')
})

test('a second tap while one is open is quietly ignored too', () => {
  assert.equal(explainGoogleError(fail('12502'), codes).cancelled, true)
})

test('the library\'s own names are honoured even where the numbers differ (iOS, a later version)', () => {
  const other = { SIGN_IN_CANCELLED: '-5', IN_PROGRESS: 'in-progress', PLAY_SERVICES_NOT_AVAILABLE: 'no-play' }
  assert.equal(explainGoogleError(fail('-5'), other).cancelled, true)
  assert.equal(explainGoogleError(fail('in-progress'), other).cancelled, true)
  assert.match(explainGoogleError(fail('no-play'), other).message, /Google Play services/)
})

test('no Google Play services: says so and points to email', () => {
  const r = explainGoogleError(fail('2', 'Google Play Services is not available'), codes)
  assert.equal(r.cancelled, false)
  assert.equal(r.code, GOOGLE_FAILED)
  assert.match(r.message, /Google Play services/)
  assert.match(r.message, /email/)
})

test('DEVELOPER_ERROR: a plain message for the person, the real cause for the log', () => {
  const r = explainGoogleError(fail('10', 'DEVELOPER_ERROR: Follow troubleshooting instructions'), codes)
  assert.equal(r.code, GOOGLE_FAILED)
  assert.doesNotMatch(r.message, /DEVELOPER_ERROR|SHA|certificate|client id/i, 'nothing a user cannot act on')
  assert.match(r.reason, /DEVELOPER_ERROR/)
  assert.match(r.reason, /signing key/)
})

test('a dropped network is a connection message', () => {
  assert.match(explainGoogleError(fail('7', 'A network error has occurred'), codes).message, /connection/)
  assert.match(explainGoogleError(new Error('Network request failed')).message, /connection/)
})

test('anything else: a general message, and the unexpected thing is kept for the log', () => {
  const r = explainGoogleError(fail('8', 'INTERNAL_ERROR something'), codes)
  assert.equal(r.cancelled, false)
  assert.match(r.message, /try again/i)
  assert.match(r.reason, /8/)
  assert.match(r.reason, /INTERNAL_ERROR/)
})

test('copes with what is not an error at all', () => {
  for (const odd of [undefined, null, 'boom', 42, {}]) {
    const r = explainGoogleError(odd, codes)
    assert.equal(r.cancelled, false)
    assert.ok(r.message)
  }
})
