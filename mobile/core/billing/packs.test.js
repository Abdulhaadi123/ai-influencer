// The Credits screen's rules, on their own: which packs are shown, what a generation costs, how numbers read.
// Run with:  node --test core/billing

import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeProductId, joinPacks, formatCredits, costOf, describePrice, costLine, creditsVisible, billedSeconds, priceRow, purchaseNotice } from './packs.js'

const store = [
  { id: 'credits_5000', productId: 'credits_5000', price: '$19.99', native: { n: 5000 } },
  { id: 'credits_500', productId: 'credits_500', price: '$2.99', native: { n: 500 } },
  { id: 'credits_1500', productId: 'credits_1500:base', price: '$7.99', native: { n: 1500 } },
  { id: 'custom', productId: 'consumable', price: '$0.99', native: { n: 0 } },
]
const server = [
  { productId: 'credits_500', credits: 500, label: '500 credits' },
  { productId: 'credits_1500', credits: 1500, label: null },
  { productId: 'credits_5000', credits: 5000, label: '5,000 credits' },
]

test('a product id is the part before any colon, and nothing else is accepted', () => {
  assert.equal(normalizeProductId('credits_500'), 'credits_500')
  assert.equal(normalizeProductId('credits_500:base-plan'), 'credits_500')
  for (const junk of [null, undefined, 5, {}, []]) assert.equal(normalizeProductId(junk), '')
})

test('only products the server will credit are shown, smallest first, each with its worth and its local price', () => {
  const shown = joinPacks(store, server)
  assert.deepEqual(shown.map(p => [p.productId, p.credits, p.price]), [
    ['credits_500', 500, '$2.99'], ['credits_1500', 1500, '$7.99'], ['credits_5000', 5000, '$19.99'],
  ])
  assert.ok(!shown.some(p => p.productId === 'consumable'), 'RevenueCat\'s sample product is not offered')
  assert.deepEqual(shown[1].native, { n: 1500 }, 'the store package is kept for the purchase')
  assert.equal(shown[1].label, '1,500 credits', 'a label the server did not give is made up from the credits')
})

test('a server pack that is worth nothing, or that the store does not sell, is not shown', () => {
  assert.deepEqual(joinPacks(store, [{ productId: 'credits_500', credits: 0 }]), [])
  assert.deepEqual(joinPacks(store, [{ productId: 'credits_500', credits: -5 }]), [])
  assert.deepEqual(joinPacks(store, [{ productId: 'credits_9999', credits: 9999 }]), [])
})

test('missing lists mean no packs, not a crash', () => {
  for (const [a, b] of [[null, null], [undefined, server], [store, undefined], [[], []]]) assert.deepEqual(joinPacks(a, b), [])
})

test('credits read the same everywhere: grouped thousands, no trailing noise, three decimals at most', () => {
  assert.equal(formatCredits(0), '0')
  assert.equal(formatCredits(18), '18')
  assert.equal(formatCredits(1234.5), '1,234.5')
  assert.equal(formatCredits(1000000), '1,000,000')
  assert.equal(formatCredits(-50), '-50')
  assert.equal(formatCredits(-1234.567), '-1,234.567')
  assert.equal(formatCredits(0.1 + 0.2), '0.3')
  assert.equal(formatCredits(12.34567), '12.346')
  for (const junk of [NaN, Infinity, 'abc', undefined, null]) assert.equal(formatCredits(junk), junk === null ? '0' : '0', String(junk))
})

const prices = [
  { model: 'nano-banana-pro', unit: 'per_image', credits: 18 },
  { model: 'kling-3.0/video', unit: 'per_video', credits: 40 },
  { model: 'wan/2-5-image-to-video', unit: 'per_second', credits: 20 },
  { model: 'free-model', unit: 'per_video', credits: 0 },
]

test('a generation costs what the server will charge: per image, per video, or per second of the length asked for', () => {
  assert.equal(costOf(prices, 'nano-banana-pro'), 18)
  assert.equal(costOf(prices, 'kling-3.0/video'), 40)
  assert.equal(costOf(prices, 'wan/2-5-image-to-video', { seconds: 5 }), 100)
  assert.equal(costOf(prices, 'wan/2-5-image-to-video', { seconds: '10' }), 200, 'a numeric string counts, as on the server')
  assert.equal(costOf(prices, 'free-model'), 0)
})

