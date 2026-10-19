// The decisions inside the views that need no browser: what needs attention, who may
// do what to whom, how a price is validated, how an audit entry reads.

import test from 'node:test'
import assert from './assert.js'

import { attentionItems } from '../views/overview.js'
import { userActions } from '../views/users.js'
import { thresholdMarks, outcomeMessage } from '../views/moderation.js'
import { validatePriceForm } from '../views/prices.js'
import { describeDetails } from '../views/audit.js'
import { thresholdRows } from '../views/settings.js'
import { stats, config } from './helpers.js'

// ── What needs attention ─────────────────────────────────────────────────────

const calm = () => stats({ moderation: { open: 0, openBlocked: 0, events24h: 0 } })

test('attention: a healthy platform has nothing on the list', () => {
  assert.deepEqual(attentionItems(calm(), config()), [])
})

test('attention: moderation off is the most urgent, and says which of the two reasons it is', () => {
  const noKey = attentionItems(calm(), config({ moderation: { enabled: false, checkerConfigured: false } }))
  assert.equal(noKey[0].id, 'moderation-off')
  assert.equal(noKey[0].tone, 'danger')
  assert.match(noKey[0].body, /OPENAI_API_KEY/)

  const switchedOff = attentionItems(calm(), config({ moderation: { enabled: false, checkerConfigured: true } }))
  assert.match(switchedOff[0].body, /MODERATION_ENABLED=false/)
})

test('attention: moderation on without a key — what happens depends on the fail mode', () => {
  const closed = attentionItems(calm(), config({ moderation: { enabled: true, checkerConfigured: false, failMode: 'closed' } }))
  assert.equal(closed[0].id, 'moderation-no-key')
  assert.match(closed[0].body, /refused/)
  const open = attentionItems(calm(), config({ moderation: { enabled: true, checkerConfigured: false, failMode: 'open' } }))
  assert.match(open[0].body, /Nothing is being checked/)
})

test('attention: an invalid thresholds setting is a warning that says what is wrong', () => {
  const items = attentionItems(calm(), config({ moderation: { thresholdsProblem: 'MODERATION_THRESHOLDS is not valid JSON.' } }))
  assert.equal(items[0].id, 'thresholds')
  assert.equal(items[0].tone, 'warning')
  assert.match(items[0].body, /not valid JSON/)
})

test('attention: waiting moderation items — a warning when some were refused, otherwise a note — and the singular reads right', () => {
  const some = attentionItems(stats({ moderation: { open: 3, openBlocked: 2, events24h: 5 } }), config())
  assert.equal(some[0].id, 'moderation-open')
  assert.equal(some[0].tone, 'warning')
  assert.match(some[0].title, /3 moderation items waiting/)
  assert.match(some[0].body, /2 of them were refused/)
  assert.equal(some[0].href, '#/moderation')

  const held = attentionItems(stats({ moderation: { open: 1, openBlocked: 0, events24h: 1 } }), config())
  assert.equal(held[0].tone, 'info')
  assert.match(held[0].title, /1 moderation item waiting/)

  const one = attentionItems(stats({ moderation: { open: 2, openBlocked: 1, events24h: 2 } }), config())
  assert.match(one[0].body, /1 of them was refused/)
})

test('attention: a failure rate is only worth saying with enough generations behind it', () => {
  const base = (started, failed) => attentionItems(stats({ jobs: { running: 0, started24h: started, failed24h: failed, credits24h: 0, credits7d: 0, credits30d: 0, chargeUnknown30d: 0 }, moderation: { open: 0, openBlocked: 0, events24h: 0 } }), config())
  assert.equal(base(10, 3).find(i => i.id === 'failures').title, '30% of today\'s generations failed')
  assert.equal(base(10, 2).find(i => i.id === 'failures'), undefined, '20% is not alarming')
  assert.equal(base(9, 9).find(i => i.id === 'failures'), undefined, 'nine generations is too few to call a rate')
  assert.equal(base(100, 100).find(i => i.id === 'failures').title, '100% of today\'s generations failed')
  assert.equal(base(0, 0).find(i => i.id === 'failures'), undefined)
  assert.equal(base(10, 3).find(i => i.id === 'failures').href, '#/jobs?state=fail')
})

