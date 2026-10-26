// The costing document's formula (api/_lib/markup.js): the numbers in the document itself, the arithmetic
// traps in it, and the promise that no price ever earns less than its target.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  KIE_USD_PER_CREDIT, PACKS, WORST_USD_PER_CREDIT, DEFAULT_COMMISSION, DEFAULT_MARGIN, KIE_COST,
  breakEvenMultiplier, priceMultiplier, userCredits, marginOf,
} from '../../api/_lib/markup.js'

const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not ${b}`)

// ── The document's own numbers ───────────────────────────────────────────────

test('the packs are the three on sale, and the worst of them earns $0.0035 a credit', () => {
  assert.deepEqual(PACKS.map(p => [p.credits, p.usd]), [[5000, 20], [10000, 35], [20000, 70]])
  assert.deepEqual(PACKS.map(p => p.usd / p.credits), [0.004, 0.0035, 0.0035])
  assert.equal(WORST_USD_PER_CREDIT, 0.0035)
  assert.equal(KIE_USD_PER_CREDIT, 0.005)
  assert.equal(DEFAULT_COMMISSION, 0.2)
  assert.equal(DEFAULT_MARGIN, 0.3)
})

test('break even: ×1.43 with no commission, ×1.79 after the 20% commission — multipliers, not percentages', () => {
  close(breakEvenMultiplier({ commission: 0 }), 0.005 / 0.0035)        // 1.4286
  close(breakEvenMultiplier({ commission: 0.2 }), 0.005 / 0.0028)      // 1.7857
  assert.equal(breakEvenMultiplier().toFixed(2), '1.79')
  // The commission leaves $0.0028 of each $0.0035 credit.
  close(WORST_USD_PER_CREDIT * 0.8, 0.0028)
})

test('Seedance Mini, 5 s at 480p: KIE charges 19 credits; the document\'s table is reproduced to the credit', () => {
  const credits = margin => userCredits(19, { margin, commission: 0.2 })
  assert.equal(credits(0), 34, 'break even after commission')
  assert.equal(credits(0.1), 38)
  assert.equal(credits(0.2), 43)
  assert.equal(credits(0.3), 49)
  assert.equal(credits(0.4), 57)
  assert.equal(credits(0.5), 68)
})

test('without a commission the same video needs 27.14 credits (the document rounds this to 27.4) — 28 whole credits', () => {
  close(19 * breakEvenMultiplier({ commission: 0 }), 27.142857142857142, 1e-9)
  assert.equal(userCredits(19, { margin: 0, commission: 0 }), 28)
})

test('the multiplier for each margin, as in the owner\'s table', () => {
  const m = margin => priceMultiplier({ margin })
  assert.equal(m(0).toFixed(3), '1.786')
  assert.equal(m(0.1).toFixed(3), '1.984')
  assert.equal(m(0.2).toFixed(3), '2.232')
  assert.equal(m(0.3).toFixed(3), '2.551')
  assert.equal(m(0.4).toFixed(3), '2.976')
  assert.equal(m(0.5).toFixed(3), '3.571')
})

// ── Arithmetic traps ─────────────────────────────────────────────────────────

test('a price that is exact is not pushed up a credit by floating point', () => {
  // 14 KIE credits × 0.005 = $0.07; ÷ $0.0028 = exactly 25 credits.
  assert.equal(userCredits(14, { margin: 0 }), 25)
  assert.equal(userCredits(28, { margin: 0 }), 50)
  // …and at 50% exactly double.
  assert.equal(userCredits(14, { margin: 0.5 }), 50)
  assert.equal(userCredits(7, { margin: 0 }), 13, '12.5 rounds up')
  assert.equal(userCredits(14, { margin: 0.3 }), 36, '35.71 rounds up')
})

test('rounding is always up: a price may beat its target by a fraction of a credit, never miss it', () => {
  for (const [kie, margin] of [[18, 0.3], [20, 0.3], [27, 0.3], [19, 0.2], [3.8, 0.4], [2.4, 0.5], [0.5, 0.3]]) {
    const exact = kie * priceMultiplier({ margin })
    const charged = userCredits(kie, { margin })
    assert.ok(charged >= exact - 1e-9, `${kie} at ${margin}: ${charged} < ${exact}`)
    assert.ok(charged - exact < 1, `${kie} at ${margin}: ${charged} overshoots ${exact} by a credit or more`)
  }
})

test('free stays free, and anything that costs something is at least one credit', () => {
  assert.equal(userCredits(0), 0)
  assert.equal(userCredits(0.001), 1)
  assert.equal(userCredits(0.1, { margin: 0 }), 1)
})

test('KIE\'s fractional prices (4.8 credits a second) work', () => {
  assert.equal(userCredits(4.8, { margin: 0.3 }), 13)   // 4.8 × 2.551 = 12.24
  assert.equal(userCredits(7.2, { margin: 0.3 }), 19)   // 18.37
})

// ── The promise, over thousands of prices ────────────────────────────────────

test('over every price from 0.1 to 400 KIE credits, at six margins and four commissions, no price earns less than its target', () => {
  const margins = [0, 0.1, 0.2, 0.3, 0.4, 0.5]
  const commissions = [0, 0.15, 0.2, 0.3]
  let checked = 0
  for (const commission of commissions) {
    for (const margin of margins) {
      let previous = 0
      const multiplier = priceMultiplier({ margin, commission })
      for (let tenths = 1; tenths <= 4000; tenths++) {
        const kie = tenths / 10
        const charged = userCredits(kie, { margin, commission })
        assert.ok(Number.isInteger(charged) && charged >= 1, `${kie}: ${charged} is not a whole credit`)
        assert.ok(marginOf(kie, charged, { commission }) >= margin - 1e-9, `${kie} KIE credits at ${margin}/${commission}: earns ${marginOf(kie, charged, { commission })}`)
        assert.ok(charged - kie * multiplier < 1 + 1e-9, `${kie} KIE credits overshoots by a credit`)
        assert.ok(charged >= previous, `${kie}: a dearer KIE price got a cheaper credit price`)
        previous = charged
        checked++
      }
    }
  }
  assert.equal(checked, 96000)
})

// ── The models we sell ───────────────────────────────────────────────────────

test('the five price rows at the defaults', () => {
  const price = model => userCredits(KIE_COST.find(c => c.model === model).kieCredits)
  assert.equal(price('nano-banana-pro'), 46)
  assert.equal(price('kling-3.0/video'), 52)
  assert.equal(price('kling-3.0/motion-control:720p'), 52)
  assert.equal(price('kling-3.0/motion-control:1080p'), 69)
  assert.equal(price('kling-3.0/motion-control'), 69)
  for (const c of KIE_COST) {
    const margin = marginOf(c.kieCredits, userCredits(c.kieCredits))
    assert.ok(margin >= DEFAULT_MARGIN && margin < DEFAULT_MARGIN + 0.02, `${c.model}: ${margin}`)
  }
})

test('charged 1:1 — today\'s prices — every model loses money: about 79 cents on every dollar earned', () => {
  for (const c of KIE_COST) {
    const margin = marginOf(c.kieCredits, c.kieCredits)
    close(margin, 1 - 0.005 / 0.0028, 1e-9)   // -78.6%
    assert.ok(margin < -0.78)
  }
})

test('the cost table is well formed: each model once, a known unit, a positive KIE price', () => {
  const models = KIE_COST.map(c => c.model)
  assert.equal(new Set(models).size, models.length)
  for (const c of KIE_COST) {
    assert.ok(['per_image', 'per_video', 'per_second'].includes(c.unit), c.model)
    assert.ok(c.kieCredits > 0 && Number.isFinite(c.kieCredits), c.model)
  }
  assert.ok(Object.isFrozen(KIE_COST))
})

// ── Refusals ─────────────────────────────────────────────────────────────────

test('a price that is not a number of credits is refused, not turned into NaN', () => {
  for (const bad of [NaN, -1, Infinity, -Infinity, '18', null, undefined, {}, [], true]) {
    assert.throws(() => userCredits(bad), RangeError, String(bad))
  }
})

test('a margin or commission that makes no sense is refused', () => {
  for (const margin of [-0.1, 0.91, 1, 30, NaN, '0.3', null]) assert.throws(() => priceMultiplier({ margin }), RangeError, `margin ${margin}`)
  for (const commission of [-0.1, 0.61, 1, 20, NaN, '0.2', null]) assert.throws(() => breakEvenMultiplier({ commission }), RangeError, `commission ${commission}`)
  // The ends that are allowed.
  assert.doesNotThrow(() => priceMultiplier({ margin: 0.9, commission: 0.6 }))
  assert.doesNotThrow(() => priceMultiplier({ margin: 0, commission: 0 }))
})

test('marginOf says a free price for a costly thing is a total loss, and free for free is nothing', () => {
  assert.equal(marginOf(18, 0), -Infinity)
  assert.equal(marginOf(0, 0), 0)
})
