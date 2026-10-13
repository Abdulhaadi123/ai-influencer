// The prices page: what each model costs and whether it may be used. The on/off
// switch is live, so turning a model off must ask — and must put the switch back
// if the answer is no or the server says no.

import test, { beforeEach } from 'node:test'
import assert from './assert.js'

import {
  installDom, reset, click, type, change, submit, settle, text, all, byText, fakeApi, viewContext, apiError,
} from './helpers.js'

installDom()
const { renderPrices, validatePriceForm } = await import('../views/prices.js')

beforeEach(reset)

const recent = seconds => new Date(Date.now() - seconds * 1000).toISOString()

const price = (model, over = {}) => ({
  model, unit: 'per_video', credits: 20, enabled: true, label: null, note: null, updatedAt: recent(3600), updatedBy: 'boss@test.example', ...over,
})
const data = (over = {}) => ({
  prices: [price('kling-3.0/video', { label: 'Kling video', note: 'launch price' }), price('nano-banana-pro', { unit: 'per_image', credits: 4, enabled: false })],
  unpriced: [{ model: 'veo-3-1', jobs: 12, kieCredits: 345.5 }],
  units: ['per_second', 'per_video', 'per_image'],
  ...over,
})

function open({ payload = data(), routes = {} } = {}) {
  const api = fakeApi({
    'GET /api/admin/prices': () => structuredClone(payload),
    'POST /api/admin/prices/upsert': body => ({ ok: true, price: { ...body, updatedAt: recent(0) } }),
    'POST /api/admin/prices/delete': { ok: true },
    ...routes,
  })
  const { ctx } = viewContext(api, { name: 'prices', id: null, query: {} })
  document.body.append(ctx.container)
  const controller = renderPrices(ctx)
  return { api, ctx, controller, root: ctx.container }
}

const dialog = () => document.querySelector('dialog')
const rowFor = (root, model) => all(root, 'tbody tr').find(r => r.querySelector('.mono')?.textContent.includes(model))
const field = (label) => {
  const wrapper = all(dialog(), 'label').find(l => l.textContent.trim().startsWith(label))
  return wrapper.querySelector('input, select, textarea') ?? document.getElementById(wrapper.getAttribute('for'))
}
const upserts = api => api.of('POST', '/api/admin/prices/upsert')

// ── The form's rules ─────────────────────────────────────────────────────────