test('attention: models in use without a price, and callbacks being off', () => {
  const priced = attentionItems(stats({ unpricedModels: 2, moderation: { open: 0, openBlocked: 0, events24h: 0 } }), config())
  assert.match(priced.find(i => i.id === 'unpriced').title, /2 models in use without a price/)
  assert.match(attentionItems(stats({ unpricedModels: 1, moderation: { open: 0, openBlocked: 0, events24h: 0 } }), config()).find(i => i.id === 'unpriced').title, /1 model in use/)

  const callbacks = attentionItems(calm(), config({ kie: { callbacksConfigured: false } }))
  assert.equal(callbacks[0].id, 'callbacks')
  assert.equal(callbacks[0].tone, 'info')
})

test('attention: the order is urgency, and every item with a link says what the link is for', () => {
  const everything = attentionItems(
    stats({ unpricedModels: 1, moderation: { open: 4, openBlocked: 2, events24h: 4 }, jobs: { running: 0, started24h: 20, failed24h: 10, credits24h: 0, credits7d: 0, credits30d: 0, chargeUnknown30d: 0 } }),
    config({ moderation: { enabled: false, checkerConfigured: false, thresholdsProblem: 'bad' }, kie: { callbacksConfigured: false } }),
  )
  assert.deepEqual(everything.map(i => i.id), ['moderation-off', 'thresholds', 'moderation-open', 'failures', 'unpriced', 'callbacks'])
  for (const item of everything) {
    assert.ok(item.title && item.body, item.id)
    if (item.href) assert.ok(item.action, `${item.id} has a link and its label`)
    assert.ok(['danger', 'warning', 'info'].includes(item.tone))
  }
})

test('attention: missing data never throws', () => {
  assert.deepEqual(attentionItems(undefined, undefined), [])
  assert.deepEqual(attentionItems({}, {}), [])
  assert.deepEqual(attentionItems(null, { moderation: null, kie: { callbacksConfigured: true } }), [])
  assert.doesNotThrow(() => attentionItems(stats(), undefined))
})

// ── Who may do what ──────────────────────────────────────────────────────────

const me = { id: 'me' }
const person = (over = {}) => ({ id: 'them', role: 'user', status: 'active', ...over })

test('userActions: an ordinary active user can be suspended, promoted and deleted', () => {
  const a = userActions(person(), me)
  assert.deepEqual([a.canSuspend, a.canRestore, a.canPromote, a.canDemote, a.canDelete, a.self], [true, false, true, false, true, false])
  assert.deepEqual(a.why, { suspend: null, role: null, delete: null })
})

test('userActions: a suspended user can be restored, not suspended again, and can still be deleted', () => {
  const a = userActions(person({ status: 'suspended' }), me)
  assert.deepEqual([a.canSuspend, a.canRestore, a.canDelete], [false, true, true])
})

test('userActions: another administrator can be demoted, but not suspended or deleted until they are', () => {
  const a = userActions(person({ role: 'admin' }), me)
  assert.deepEqual([a.canSuspend, a.canPromote, a.canDemote, a.canDelete], [false, false, true, false])
  assert.match(a.why.suspend, /admin role first/)
  assert.match(a.why.delete, /admin role first/)
})

test('userActions: you can do nothing destructive to yourself, and are told why', () => {
  for (const role of ['user', 'admin']) {
    const a = userActions({ id: 'me', role, status: 'active' }, me)
    assert.equal(a.self, true)
    assert.deepEqual([a.canSuspend, a.canPromote, a.canDemote, a.canDelete], [false, false, false, false], role)
    assert.match(a.why.suspend, /your own account/)
    assert.match(a.why.role, /your own account/)
    assert.match(a.why.delete, /your own account/)
  }
})

test('userActions: restoring does not depend on who you are (the server decides)', () => {
  assert.equal(userActions({ id: 'me', role: 'user', status: 'suspended' }, me).canRestore, true)
})

// ── Moderation helpers ───────────────────────────────────────────────────────

test('thresholdMarks: where the review and refuse lines sit, and nothing for a category with none', () => {
  const rules = { sexual: { block: 0.85, review: 0.5 }, violence: { review: 0.8 }, 'sexual/minors': { block: 0.1 }, harassment: false, empty: {} }
  assert.deepEqual(thresholdMarks(rules, 'sexual'), { review: 0.5, block: 0.85 })
  assert.deepEqual(thresholdMarks(rules, 'violence'), { review: 0.8, block: null })
  assert.deepEqual(thresholdMarks(rules, 'sexual/minors'), { review: null, block: 0.1 })
  for (const category of ['harassment', 'unknown', 'empty']) assert.deepEqual(thresholdMarks(rules, category), { review: null, block: null }, category)
  assert.deepEqual(thresholdMarks(null, 'sexual'), { review: null, block: null })
  assert.deepEqual(thresholdMarks(undefined, 'sexual'), { review: null, block: null })
  assert.deepEqual(thresholdMarks({ sexual: { block: 'x', review: null } }, 'sexual'), { review: null, block: null }, 'a non-number is not a line')
})

