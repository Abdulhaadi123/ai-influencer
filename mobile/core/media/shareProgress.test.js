import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatBytes, progressPercent, progressLabel, PILL_DELAY_MS } from './shareProgress.js'

test('sizes read as people say them', () => {
  assert.equal(formatBytes(0), '1 KB', 'never "0 KB" for something being downloaded')
  assert.equal(formatBytes(1500), '1 KB')
  assert.equal(formatBytes(512 * 1024), '512 KB')
  assert.equal(formatBytes(3.1 * 1024 * 1024), '3.1 MB')
  assert.equal(formatBytes(9_700_000), '9.3 MB')
  assert.equal(formatBytes(NaN), '')
  assert.equal(formatBytes(-5), '')
})

test('the percentage is a whole number, and never 100 while it is still downloading', () => {
  assert.equal(progressPercent({ bytesWritten: 0, totalBytes: 1000 }), 0)
  assert.equal(progressPercent({ bytesWritten: 420, totalBytes: 1000 }), 42)
  assert.equal(progressPercent({ bytesWritten: 999, totalBytes: 1000 }), 99)
  assert.equal(progressPercent({ bytesWritten: 1000, totalBytes: 1000 }), 99)
  assert.equal(progressPercent({ bytesWritten: 1200, totalBytes: 1000 }), 99, 'a size that was announced low')
})

test('no percentage when the size is not known or nonsense', () => {
  assert.equal(progressPercent({ bytesWritten: 500, totalBytes: -1 }), null, 'no Content-Length: the library says -1')
  assert.equal(progressPercent({ bytesWritten: 500, totalBytes: 0 }), null)
  assert.equal(progressPercent({ bytesWritten: -1, totalBytes: 100 }), null)
  assert.equal(progressPercent({ bytesWritten: NaN, totalBytes: 100 }), null)
  assert.equal(progressPercent(null), null)
  assert.equal(progressPercent(undefined), null)
  assert.equal(progressPercent({}), null)
})

test('the words: nothing yet, a percentage, or just the bytes so far', () => {
  assert.equal(progressLabel(null), 'Preparing to share…')
  assert.equal(progressLabel({ bytesWritten: 0, totalBytes: -1 }), 'Preparing to share…')
  assert.equal(progressLabel({ bytesWritten: 420, totalBytes: 1000 }), 'Preparing to share… 42%')
  assert.equal(progressLabel({ bytesWritten: 3.1 * 1024 * 1024, totalBytes: -1 }), 'Preparing to share… 3.1 MB')
})

test('an instant share does not flash a pill', () => {
  assert.ok(PILL_DELAY_MS >= 250 && PILL_DELAY_MS <= 600)
})
