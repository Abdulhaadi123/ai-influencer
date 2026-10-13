import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CATEGORIES, DEFAULT_RULES, HARD_RULE, HARD_RULE_CEILING,
  evaluate, mergeResults, parseThresholdOverrides, scoresOf,
} from '../../api/_lib/moderation/policy.js'

/** A classifier result with every score zero except those given. */
const result = (scores = {}, flagged = []) => ({
  flagged: flagged.length > 0,
  categories: Object.fromEntries(CATEGORIES.map(c => [c, flagged.includes(c)])),
  scores: Object.fromEntries(CATEGORIES.map(c => [c, scores[c] ?? 0])),
})

test('nothing scored is allowed', () => {
  const d = evaluate(result())
  assert.equal(d.action, 'allow')
  assert.deepEqual(d.hits, [])
  assert.equal(d.hardRule, false)
})

test('sexual: blocked when clear, reviewed in the borderline band, allowed below it', () => {
  assert.equal(evaluate(result({ sexual: 0.95 })).action, 'block')
  assert.equal(evaluate(result({ sexual: 0.85 })).action, 'block', 'the threshold itself blocks')
  assert.equal(evaluate(result({ sexual: 0.6 })).action, 'review')
  assert.equal(evaluate(result({ sexual: 0.5 })).action, 'review')
  assert.equal(evaluate(result({ sexual: 0.49 })).action, 'allow')
})

test('a category the classifier flags is at least reviewed, even under our review line', () => {
  const d = evaluate(result({ sexual: 0.3 }, ['sexual']))
  assert.equal(d.action, 'review')
  assert.deepEqual(d.hits.map(h => h.category), ['sexual'])
})

test('sexual/minors: any real signal blocks, and it is the hard rule', () => {
  const low = evaluate(result({ [HARD_RULE]: 0.11 }))
  assert.equal(low.action, 'block')
  assert.equal(low.hardRule, true)

  // Flagged by the classifier with a tiny score: still blocked.
  const flagged = evaluate(result({ [HARD_RULE]: 0.01 }, [HARD_RULE]))
  assert.equal(flagged.action, 'block')
  assert.equal(flagged.hardRule, true)

  assert.equal(evaluate(result({ [HARD_RULE]: 0.05 })).action, 'allow')
})

test('violence is reviewed, graphic violence is blocked', () => {
  assert.equal(evaluate(result({ violence: 0.95 })).action, 'review')
  assert.equal(evaluate(result({ 'violence/graphic': 0.9 })).action, 'block')
})

test('block outranks review, and every tripped category is listed', () => {
  const d = evaluate(result({ violence: 0.9, sexual: 0.9, 'self-harm': 0.7 }))
  assert.equal(d.action, 'block')
  assert.deepEqual(d.hits.map(h => `${h.category}:${h.level}`).sort(), ['self-harm:review', 'sexual:block', 'violence:review'])
  assert.equal(d.hardRule, false, 'the hard-rule flag is only for the minors category')
})

test('a rule set to false is ignored — except the hard rule, which cannot be', () => {
  const rules = { ...DEFAULT_RULES, sexual: false }
  assert.equal(evaluate(result({ sexual: 1 }, ['sexual']), rules).action, 'allow')
  assert.equal(evaluate(result({ [HARD_RULE]: 0.9 }), { ...rules, [HARD_RULE]: false }).action, 'block')
})

test('a missing rule falls back to the default instead of crashing', () => {
  assert.equal(evaluate(result({ sexual: 0.95 }), {}).action, 'block')
})

test('scoresOf keeps only the categories that tripped, nothing else', () => {
  const d = evaluate(result({ sexual: 0.9, violence: 0.1 }))
  assert.deepEqual(scoresOf(d), { sexual: 0.9 })
})