test('validatePriceForm accepts a good price and returns it clean', () => {
  const r = validatePriceForm({ model: '  kling-3.0/video ', unit: 'per_video', credits: ' 20.5 ', enabled: true, label: ' Kling ', note: ' launch ' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, { model: 'kling-3.0/video', unit: 'per_video', credits: 20.5, enabled: true, label: 'Kling', note: 'launch' })
})

test('validatePriceForm leaves out an empty label and note, and treats anything not truthy as off', () => {
  const r = validatePriceForm({ model: 'a', unit: 'per_image', credits: '0', enabled: 0, label: '   ', note: '' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, { model: 'a', unit: 'per_image', credits: 0, enabled: false })
})

test('validatePriceForm explains each mistake next to its own field', () => {
  const cases = [
    [{ model: '', unit: 'per_video', credits: 1 }, 'model', /Enter the model id/],
    [{ model: '   ', unit: 'per_video', credits: 1 }, 'model', /Enter the model id/],
    [{ model: 'bad id', unit: 'per_video', credits: 1 }, 'model', /letters, numbers/],
    [{ model: '-start', unit: 'per_video', credits: 1 }, 'model', /letters, numbers/],
    [{ model: 'a'.repeat(201), unit: 'per_video', credits: 1 }, 'model', /letters, numbers/],
    [{ model: '<script>', unit: 'per_video', credits: 1 }, 'model', /letters, numbers/],
    [{ model: 'a', unit: 'per_year', credits: 1 }, 'unit', /Choose what the price is per/],
    [{ model: 'a', unit: '', credits: 1 }, 'unit', /Choose/],
    [{ model: 'a', unit: 'per_video', credits: '' }, 'credits', /Enter a price/],
    [{ model: 'a', unit: 'per_video', credits: '  ' }, 'credits', /Enter a price/],
    [{ model: 'a', unit: 'per_video', credits: undefined }, 'credits', /Enter a price/],
    [{ model: 'a', unit: 'per_video', credits: 'abc' }, 'credits', /must be a number/],
    [{ model: 'a', unit: 'per_video', credits: '-1' }, 'credits', /zero or more/],
    [{ model: 'a', unit: 'per_video', credits: 'Infinity' }, 'credits', /must be a number/],
    [{ model: 'a', unit: 'per_video', credits: '1e999' }, 'credits', /must be a number/],
    [{ model: 'a', unit: 'per_video', credits: 1_000_001 }, 'credits', /cannot be more than 1,000,000/],
    [{ model: 'a', unit: 'per_video', credits: 1, label: 'x'.repeat(121) }, 'label', /at most 120/],
    [{ model: 'a', unit: 'per_video', credits: 1, note: 'x'.repeat(301) }, 'note', /at most 300/],
  ]
  for (const [input, field, pattern] of cases) {
    const r = validatePriceForm(input)
    assert.equal(r.ok, false, JSON.stringify(input))
    assert.match(r.errors[field], pattern, JSON.stringify(input))
  }
})

test('validatePriceForm accepts the edges: id of 200 characters, price 0 and exactly the maximum, text at its limits', () => {
  assert.equal(validatePriceForm({ model: `a${'b'.repeat(199)}`, unit: 'per_video', credits: 0 }).ok, true)
  assert.equal(validatePriceForm({ model: 'a', unit: 'per_video', credits: 1_000_000 }).ok, true)
  assert.equal(validatePriceForm({ model: 'a', unit: 'per_video', credits: 0.001 }).ok, true)
  assert.equal(validatePriceForm({ model: 'a', unit: 'per_video', credits: 1, label: 'x'.repeat(120), note: 'y'.repeat(300) }).ok, true)
  assert.equal(validatePriceForm({ model: 'a:b/c.d-e_f', unit: 'per_video', credits: 1 }).ok, true)
})

test('validatePriceForm reports every mistake at once, and never throws on missing input', () => {
  const r = validatePriceForm({})
  assert.equal(r.ok, false)
  assert.deepEqual(Object.keys(r.errors).sort(), ['credits', 'model', 'unit'])
  assert.doesNotThrow(() => validatePriceForm({ model: null, unit: null, credits: null, enabled: null, label: null, note: null }))
})

// ── The list ─────────────────────────────────────────────────────────────────

test('the page says plainly that a price waits for billing but the switch is live', async () => {
  const { root } = open()
  await settle()
  assert.match(text(root.querySelector('.callout')), /applied when billing is switched on/)
  assert.match(text(root.querySelector('.callout')), /live/)
})

test('each priced model shows its price, unit, switch, note and who changed it', async () => {
  const { root } = open()
  await settle()
  const first = text(rowFor(root, 'kling-3.0/video'))
  assert.match(first, /Kling video/)
  assert.match(first, /20 credits \//)
  assert.match(first, /On/)
  assert.match(first, /launch price/)
  assert.match(first, /1 h ago/)
  assert.match(first, /boss@test\.example/)

  const second = rowFor(root, 'nano-banana-pro')
  assert.match(text(second), /Off/)
  assert.equal(second.querySelector('[role=switch]').getAttribute('aria-checked'), 'false')
  assert.equal(second.querySelector('[role=switch]').getAttribute('aria-label'), 'Enable nano-banana-pro')
  assert.equal(rowFor(root, 'kling-3.0/video').querySelector('[role=switch]').getAttribute('aria-label'), 'Disable kling-3.0/video')
})

test('models used without a price are listed apart, with their usage and a button to price them', async () => {
  const { root } = open()
  await settle()
  const card = byText(root, '.card', 'In use, but not priced')
  assert.match(text(card), /veo-3-1/)
  assert.match(text(card), /12/)
  assert.match(text(card), /345\.5/)
  assert.ok(byText(card, 'button', 'Set a price'))
})

test('with nothing unpriced there is no such section', async () => {
  const { root } = open({ payload: data({ unpriced: [] }) })
  await settle()
  assert.equal(byText(root, '.card', 'In use, but not priced'), null)
})

test('with nothing priced the page invites the first price instead of showing an empty table', async () => {
  const { root } = open({ payload: data({ prices: [], unpriced: [] }) })
  await settle()
  assert.equal(root.querySelector('table'), null)
  assert.match(text(root), /No prices yet/)
  assert.match(text(root), /every model is allowed and unpriced/)
})

test('a failed load shows the error and Try again loads again', async () => {
  let n = 0
  const { root, api } = open({ routes: { 'GET /api/admin/prices': () => { if (++n === 1) throw apiError('Down.', 503, 'X'); return data() } } })
  await settle()
  assert.match(text(root), /Down\./)
  click(byText(root, 'button', 'Try again'))
  await settle()
  assert.equal(all(root, 'tbody tr').length, 3, 'two priced + one unpriced')
  assert.equal(api.of('GET', '/api/admin/prices').length, 2)
})

test('hostile model names, labels and notes are text', async () => {
  const { root } = open({ payload: data({ prices: [price('<img src=x onerror=1>', { label: '<b>l</b>', note: '<script>1</script>' })], unpriced: [{ model: '<i>m</i>', jobs: 1, kieCredits: 1 }] }) })
  await settle()
  assert.equal(root.querySelectorAll('img, b, script, i').length, 0)
})

// ── The switch ───────────────────────────────────────────────────────────────

test('turning a model ON needs no question; it saves the same price with enabled true', async () => {
  const { root, api } = open()
  await settle()
  click(rowFor(root, 'nano-banana-pro').querySelector('[role=switch]'))
  await settle()
  assert.equal(dialog(), null, 'no question for switching on')
  assert.deepEqual(upserts(api)[0].input, { model: 'nano-banana-pro', unit: 'per_image', credits: 4, enabled: true })
  assert.match(text(document.querySelector('.toast-success')), /nano-banana-pro is on/)
  assert.equal(api.of('GET', '/api/admin/prices').length, 2, 'the list reloaded')
})

test('turning a model OFF asks first and says what happens; yes sends it with its label and note kept', async () => {
  const { root, api } = open()
  await settle()
  click(rowFor(root, 'kling-3.0/video').querySelector('[role=switch]'))
  await settle()
  assert.match(text(dialog()), /Switch off kling-3\.0\/video\?/)
  assert.match(text(dialog()), /refused immediately/)
  assert.match(text(dialog()), /already running are not affected/)
  assert.ok(dialog().querySelector('.btn-danger-solid'))
  assert.equal(upserts(api).length, 0, 'nothing sent while the question is open')
  submit(dialog().querySelector('form'))
  await settle()
  assert.deepEqual(upserts(api)[0].input, { model: 'kling-3.0/video', unit: 'per_video', credits: 20, enabled: false, label: 'Kling video', note: 'launch price' })
  assert.match(text(document.querySelector('.toast-success')), /kling-3\.0\/video is off/)
})

test('saying no to switching off sends nothing and leaves the switch on', async () => {
  const { root, api } = open()
  await settle()
  const sw = rowFor(root, 'kling-3.0/video').querySelector('[role=switch]')
  click(sw)
  await settle()
  click(dialog().querySelector('button[type=button]'))
  await settle()
  assert.equal(upserts(api).length, 0)
  assert.equal(sw.getAttribute('aria-checked'), 'true')
  assert.equal(sw.disabled, false, 'usable again')
  assert.equal(document.querySelector('.toast-error'), null, 'declining is not an error')
})

test('if the server refuses the change the switch goes back and the error is shown', async () => {
  const { root } = open({ routes: { 'POST /api/admin/prices/upsert': () => { throw apiError('Not allowed.', 403, 'FORBIDDEN') } } })
  await settle()
  const sw = rowFor(root, 'nano-banana-pro').querySelector('[role=switch]')
  click(sw)
  await settle()
  assert.equal(sw.getAttribute('aria-checked'), 'false', 'still off')
  assert.match(text(document.querySelector('.toast-error')), /Could not change the model/)
  assert.match(text(document.querySelector('.toast-error')), /Not allowed/)
})

test('the switch cannot be pressed twice while a change is in flight', async () => {
  let release
  const { root, api } = open({ routes: { 'POST /api/admin/prices/upsert': body => new Promise(r => { release = () => r({ ok: true, price: body }) }) } })
  await settle()
  const sw = rowFor(root, 'nano-banana-pro').querySelector('[role=switch]')
  click(sw)
  click(sw)
  click(sw)
  await settle()
  assert.equal(upserts(api).length, 1)
  assert.equal(sw.disabled, true)
  release()
  await settle()
})

// ── Adding and editing ───────────────────────────────────────────────────────

test('"Add a price" opens an empty form that is allowed by default; saving sends exactly what was entered', async () => {
  const { root, api } = open()
  await settle()
  click(byText(root, 'button', 'Add a price'))
  await settle()
  assert.match(text(dialog()), /Add a price/)
  assert.equal(field('Model id').value, '')
  assert.equal(field('Model id').readOnly, false)
  assert.equal(field('Allowed').checked, true)

  type(field('Model id'), ' veo-3-1 ')
  type(field('Price in credits'), '12.5')
  change(field('Per'), 'per_second')
  type(field('Label'), 'Veo')
  type(field('Note'), 'tbd')
  submit(dialog().querySelector('form'))
  await settle()

  assert.deepEqual(upserts(api)[0].input, { model: 'veo-3-1', unit: 'per_second', credits: 12.5, enabled: true, label: 'Veo', note: 'tbd' })
  assert.equal(dialog(), null)
  assert.match(text(document.querySelector('.toast-success')), /Saved the price for veo-3-1/)
  assert.equal(api.of('GET', '/api/admin/prices').length, 2)
})

test('the unit list in the form is whatever the server says it supports', async () => {
  const { root } = open({ payload: data({ units: ['per_video', 'per_image'] }) })
  await settle()
  click(byText(root, 'button', 'Add a price'))
  await settle()
  assert.deepEqual(all(field('Per'), 'option').map(o => o.value), ['per_video', 'per_image'])
})

test('mistakes are shown beside their fields, nothing is sent, and the form stays open with what was typed', async () => {
  const { root, api } = open()
  await settle()
  click(byText(root, 'button', 'Add a price'))
  await settle()
  type(field('Model id'), 'bad id')
  type(field('Price in credits'), '-3')
  submit(dialog().querySelector('form'))
  await settle()

  const errors = all(dialog(), '.field-error').map(e => text(e))
  assert.ok(errors.some(e => /letters, numbers/.test(e)))
  assert.ok(errors.some(e => /zero or more/.test(e)))
  assert.match(text(dialog().querySelector('.form-error')), /Fix the highlighted fields/)
  assert.equal(upserts(api).length, 0)
  assert.equal(field('Model id').value, 'bad id')

  // Fix them: the old messages clear and the save goes through.
  type(field('Model id'), 'good-id')
  type(field('Price in credits'), '3')
  submit(dialog().querySelector('form'))
  await settle()
  assert.equal(upserts(api).length, 1)
  assert.equal(dialog(), null)
})

test('a price of zero is allowed, but an empty price is not', async () => {
  const { root, api } = open()
  await settle()
  click(byText(root, 'button', 'Add a price'))
  await settle()
  type(field('Model id'), 'free-model')
  submit(dialog().querySelector('form')); await settle()
  assert.match(text(dialog()), /Enter a price/)
  type(field('Price in credits'), '0')
  submit(dialog().querySelector('form')); await settle()
  assert.equal(upserts(api)[0].input.credits, 0)
})

test('a refusal from the server is shown inside the form and nothing typed is lost', async () => {
  const { root } = open({ routes: { 'POST /api/admin/prices/upsert': () => { throw apiError('That model id is not accepted.', 400, 'BAD_MODEL') } } })
  await settle()
  click(byText(root, 'button', 'Add a price'))
  await settle()
  type(field('Model id'), 'x'); type(field('Price in credits'), '5')
  submit(dialog().querySelector('form')); await settle()
  assert.match(text(dialog().querySelector('.form-error')), /not accepted/)
  assert.equal(field('Price in credits').value, '5')
})

test('"Edit" fills the form with the current values and locks the model id; saving keeps the rest', async () => {
  const { root, api } = open()
  await settle()
  click(byText(rowFor(root, 'kling-3.0/video'), 'button', 'Edit'))
  await settle()
  assert.match(text(dialog()), /Edit kling-3\.0\/video/)
  assert.equal(field('Model id').value, 'kling-3.0/video')
  assert.equal(field('Model id').readOnly, true, 'renaming would silently create a second price')
  assert.equal(field('Price in credits').value, '20')
  assert.equal(field('Per').value, 'per_video')
  assert.equal(field('Label').value, 'Kling video')
  assert.equal(field('Note').value, 'launch price')
  assert.equal(field('Allowed').checked, true)

  type(field('Price in credits'), '25')
  submit(dialog().querySelector('form')); await settle()
  assert.deepEqual(upserts(api)[0].input, { model: 'kling-3.0/video', unit: 'per_video', credits: 25, enabled: true, label: 'Kling video', note: 'launch price' })
})

test('editing a model that is switched off keeps it off; unticking Allowed turns it off', async () => {
  const { root, api } = open()
  await settle()
  click(byText(rowFor(root, 'nano-banana-pro'), 'button', 'Edit'))
  await settle()
  assert.equal(field('Allowed').checked, false)
  submit(dialog().querySelector('form')); await settle()
  assert.equal(upserts(api)[0].input.enabled, false)

  click(byText(rowFor(root, 'kling-3.0/video'), 'button', 'Edit'))
  await settle()
  field('Allowed').checked = false
  submit(dialog().querySelector('form')); await settle()
  assert.equal(upserts(api)[1].input.enabled, false)
})

test('clearing a label or note while editing removes it (it is simply not sent)', async () => {
  const { root, api } = open()
  await settle()
  click(byText(rowFor(root, 'kling-3.0/video'), 'button', 'Edit'))
  await settle()
  type(field('Label'), ''); type(field('Note'), '   ')
  submit(dialog().querySelector('form')); await settle()
  assert.equal('label' in upserts(api)[0].input, false)
  assert.equal('note' in upserts(api)[0].input, false)
})

test('cancelling the form sends nothing', async () => {
  const { root, api } = open()
  await settle()
  click(byText(root, 'button', 'Add a price'))
  await settle()
  type(field('Model id'), 'abc')
  click(dialog().querySelector('button[type=button]'))
  await settle()
  assert.equal(dialog(), null)
  assert.equal(upserts(api).length, 0)
})

test('"Set a price" on an unpriced model opens the form with that model chosen and allowed', async () => {
  const { root, api } = open()
  await settle()
  click(byText(byText(root, '.card', 'In use, but not priced'), 'button', 'Set a price'))
  await settle()
  assert.match(text(dialog()), /Set a price for veo-3-1/)
  assert.equal(field('Model id').value, 'veo-3-1')
  assert.equal(field('Model id').readOnly, true)
  assert.equal(field('Allowed').checked, true)
  type(field('Price in credits'), '9')
  submit(dialog().querySelector('form')); await settle()
  assert.deepEqual(upserts(api)[0].input, { model: 'veo-3-1', unit: 'per_video', credits: 9, enabled: true })
})

// ── Deleting ─────────────────────────────────────────────────────────────────

test('deleting asks first, explains that the model stays allowed, and sends only the model id', async () => {
  const { root, api } = open()
  await settle()
  click(byText(rowFor(root, 'nano-banana-pro'), 'button', 'Delete'))
  await settle()
  assert.match(text(dialog()), /Delete the price for nano-banana-pro\?/)
  assert.match(text(dialog()), /stays allowed/)
  assert.match(text(dialog()), /switch it off instead/)
  assert.equal(api.of('POST', '/api/admin/prices/delete').length, 0)
  submit(dialog().querySelector('form')); await settle()
  assert.deepEqual(api.of('POST', '/api/admin/prices/delete')[0].input, { model: 'nano-banana-pro' })
  assert.match(text(document.querySelector('.toast-success')), /Deleted the price for nano-banana-pro/)
  assert.equal(api.of('GET', '/api/admin/prices').length, 2)
})

test('saying no to a deletion, or a failed deletion, changes nothing', async () => {
  const { root, api } = open({ routes: { 'POST /api/admin/prices/delete': () => { throw apiError('Locked.', 409, 'X') } } })
  await settle()
  click(byText(rowFor(root, 'nano-banana-pro'), 'button', 'Delete'))
  await settle()
  click(dialog().querySelector('button[type=button]'))
  await settle()
  assert.equal(api.of('POST', '/api/admin/prices/delete').length, 0)

  click(byText(rowFor(root, 'nano-banana-pro'), 'button', 'Delete'))
  await settle()
  submit(dialog().querySelector('form')); await settle()
  assert.match(text(document.querySelector('.toast-error')), /Could not delete the price/)
  assert.match(text(document.querySelector('.toast-error')), /Locked/)
  assert.equal(api.of('GET', '/api/admin/prices').length, 1, 'not reloaded after a failure')
})
