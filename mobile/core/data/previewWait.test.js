import { test } from 'node:test'
import assert from 'node:assert/strict'

import { waitFor, PREVIEW_WAIT_MS } from './previewWait.js'

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  const slept = []
  return { slept, sleep: async ms => { slept.push(ms) } }
}

test('asks at once and returns the first preview there is', async () => {
  const clock = fakeClock()
  let asks = 0
  const url = await waitFor(async () => { asks++; return 'https://s3/thumb.jpg' }, { sleep: clock.sleep })
  assert.equal(url, 'https://s3/thumb.jpg')
  assert.equal(asks, 1)
  assert.deepEqual(clock.slept, [])
})

test('keeps asking on the schedule until a preview exists', async () => {
  const clock = fakeClock()
  const answers = [null, null, 'https://s3/thumb.jpg']
  const url = await waitFor(async () => answers.shift(), { sleep: clock.sleep })
  assert.equal(url, 'https://s3/thumb.jpg')
  // Waits are the gaps between the moments on the schedule, not the moments themselves.
  assert.deepEqual(clock.slept, [PREVIEW_WAIT_MS[1] - PREVIEW_WAIT_MS[0], PREVIEW_WAIT_MS[2] - PREVIEW_WAIT_MS[1]])
})

test('gives up with null when no preview comes', async () => {
  const clock = fakeClock()
  let asks = 0
  const url = await waitFor(async () => { asks++; return null }, { sleep: clock.sleep })
  assert.equal(url, null)
  assert.equal(asks, PREVIEW_WAIT_MS.length)
})

test('a failed ask counts as "not yet"', async () => {
  const clock = fakeClock()
  let asks = 0
  const url = await waitFor(async () => {
    asks++
    if (asks === 1) throw new Error('offline')
    return 'https://s3/thumb.jpg'
  }, { sleep: clock.sleep })
  assert.equal(url, 'https://s3/thumb.jpg')
  assert.equal(asks, 2)
})

test('stops as soon as the screen has moved on', async () => {
  const clock = fakeClock()
  let cancelled = false
  let asks = 0
  const url = await waitFor(async () => { asks++; cancelled = true; return null }, { sleep: clock.sleep, isCancelled: () => cancelled })
  assert.equal(url, null)
  assert.equal(asks, 1)
})

test('an answer that arrives after cancelling is not used', async () => {
  let cancelled = false
  const url = await waitFor(async () => { cancelled = true; return 'https://s3/thumb.jpg' }, { sleep: async () => {}, isCancelled: () => cancelled })
  assert.equal(url, null)
})