test('mergeResults keeps the worst score and any flag across results (a video is its worst frame)', () => {
  const merged = mergeResults([
    { flagged: false, categories: { sexual: false }, category_scores: { sexual: 0.2, violence: 0.7 } },
    { flagged: true, categories: { sexual: true }, category_scores: { sexual: 0.9 } },
    null,
    'junk',
    { category_scores: { violence: 'not a number', sexual: NaN } },
  ])
  assert.equal(merged.flagged, true)
  assert.equal(merged.categories.sexual, true)
  assert.equal(merged.scores.sexual, 0.9)
  assert.equal(merged.scores.violence, 0.7)
  assert.equal(merged.scores['hate'], 0)
  assert.deepEqual(Object.keys(merged.scores), [...CATEGORIES])
})

test('mergeResults of nothing is a clean result', () => {
  for (const input of [[], undefined, null]) {
    const merged = mergeResults(input)
    assert.equal(merged.flagged, false)
    assert.equal(evaluate(merged).action, 'allow')
  }
})

test('OpenAI category names are exactly the ones the policy knows', () => {
  // From the moderation guide's example response. If the API renames one, this
  // list and the policy must change together.
  const documented = [
    'sexual', 'sexual/minors', 'harassment', 'harassment/threatening', 'hate', 'hate/threatening',
    'illicit', 'illicit/violent', 'self-harm', 'self-harm/intent', 'self-harm/instructions', 'violence', 'violence/graphic',
  ]
  assert.deepEqual([...CATEGORIES], documented)
  for (const c of CATEGORIES) assert.ok(c in DEFAULT_RULES, `${c} has a rule`)
})

// ── MODERATION_THRESHOLDS ────────────────────────────────────────────────────

test('no override means the defaults', () => {
  for (const raw of [undefined, null, '', '   ']) assert.deepEqual(parseThresholdOverrides(raw), DEFAULT_RULES)
})

test('an override changes one level and keeps the other', () => {
  const rules = parseThresholdOverrides('{"sexual": {"block": 0.95}}')
  assert.deepEqual(rules.sexual, { block: 0.95, review: 0.5 })
  assert.deepEqual(rules.violence, DEFAULT_RULES.violence)
})

test('null removes a level; false ignores the category', () => {
  const rules = parseThresholdOverrides('{"violence": {"review": null}, "harassment": false}')
  assert.deepEqual(rules.violence, {})
  assert.equal(rules.harassment, false)
})

test('a bad override is refused with a message that names the problem', () => {
  const bad = [
    ['not json', /not valid JSON/],
    ['[]', /must be a JSON object/],
    ['{"nonsense": {"block": 0.5}}', /"nonsense" is not a category/],
    ['{"sexual": 5}', /must be an object/],
    ['{"sexual": {"block": 2}}', /above 0 and at most 1/],
    ['{"sexual": {"block": 0}}', /above 0 and at most 1/],
    ['{"sexual": {"block": "0.5"}}', /above 0 and at most 1/],
    ['{"sexual": {"warn": 0.5}}', /unknown key "warn"/],
    ['{"sexual": {"block": 0.4, "review": 0.6}}', /must not be above block/],
  ]
  for (const [raw, pattern] of bad) assert.throws(() => parseThresholdOverrides(raw), pattern, raw)
})

test('the hard rule cannot be ignored, loosened past the ceiling, or left without a block level', () => {
  assert.throws(() => parseThresholdOverrides(`{"${HARD_RULE}": false}`), /cannot be ignored/)
  assert.throws(() => parseThresholdOverrides(`{"${HARD_RULE}": {"block": ${HARD_RULE_CEILING + 0.1}}}`), /may not be above/)
  assert.throws(() => parseThresholdOverrides(`{"${HARD_RULE}": {"block": null}}`), /must keep a block threshold/)
  // Stricter is fine.
  assert.equal(parseThresholdOverrides(`{"${HARD_RULE}": {"block": 0.02}}`)[HARD_RULE].block, 0.02)
  assert.equal(parseThresholdOverrides(`{"${HARD_RULE}": {"block": ${HARD_RULE_CEILING}}}`)[HARD_RULE].block, HARD_RULE_CEILING)
})

test('overriding does not mutate the shared defaults', () => {
  parseThresholdOverrides('{"sexual": {"block": 0.99}}')
  assert.equal(DEFAULT_RULES.sexual.block, 0.85)
  assert.throws(() => { DEFAULT_RULES.sexual = {} }, TypeError, 'DEFAULT_RULES is frozen')
})