test('outcomeMessage says what the decision actually did', () => {
  const none = { restored: false, blocked: false, deleted: false, suspended: false }
  assert.equal(outcomeMessage('dismiss', none), 'Dismissed — the strike is withdrawn.')
  assert.equal(outcomeMessage('dismiss', { ...none, restored: true }), 'Dismissed — the strike is withdrawn; the file is back in their gallery.')
  assert.equal(outcomeMessage('confirm', none), 'Confirmed.')
  assert.equal(outcomeMessage('confirm', { ...none, blocked: true }), 'Confirmed; the file is now blocked and hidden from them.')
  assert.equal(outcomeMessage('confirm', { ...none, blocked: true, deleted: true, suspended: true }),
    'Confirmed; the file is now blocked and hidden from them; the file was deleted; the account was suspended.')
  assert.equal(outcomeMessage('confirm', { ...none, suspended: true }), 'Confirmed; the account was suspended.')
})

// ── Price form ───────────────────────────────────────────────────────────────

const goodPrice = { model: 'kling-3.0/video', unit: 'per_second', credits: '20', enabled: true, label: '', note: '' }

test('validatePriceForm: a good price is accepted, trimmed, with empty extras left out', () => {
  const r = validatePriceForm({ ...goodPrice, model: '  kling-3.0/video  ', label: '  Kling  ', note: '' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.errors, {})
  assert.deepEqual(r.value, { model: 'kling-3.0/video', unit: 'per_second', credits: 20, enabled: true, label: 'Kling' })
})

test('validatePriceForm: the model id', () => {
  for (const model of ['', '   ', undefined, null]) assert.match(validatePriceForm({ ...goodPrice, model }).errors.model, /Enter the model id/, String(model))
  for (const model of ['has space', 'semi;colon', '.leading', '-leading', 'x'.repeat(201), 'a\u0000b', '<b>', 'a/b c']) {
    assert.match(validatePriceForm({ ...goodPrice, model }).errors.model, /letters, numbers/, JSON.stringify(model))
  }
  for (const model of ['veo3_fast', 'kling-3.0/video', 'wan/2-6-image-to-video', 'a', 'a:b', 'x'.repeat(200)]) assert.equal(validatePriceForm({ ...goodPrice, model }).errors.model, undefined, model)
})

test('validatePriceForm: the price must be typed, and a number, zero or more, not absurd', () => {
  for (const credits of ['', '  ', undefined, null]) assert.match(validatePriceForm({ ...goodPrice, credits }).errors.credits, /Enter a price/, String(credits))
  for (const credits of ['abc', '-1', '-0.001', 'NaN', 'Infinity']) assert.match(validatePriceForm({ ...goodPrice, credits }).errors.credits, /must be a number/, credits)
  assert.match(validatePriceForm({ ...goodPrice, credits: '1000001' }).errors.credits, /cannot be more than 1,000,000/)
  for (const credits of ['0', '0.0', '12.375', '1000000', ' 5 ', '1e3', 7, 0]) assert.equal(validatePriceForm({ ...goodPrice, credits }).errors.credits, undefined, String(credits))
  assert.equal(validatePriceForm({ ...goodPrice, credits: '0' }).value.credits, 0, 'zero is a price (free), not "missing"')
})

test('validatePriceForm: the unit, label and note', () => {
  for (const unit of ['', 'per_century', undefined, 'PER_VIDEO']) assert.match(validatePriceForm({ ...goodPrice, unit }).errors.unit, /Choose what the price is per/, String(unit))
  for (const unit of ['per_second', 'per_video', 'per_image']) assert.equal(validatePriceForm({ ...goodPrice, unit }).errors.unit, undefined)
  assert.match(validatePriceForm({ ...goodPrice, label: 'x'.repeat(121) }).errors.label, /at most 120/)
  assert.equal(validatePriceForm({ ...goodPrice, label: 'x'.repeat(120) }).errors.label, undefined)
  assert.match(validatePriceForm({ ...goodPrice, note: 'x'.repeat(301) }).errors.note, /at most 300/)
  assert.equal(validatePriceForm({ ...goodPrice, note: 'x'.repeat(300) }).errors.note, undefined)
})

test('validatePriceForm: several mistakes are all reported at once, and enabled is a real boolean', () => {
  const r = validatePriceForm({ model: '', unit: 'x', credits: '', enabled: undefined, label: '', note: '' })
  assert.equal(r.ok, false)
  assert.deepEqual(Object.keys(r.errors).sort(), ['credits', 'model', 'unit'])
  assert.equal(validatePriceForm({ ...goodPrice, enabled: 'yes' }).value.enabled, true)
  assert.equal(validatePriceForm({ ...goodPrice, enabled: 0 }).value.enabled, false)
})

// ── Audit details ────────────────────────────────────────────────────────────

const pairs = (action, details) => describeDetails(action, details).map(([k, v]) => `${k}: ${v}`)

test('describeDetails: each known action reads as a sentence, not JSON', () => {
  assert.deepEqual(pairs('user.suspend', { email: 'a@b.c', reason: 'spam', changed: true }), ['Account: a@b.c', 'Reason: spam'])
  assert.deepEqual(pairs('user.suspend', { email: 'a@b.c', reason: 'spam', changed: false }), ['Account: a@b.c', 'Reason: spam', 'Note: Already suspended'])
  assert.deepEqual(pairs('user.unsuspend', { email: 'a@b.c', changed: false }), ['Account: a@b.c', 'Note: Was not suspended'])
  assert.deepEqual(pairs('user.set-role', { email: 'a@b.c', from: 'user', to: 'admin' }), ['Account: a@b.c', 'Role: user → admin'])
  assert.deepEqual(pairs('user.delete', { email: 'a@b.c', deletedObjects: 3 }), ['Account: a@b.c', 'Files deleted: 3'])
  assert.deepEqual(pairs('user.delete', { email: 'a@b.c', deletedObjects: 0 }), ['Account: a@b.c', 'Files deleted: 0'], 'zero is shown, not dropped')
  assert.deepEqual(pairs('moderation.dismiss', { restored: true, blocked: false, deleted: false, suspended: false, note: 'was a recipe' }), ['Result: File restored to their gallery', 'Note: was a recipe'])
  assert.deepEqual(pairs('moderation.confirm', { blocked: true, deleted: true, suspended: true }), ['Result: File blocked', 'Result: File deleted', 'Result: Account suspended'])
  assert.deepEqual(pairs('moderation.view-media', { eventId: '0b977eac-f255-4a73-885c-745d9dd4fd07' }), ['Item: 0b977eac-f25…'])
  assert.deepEqual(pairs('price.upsert', { unit: 'per_second', credits: 22.125, enabled: false }), ['Price: 22.13 credits per second', 'Allowed: Off'])
  assert.deepEqual(pairs('price.upsert', { unit: 'per_video', credits: 70, enabled: true }), ['Price: 70 credits per video', 'Allowed: On'])
  assert.deepEqual(pairs('price.delete', {}), [])
})

test('describeDetails: an unknown action shows its fields as they are, so nothing is hidden', () => {
  assert.deepEqual(pairs('something.new', { a: 1, b: 'two', c: { nested: true }, d: null, e: '' }), ['a: 1', 'b: two', 'c: {"nested":true}'])
})

test('describeDetails: details that are not an object do not break it', () => {
  for (const details of [null, undefined, 'text', 5, []]) assert.deepEqual(describeDetails('user.suspend', details), [], String(details))
  assert.deepEqual(describeDetails('anything', 'text'), [])
})

test('describeDetails: values are strings, safe to show as text', () => {
  for (const [, value] of describeDetails('user.suspend', { email: '<img src=x onerror=1>', reason: { not: 'a string' } })) assert.equal(typeof value, 'string')
})

// ── Settings ─────────────────────────────────────────────────────────────────

test('thresholdRows: every category, ignored ones marked, partial rules with nulls', () => {
  const rows = thresholdRows({ sexual: { block: 0.85, review: 0.5 }, violence: { review: 0.8 }, harassment: false, 'sexual/minors': { block: 0.1 } })
  assert.deepEqual(rows.map(r => r.category), ['sexual', 'violence', 'harassment', 'sexual/minors'])
  assert.deepEqual(rows[0], { category: 'sexual', label: 'Sexual content', ignored: false, review: 0.5, block: 0.85 })
  assert.deepEqual(rows[1], { category: 'violence', label: 'Violence', ignored: false, review: 0.8, block: null })
  assert.equal(rows[2].ignored, true)
  assert.equal(rows[2].review, null)
  assert.equal(rows[3].review, null)
  assert.deepEqual(thresholdRows({}), [])
  assert.deepEqual(thresholdRows(null), [])
  assert.deepEqual(thresholdRows(undefined), [])
})
