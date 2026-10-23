import test from 'node:test'
import assert from 'node:assert/strict'

import { failureMessage, isTransientFailure, TRANSIENT_FAILURE_MESSAGE } from './transient.js'

test('KIE\'s own "internal error" wording is a failure on its side; a refusal about the request is not', () => {
  assert.equal(isTransientFailure('internal error, please try again later.'), true)
  assert.equal(isTransientFailure('Service is temporarily unavailable'), true)
  assert.equal(isTransientFailure('The request timed out'), true)
  assert.equal(isTransientFailure('Image fetch failed. Check access settings or use our File Upload API instead.'), false)
  assert.equal(isTransientFailure('Your prompt was flagged by the content filter.'), false)
  assert.equal(isTransientFailure(null), false)
  assert.equal(isTransientFailure(''), false)
})

test('every place that shows a failed job says the same thing: ours for the generator\'s failure, its reason otherwise', () => {
  assert.equal(failureMessage('internal error, please try again later.', 'fallback'), TRANSIENT_FAILURE_MESSAGE)
  assert.equal(failureMessage('Your prompt was flagged.', 'fallback'), 'Your prompt was flagged.')
  assert.equal(failureMessage(null, 'This generation failed.'), 'This generation failed.')
  assert.equal(failureMessage('   ', 'This generation failed.'), 'This generation failed.')
})

test('the message says it was on our side, that nothing was charged, and to try again — without the vendor\'s words', () => {
  assert.match(TRANSIENT_FAILURE_MESSAGE, /on our end/)
  assert.match(TRANSIENT_FAILURE_MESSAGE, /not been charged/)
  assert.match(TRANSIENT_FAILURE_MESSAGE, /try again/)
  assert.doesNotMatch(TRANSIENT_FAILURE_MESSAGE, /internal error|KIE/i)
})
