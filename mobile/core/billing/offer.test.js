// The pack offer's rules: when it is shown, and what a pack is said to give.
// Run with:  node --test core/billing

import test from 'node:test'
import assert from 'node:assert/strict'

import { OFFER_SEEN_KEY, shouldOfferPacks, packBenefits } from './offer.js'

const ready = { loaded: true, visible: true, available: true, balance: 0, seen: false }

test('the offer is shown to someone with no credits, once credits matter, who has not seen it', () => {
  assert.equal(shouldOfferPacks(ready), true)
})

test('it is not shown before the balance is known, while credits do not matter, with credits, or twice', () => {
  assert.equal(shouldOfferPacks({ ...ready, loaded: false }), false, 'the balance has not arrived: 0 may just be "not yet"')
  assert.equal(shouldOfferPacks({ ...ready, balance: null }), false)
  assert.equal(shouldOfferPacks({ ...ready, visible: false }), false, 'charging is off: nobody needs credits')
  assert.equal(shouldOfferPacks({ ...ready, available: false }), false, 'this build cannot sell anything: the offer could only say so')
  assert.equal(shouldOfferPacks({ ...ready, balance: 500 }), false)
  assert.equal(shouldOfferPacks({ ...ready, balance: -20 }), false, 'someone who owes is sent to the Credits screen by the alert, not offered a welcome')
  assert.equal(shouldOfferPacks({ ...ready, seen: true }), false)
})

test('only exactly true counts: a missing or odd value never opens the offer', () => {
  assert.equal(shouldOfferPacks({}), false)
  assert.equal(shouldOfferPacks({ loaded: 1, visible: 'yes', available: 1, balance: '0', seen: 0 }), false)
  assert.equal(shouldOfferPacks({ ...ready, available: 'yes' }), false)
  assert.equal(shouldOfferPacks({ loaded: true, visible: true, balance: 0, seen: false }), false, 'no word on availability is not "available"')
  assert.equal(shouldOfferPacks(undefined ?? {}), false)
})

test('the stored flag has one stable name', () => {
  assert.equal(OFFER_SEEN_KEY, 'pack_offer_seen')
})

const prices = [
  { model: 'nano-banana-pro', unit: 'per_image', credits: 18 },
  { model: 'veo-3-1', unit: 'per_video', credits: 150 },
  { model: 'wan', unit: 'per_second', credits: 20 },
]

test('a pack says what it is for, how many images it is, and the terms', () => {
  assert.deepEqual(packBenefits({ credits: 1500 }, prices).map(b => b.text), [
    'For images, videos and motion copy', 'About 83 images', 'Credits never expire', 'Credits come back if a generation fails', 'One payment, no subscription',
  ])
})

test('the image count uses the cheapest image price, rounds down, and is left out when it would say less than one', () => {
  const cheap = [{ unit: 'per_image', credits: 40 }, { unit: 'per_image', credits: 10 }]
  assert.equal(packBenefits({ credits: 100 }, cheap)[1].text, 'About 10 images')
  assert.equal(packBenefits({ credits: 10 }, cheap)[1].text, 'About 1 image', 'singular')
  assert.ok(!packBenefits({ credits: 5 }, cheap).some(b => b.id === 'images'), 'not even one image: nothing is claimed')
})

test('with no image price known, no image count is invented', () => {
  for (const none of [undefined, null, [], [{ unit: 'per_video', credits: 150 }], [{ unit: 'per_image', credits: 0 }], [{ unit: 'per_image', credits: -5 }]]) {
    assert.ok(!packBenefits({ credits: 500 }, none).some(b => b.id === 'images'), JSON.stringify(none))
  }
  assert.deepEqual(packBenefits({ credits: 500 }, []).map(b => b.id), ['spend', 'never-expire', 'refund', 'one-payment'])
})

test('a pack worth nothing, or no pack, gives a list of nothing', () => {
  for (const bad of [null, undefined, {}, { credits: 0 }, { credits: -1 }, { credits: 'abc' }]) assert.deepEqual(packBenefits(bad, prices), [], JSON.stringify(bad))
})
