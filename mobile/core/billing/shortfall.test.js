// The out-of-credits wording: what is missing, said the same way by the dialog and the cost note.
// Run with:  node --test core/billing

import test from 'node:test'
import assert from 'node:assert/strict'

import { creditShortfall, outOfCreditsDialog, creditsWord } from './shortfall.js'

test('credits are counted in the singular and the plural, with thousands separated', () => {
  assert.equal(creditsWord(1), '1 credit')
  assert.equal(creditsWord(0), '0 credits')
  assert.equal(creditsWord(46), '46 credits')
  assert.equal(creditsWord(1616), '1,616 credits')
})

test('the shortfall is the price less the balance — and nothing when the balance covers it', () => {
  assert.deepEqual(creditShortfall({ balance: 40, price: 780 }), { need: 780, have: 40, short: 740 })
  assert.deepEqual(creditShortfall({ balance: 40, price: 46 }), { need: 46, have: 40, short: 6 })
  assert.deepEqual(creditShortfall({ balance: 46, price: 46 }), { need: 46, have: 46, short: 0 })
  assert.deepEqual(creditShortfall({ balance: 5000, price: 46 }), { need: 46, have: 5000, short: 0 })
})

test('an account that owes credits has none: the negative is not shown as a balance', () => {
  assert.deepEqual(creditShortfall({ balance: -20, price: 46 }), { need: 46, have: 0, short: 46 })
})

test('with a number missing there is no shortfall to state', () => {
  for (const bad of [{ balance: null, price: 46 }, { balance: 40, price: null }, { balance: NaN, price: 46 }, { balance: 40, price: Infinity }, { balance: 40, price: 0 }, { balance: 40, price: -5 }, {}, { balance: '40', price: '46' }]) {
    assert.equal(creditShortfall(bad), null, JSON.stringify(bad))
  }
})

test('the dialog says what the generation needs, what there is, and the gap — the numbers from the 46-credit screenshot', () => {
  const d = outOfCreditsDialog({ balance: 40, price: 46 })
  assert.equal(d.title, 'Not enough credits')
  assert.equal(d.message, 'Get a credit pack to continue. Credits never expire.')
  assert.deepEqual(d.facts, [
    { label: 'This needs', value: '46 credits' },
    { label: 'You have', value: '40 credits' },
    { label: 'You are short by', value: '6 credits', emphasis: true },
  ])
})

test('one credit short is "1 credit", not "1 credits"', () => {
  assert.equal(outOfCreditsDialog({ balance: 45, price: 46 }).facts[2].value, '1 credit')
})

test('when the numbers are not known the dialog still says it, without a table', () => {
  const d = outOfCreditsDialog({ balance: null, price: null })
  assert.equal(d.title, 'Not enough credits')
  assert.match(d.message, /do not have enough credits/)
  assert.deepEqual(d.facts, [])
})