test('a cost that cannot be known is null — never a guess', () => {
  assert.equal(costOf(prices, 'a-model-nobody-priced'), null)
  assert.equal(costOf(prices, 'wan/2-5-image-to-video'), null, 'a per-second price needs seconds')
  for (const seconds of [0, -3, 601, NaN, Infinity, 'abc', '', null, {}]) assert.equal(costOf(prices, 'wan/2-5-image-to-video', { seconds }), null, String(seconds))
  assert.equal(costOf(null, 'nano-banana-pro'), null)
  assert.equal(costOf([{ model: 'x', unit: 'per_video', credits: -1 }], 'x'), null, 'a nonsense price is not shown')
})

test('fractions of a credit are kept to three places', () => {
  assert.equal(costOf([{ model: 'x', unit: 'per_second', credits: 0.333 }], 'x', { seconds: 7 }), 2.331)
})

test('a mode with its own row is priced by it; a mode without one by the row of the model itself', () => {
  const list = [
    { model: 'kling-3.0/motion-control:720p', unit: 'per_second', credits: 20 },
    { model: 'kling-3.0/motion-control:1080p', unit: 'per_second', credits: 27 },
    { model: 'other/model', unit: 'per_second', credits: 5 },
  ]
  assert.equal(costOf(list, 'kling-3.0/motion-control', { seconds: 4, mode: '720p' }), 80)
  assert.equal(costOf(list, 'kling-3.0/motion-control', { seconds: 4, mode: '1080p' }), 108)
  assert.equal(costOf(list, 'kling-3.0/motion-control', { seconds: 4, mode: '4K' }), null, 'no row for that mode or the model')
  assert.equal(costOf(list, 'other/model', { seconds: 4, mode: '1080p' }), 20, 'the model row when the mode has none')
  assert.equal(priceRow(list, 'kling-3.0/motion-control', '720p').credits, 20)
  assert.equal(priceRow(list, 'nothing', '720p'), null)
})

test('a picked clip is billed in whole seconds, rounded up, like the server does', () => {
  assert.equal(billedSeconds(4), 4)
  assert.equal(billedSeconds(4.0003), 4)
  assert.equal(billedSeconds(3.4), 4)
  assert.equal(billedSeconds(0.2), 1)
  for (const bad of [0, -1, NaN, null, undefined, 'abc']) assert.equal(billedSeconds(bad), null, String(bad))
})

test('the price list reads as sentences', () => {
  assert.equal(describePrice(prices[0]), '18 credits per image')
  assert.equal(describePrice(prices[2]), '20 credits per second')
  assert.equal(describePrice({ unit: 'per_video', credits: 1 }), '1 credit per video')
  assert.equal(describePrice({ unit: 'weird', credits: 3 }), '3 credits per generation')
  assert.equal(describePrice(undefined), '0 credits per generation')
})

test('what a person reads before tapping', () => {
  assert.equal(costLine(100), '100 credits')
  assert.equal(costLine(1), '1 credit')
  assert.equal(costLine(0), 'Free')
  assert.equal(costLine(1234.5), '1,234.5 credits')
  assert.equal(costLine(null), null)
  assert.equal(costLine(undefined), null)
})

test('credits are brought up only when they matter: charging is on, the account has or owes some, or it is a development build', () => {
  assert.equal(creditsVisible({ enforced: false, balance: 0 }), false, 'watching only, nothing held: say nothing')
  assert.equal(creditsVisible({ enforced: false, balance: null }), false, 'not loaded yet')
  assert.equal(creditsVisible({ enforced: true, balance: 0 }), true, 'charging is on: people must be able to buy')
  assert.equal(creditsVisible({ enforced: false, balance: 250 }), true, 'they hold some (a reviewer, a test account)')
  assert.equal(creditsVisible({ enforced: false, balance: -18 }), true, 'they owe some')
  assert.equal(creditsVisible({ enforced: false, balance: 0 }, true), true, 'a development build can always reach it')
  assert.equal(creditsVisible({ enforced: false, balance: 0 }, 'yes'), false, 'only the real true')
  assert.equal(creditsVisible(undefined), false)
  assert.equal(creditsVisible({ balance: 'abc' }), false)
})

test('a bought pack says credits were added only once they have, and only offers a refresh where there is one', () => {
  assert.deepEqual(purchaseNotice({ credits: 1500 }, true), { title: 'Credits added', body: '1,500 credits were added to your account.' })
  const late = purchaseNotice({ credits: 1500 }, false)
  assert.equal(late.title, 'Purchase complete')
  assert.ok(!/added to your account/.test(late.body), 'nothing is claimed that has not arrived')
  assert.equal(late.body, 'Your purchase went through. The credits can take a minute to appear.')
  assert.equal(purchaseNotice({ credits: 500 }, false, { canRefresh: true }).body, 'Your purchase went through. The credits can take a minute to appear — pull down to refresh.')
  assert.equal(purchaseNotice(undefined, true).body, '0 credits were added to your account.', 'a missing pack does not throw')
})
