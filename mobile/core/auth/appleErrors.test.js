import test from 'node:test'
import assert from 'node:assert/strict'

import { explainAppleError, APPLE_CANCELLED, APPLE_FAILED } from './appleErrors.js'

test('closing Apple\'s sheet is not an error: nothing is shown', () => {
  for (const error of [{ code: 'ERR_REQUEST_CANCELED' }, { code: '1001' }, { message: 'The user canceled the authorization attempt' }]) {
    const r = explainAppleError(error)
    assert.equal(r.cancelled, true)
    assert.equal(r.code, APPLE_CANCELLED)
    assert.equal(r.message, '')
  }
})

test('every other failure is a plain sentence, never Apple\'s own words', () => {
  const cases = {
    ERR_REQUEST_FAILED: /Could not reach Apple/,
    ERR_REQUEST_NOT_HANDLED: /could not open/,
    ERR_REQUEST_NOT_INTERACTIVE: /could not open/,
    ERR_REQUEST_UNKNOWN: /signed in to an Apple Account/,
    ERR_APPLE_AUTHENTICATION_UNAVAILABLE: /not available on this iPhone/,
  }
  for (const [code, expected] of Object.entries(cases)) {
    const r = explainAppleError({ code, message: 'The authorization attempt failed for an unknown reason' })
    assert.equal(r.cancelled, false, code)
    assert.equal(r.code, APPLE_FAILED, code)
    assert.match(r.message, expected, code)
    assert.doesNotMatch(r.message, /authorization attempt/i, `${code}: the message is not the library's own`)
  }
})

test('a dropped network is reported as one, whatever the code', () => {
  const r = explainAppleError(new Error('Network request failed'))
  assert.equal(r.cancelled, false)
  assert.match(r.message, /Could not reach Apple/)
})

test('anything else gets the general sentence, and the cause goes to the log', () => {
  for (const error of [undefined, null, 'boom', new Error('something odd'), { code: 'WHO_KNOWS' }]) {
    const r = explainAppleError(error)
    assert.equal(r.cancelled, false)
    assert.equal(r.code, APPLE_FAILED)
    assert.match(r.message, /Could not sign in with Apple/)
    assert.ok(r.reason.length > 0)
  }
  assert.ok(explainAppleError({ code: 'X', message: 'y'.repeat(1000) }).reason.length < 200, 'the log line stays short')
})
