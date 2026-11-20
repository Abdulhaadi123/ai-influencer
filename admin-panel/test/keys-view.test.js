// The API keys page: the KIE keys the server takes in turn. A key is typed once and never shown again, pausing the
// last one asks first, and everything the server refuses is explained where the person is looking.

import test, { beforeEach } from 'node:test'
import assert from './assert.js'

import { installDom, reset, click, type, submit, settle, text, all, byText, fakeApi, viewContext, apiError, ID } from './helpers.js'

installDom()
const { renderKeys, validateKeyForm, problemLine, inRotation, LABEL_MAX } = await import('../views/keys.js')

beforeEach(reset)

const ago = seconds => new Date(Date.now() - seconds * 1000).toISOString()
const soon = seconds => new Date(Date.now() + seconds * 1000).toISOString()

const key = (n, over = {}) => ({
  id: ID(n), source: 'panel', label: `Account ${n}`, hint: '…ab12', enabled: true, state: 'active', problem: null, problemAt: null,
  cooldownUntil: null, uses: 12, lastUsedAt: ago(120), balance: 500, balanceAt: ago(3600), callbacks: true, running: 0, createdAt: ago(86400), ...over,
})
const own = (over = {}) => key(900, { source: 'env', label: 'Server key (.env)', hint: '…9f3a', ...over })
const data = (over = {}) => ({ keys: [own(), key(1), key(2, { callbacks: false, balance: null, balanceAt: null, lastUsedAt: null, uses: 0 })], vault: { configured: true }, ...over })

function open({ payload = data(), routes = {} } = {}) {
  const api = fakeApi({
    'GET /api/admin/kie-keys': () => structuredClone(payload),
    'POST /api/admin/kie-keys/update': body => ({ key: { ...key(1), ...body } }),
    'POST /api/admin/kie-keys/add': body => ({ key: key(7, { label: body.label }) }),
    'POST /api/admin/kie-keys/check': { result: 'ok', key: key(1, { balance: 4200 }) },
    'POST /api/admin/kie-keys/delete': { ok: true },
    ...routes,
  })
  const { ctx } = viewContext(api, { name: 'keys', id: null, query: {} })
  document.body.append(ctx.container)
  const controller = renderKeys(ctx)
  return { api, ctx, controller, root: ctx.container }
}

const dialog = () => document.querySelector('dialog')
const rowFor = (root, label) => all(root, 'tbody tr').find(r => r.querySelector('.cell-main')?.textContent.includes(label))
const fieldIn = (label) => {
  const wrapper = all(dialog(), 'label').find(l => l.textContent.trim().startsWith(label))
  return wrapper.querySelector('input') ?? document.getElementById(wrapper.getAttribute('for'))
}
const calls = (api, path) => api.of('POST', `/api/admin/kie-keys${path}`)
const GOOD_KEY = 'bbbb1111bbbb1111bbbb1111bbbb1111'

// ── The form's rules ─────────────────────────────────────────────────────────

test('validateKeyForm accepts a good key and returns it clean, leaving out an empty webhook key', () => {
  const r = validateKeyForm({ label: '  KIE account 2 ', key: `  ${GOOD_KEY}  `, webhookSecret: '  ' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, { label: 'KIE account 2', key: GOOD_KEY })
  assert.deepEqual(validateKeyForm({ label: 'a', key: GOOD_KEY, webhookSecret: ' hook-secret ' }).value, { label: 'a', key: GOOD_KEY, webhookSecret: 'hook-secret' })
})

test('validateKeyForm explains each mistake next to its own field, all at once, and never throws', () => {
  const cases = [
    [{ label: '', key: GOOD_KEY }, 'label', /Give the key a name/],
    [{ label: 'x'.repeat(LABEL_MAX + 1), key: GOOD_KEY }, 'label', /at most 60/],
    [{ label: 'a', key: '' }, 'key', /Paste the API key/],
    [{ label: 'a', key: 'aaaa bbbb cccc dddd' }, 'key', /no spaces/],
    [{ label: 'a', key: `${GOOD_KEY}\n${GOOD_KEY}` }, 'key', /no spaces or line breaks/],
    [{ label: 'a', key: 'short' }, 'key', /16 to 256/],
    [{ label: 'a', key: 'x'.repeat(257) }, 'key', /16 to 256/],
    [{ label: 'a', key: GOOD_KEY, webhookSecret: 'abc' }, 'webhookSecret', /8 to 256/],
    [{ label: 'a', key: GOOD_KEY, webhookSecret: 'has space inside' }, 'webhookSecret', /no spaces/],
  ]
  for (const [input, field, pattern] of cases) {
    const r = validateKeyForm(input)
    assert.equal(r.ok, false, JSON.stringify(input))
    assert.match(r.errors[field], pattern, JSON.stringify(input))
  }
  assert.deepEqual(Object.keys(validateKeyForm({}).errors).sort(), ['key', 'label'])
  assert.doesNotThrow(() => validateKeyForm({ label: null, key: null, webhookSecret: null }))
  assert.equal(validateKeyForm({ label: 'a', key: 'x'.repeat(16) }).ok, true)
  assert.equal(validateKeyForm({ label: 'a', key: 'x'.repeat(256) }).ok, true)
})

test('problemLine says why KIE refused a key and when it is asked again; nothing when it has not', () => {
  assert.equal(problemLine(key(1)), null)
  assert.match(problemLine(key(1, { problem: 'no_credits', cooldownUntil: soon(300), state: 'cooling' })), /Out of credits\. Asked again in 5 min\./)
  assert.match(problemLine(key(1, { problem: 'rate_limited', cooldownUntil: soon(60) })), /KIE said to slow down/)
  assert.match(problemLine(key(1, { problem: 'rejected', problemAt: ago(1200) })), /KIE did not accept the key, 20 min ago\./)
  assert.match(problemLine(key(1, { problem: 'something-new', problemAt: ago(60) })), /KIE refused it/)
})

test('inRotation counts the keys that take turns: waiting ones too, paused, unreadable and missing ones not', () => {
  const states = ['active', 'cooling', 'paused', 'unreadable', 'missing']
  assert.equal(inRotation(states.map((state, i) => key(i, { state }))), 2)
  assert.equal(inRotation([]), 0)
})

// ── The list ─────────────────────────────────────────────────────────────────

test('each key shows its name, the end of it, its state, how much it has been used, what is left on it and whether results are instant', async () => {
  const { root } = open()
  await settle()
  const ownRow = text(rowFor(root, 'Server key (.env)'))
  assert.match(ownRow, /Server’s own/)
  assert.match(ownRow, /…9f3a/)
  assert.match(ownRow, /In rotation/)

  const first = text(rowFor(root, 'Account 1'))
  assert.match(first, /…ab12/)
  assert.match(first, /12/)
  assert.match(first, /2 min ago/)
  assert.match(first, /500/)
  assert.match(first, /checked 1 h ago/)
  assert.match(first, /On/)

  const second = text(rowFor(root, 'Account 2'))
  assert.match(second, /never/)
  assert.match(second, /—/, 'no balance until Check is pressed')
  assert.match(second, /Off/)
  assert.match(text(root), /3 keys, 3 taking turns/)
})

test('a key that is waiting says why, and a running count appears only when something is running', async () => {
  const { root } = open({ payload: data({ keys: [own(), key(1, { state: 'cooling', problem: 'no_credits', cooldownUntil: soon(300), running: 3 }), key(2, { state: 'paused', enabled: false })] }) })
  await settle()
  const waiting = text(rowFor(root, 'Account 1'))
  assert.match(waiting, /Waiting/)
  assert.match(waiting, /Out of credits\. Asked again in 5 min\./)
  assert.match(waiting, /3 running/)
  assert.doesNotMatch(text(rowFor(root, 'Server key (.env)')), /running/)
  assert.match(text(rowFor(root, 'Account 2')), /Paused/)
  assert.equal(rowFor(root, 'Account 2').querySelector('[role=switch]').getAttribute('aria-checked'), 'false')
  assert.equal(rowFor(root, 'Account 2').querySelector('[role=switch]').getAttribute('aria-label'), 'Resume Account 2')
})

test('the server\'s own key cannot be removed here, the others can; a key that is not set cannot be switched or checked', async () => {
  const { root } = open({ payload: data({ keys: [own({ state: 'missing', hint: null }), key(1)] }) })
  await settle()
  const ownRow = rowFor(root, 'Server key (.env)')
  assert.equal(byText(ownRow, 'button', 'Remove'), null)
  assert.ok(byText(rowFor(root, 'Account 1'), 'button', 'Remove'))
  assert.match(text(ownRow), /Not set/)
  assert.match(text(ownRow), /KIE_API_KEY is not set/)
  assert.equal(ownRow.querySelector('[role=switch]').disabled, true)
  assert.equal(byText(ownRow, 'button', 'Check').disabled, true)
})

test('hostile names are text, and the page holds nothing that looks like a whole key', async () => {
  const { root } = open({ payload: data({ keys: [own(), key(1, { label: '<img src=x onerror=1>' })] }) })
  await settle()
  assert.equal(root.querySelectorAll('img, script').length, 0)
  assert.doesNotMatch(root.innerHTML, /[0-9a-f]{32}/)
})

test('the page warns when keys cannot be stored, when no key takes turns, and when only one does', async () => {
  const noVault = open({ payload: data({ vault: { configured: false } }) })
  await settle()
  assert.match(text(noVault.root.querySelector('.callout-warning')), /KEY_VAULT_SECRET/)
  assert.equal(byText(document, 'button', 'Add a key').disabled, true)

  reset()
  const none = open({ payload: data({ keys: [own({ state: 'paused', enabled: false }), key(1, { state: 'unreadable' })] }) })
  await settle()
  assert.match(text(none.root.querySelector('.callout-danger')), /No key is in rotation/)

  reset()
  const one = open({ payload: data({ keys: [own(), key(1, { state: 'paused', enabled: false })] }) })
  await settle()
  assert.match(text(one.root.querySelector('.callout-info')), /One key is taking all the turns/)

  reset()
  const fine = open()
  await settle()
  assert.equal(fine.root.querySelector('.callout'), null)
  assert.equal(byText(document, 'button', 'Add a key').disabled, false)
})

test('a failed load shows the error and Try again loads again', async () => {
  let n = 0
  const { root, api } = open({ routes: { 'GET /api/admin/kie-keys': () => { if (++n === 1) throw apiError('Down.', 503, 'X'); return data() } } })
  await settle()
  assert.match(text(root), /Down\./)
  click(byText(root, 'button', 'Try again'))
  await settle()
  assert.equal(all(root, 'tbody tr').length, 3)
  assert.equal(api.of('GET', '/api/admin/kie-keys').length, 2)
})

// ── The switch ───────────────────────────────────────────────────────────────

test('pausing a key while others take turns asks nothing and sends the change; resuming is the same', async () => {
  const { root, api } = open()
  await settle()
  click(rowFor(root, 'Account 1').querySelector('[role=switch]'))
  await settle()
  assert.equal(dialog(), null)
  assert.deepEqual(calls(api, '/update')[0].input, { id: ID(1), enabled: false })
  assert.match(text(document.querySelector('.toast-success')), /Account 1 is paused/)
  assert.equal(api.of('GET', '/api/admin/kie-keys').length, 2, 'the list reloaded')
})

test('pausing the ONLY key that takes turns asks first; no sends nothing, yes sends it', async () => {
  const payload = data({ keys: [own({ state: 'paused', enabled: false }), key(1)] })
  const { root, api } = open({ payload })
  await settle()
  click(rowFor(root, 'Account 1').querySelector('[role=switch]'))
  await settle()
  assert.match(text(dialog()), /Pause Account 1\?/)
  assert.match(text(dialog()), /every new generation is refused/)
  assert.equal(calls(api, '/update').length, 0)
  click(dialog().querySelector('button[type=button]'))
  await settle()
  assert.equal(calls(api, '/update').length, 0, 'declined: nothing sent')
  assert.equal(rowFor(root, 'Account 1').querySelector('[role=switch]').getAttribute('aria-checked'), 'true', 'and the switch stays on')
  assert.equal(document.querySelector('.toast-error'), null)

  click(rowFor(root, 'Account 1').querySelector('[role=switch]'))
  await settle()
  submit(dialog().querySelector('form'))
  await settle()
  assert.deepEqual(calls(api, '/update')[0].input, { id: ID(1), enabled: false })
})

test('a refused change is reported and the switch goes back', async () => {
  const { root } = open({ routes: { 'POST /api/admin/kie-keys/update': () => { throw apiError('Not now.', 500, 'X') } } })
  await settle()
  const sw = rowFor(root, 'Account 1').querySelector('[role=switch]')
  click(sw)
  await settle()
  assert.match(text(document.querySelector('.toast-error')), /Could not change the key/)
  assert.equal(sw.getAttribute('aria-checked'), 'true')
})

// ── Add ──────────────────────────────────────────────────────────────────────

async function openAdd() {
  const view = open()
  await settle()
  click(byText(document, 'button', 'Add a key'))
  await settle()
  return view
}

test('the add form hides what is typed, explains mistakes next to the field and sends nothing until they are fixed', async () => {
  const { api } = await openAdd()
  assert.equal(fieldIn('API key').type, 'password')
  assert.equal(fieldIn('Webhook key').type, 'password')
  assert.equal(fieldIn('API key').getAttribute('autocomplete'), 'off')
  submit(dialog().querySelector('form'))
  await settle()
  assert.equal(calls(api, '/add').length, 0)
  assert.match(text(dialog()), /Give the key a name/)
  assert.match(text(dialog()), /Paste the API key/)
  assert.match(text(dialog().querySelector('.form-error')), /Fix the highlighted fields/)
  assert.ok(dialog(), 'the dialog stays open')
})

test('a good key is sent once, with the choice to check it first, and the list reloads', async () => {
  const { api } = await openAdd()
  type(fieldIn('Name'), ' KIE account 2 ')
  type(fieldIn('API key'), GOOD_KEY)
  submit(dialog().querySelector('form'))
  await settle()
  assert.deepEqual(calls(api, '/add').map(c => c.input), [{ label: 'KIE account 2', key: GOOD_KEY, verify: true }])
  assert.equal(dialog(), null)
  assert.match(text(document.querySelector('.toast-success')), /Added KIE account 2/)
  assert.equal(api.of('GET', '/api/admin/kie-keys').length, 2)
  assert.doesNotMatch(document.body.innerHTML, new RegExp(GOOD_KEY), 'the key is nowhere on the page afterwards')
})

test('a webhook key is sent when given, and the check can be switched off', async () => {
  const { api } = await openAdd()
  type(fieldIn('Name'), 'B')
  type(fieldIn('API key'), GOOD_KEY)
  type(fieldIn('Webhook key'), 'b-hook-secret')
  const verify = all(dialog(), 'input[type=checkbox]')[0]
  verify.checked = false
  submit(dialog().querySelector('form'))
  await settle()
  assert.deepEqual(calls(api, '/add')[0].input, { label: 'B', key: GOOD_KEY, webhookSecret: 'b-hook-secret', verify: false })
})

test('when the server refuses the key its reason is shown in the dialog, which stays open for another try', async () => {
  const { api } = await openAdd()
  api.routes['POST /api/admin/kie-keys/add'] = () => { throw apiError('KIE does not accept this key. Check that it was copied whole.', 422, 'KEY_REJECTED') }
  type(fieldIn('Name'), 'B')
  type(fieldIn('API key'), GOOD_KEY)
  submit(dialog().querySelector('form'))
  await settle()
  assert.match(text(dialog().querySelector('.form-error')), /KIE does not accept this key/)
  assert.ok(dialog())
  assert.equal(document.querySelector('.toast-success'), null)
})

// ── Edit, check, remove ──────────────────────────────────────────────────────

test('renaming sends only the name; nothing is sent when nothing changed', async () => {
  const { root, api } = open()
  await settle()
  click(byText(rowFor(root, 'Account 1'), 'button', 'Edit'))
  await settle()
  submit(dialog().querySelector('form'))
  await settle()
  assert.equal(calls(api, '/update').length, 0)
  assert.equal(dialog(), null)

  click(byText(rowFor(root, 'Account 1'), 'button', 'Edit'))
  await settle()
  type(fieldIn('Name'), 'Account 1 (spare)')
  submit(dialog().querySelector('form'))
  await settle()
  assert.deepEqual(calls(api, '/update')[0].input, { id: ID(1), label: 'Account 1 (spare)' })
  assert.match(text(document.querySelector('.toast-success')), /Saved/)
})

test('a webhook key can be set, or the stored one removed; the server\'s own key has no such field', async () => {
  const { root, api } = open()
  await settle()
  click(byText(rowFor(root, 'Account 2'), 'button', 'Edit'))
  await settle()
  assert.equal(all(dialog(), 'input[type=checkbox]').length, 0, 'nothing stored, so nothing to remove')
  type(fieldIn('Webhook key'), 'short')
  submit(dialog().querySelector('form'))
  await settle()
  assert.match(text(dialog().querySelector('.form-error')), /8 to 256/)
  assert.equal(calls(api, '/update').length, 0)
  type(fieldIn('Webhook key'), 'account-2-hook')
  submit(dialog().querySelector('form'))
  await settle()
  assert.deepEqual(calls(api, '/update')[0].input, { id: ID(2), webhookSecret: 'account-2-hook' })

  click(byText(rowFor(root, 'Account 1'), 'button', 'Edit'))
  await settle()
  all(dialog(), 'input[type=checkbox]')[0].checked = true
  submit(dialog().querySelector('form'))
  await settle()
  assert.deepEqual(calls(api, '/update')[1].input, { id: ID(1), webhookSecret: null })

  click(byText(rowFor(root, 'Server key (.env)'), 'button', 'Edit'))
  await settle()
  assert.match(text(dialog()), /KIE_WEBHOOK_SECRET/)
  assert.equal(all(dialog(), 'input').length, 1, 'only the name')
})

test('Check reports what KIE said, and a key KIE no longer accepts as an error', async () => {
  const { root, api } = open()
  await settle()
  click(byText(rowFor(root, 'Account 1'), 'button', 'Check'))
  await settle()
  assert.deepEqual(calls(api, '/check')[0].input, { id: ID(1) })
  assert.match(text(document.querySelector('.toast-success')), /Account 1: KIE accepts it, 4,200 credits left/)

  api.routes['POST /api/admin/kie-keys/check'] = { result: 'rejected', key: key(1, { state: 'cooling', problem: 'rejected' }) }
  click(byText(rowFor(root, 'Account 1'), 'button', 'Check'))
  await settle()
  assert.match(text(document.querySelector('.toast-error')), /KIE does not accept this key/)

  api.routes['POST /api/admin/kie-keys/check'] = () => { throw apiError('KIE could not be reached to check this key. Please try again.', 502, 'KIE_UNREACHABLE') }
  click(byText(rowFor(root, 'Account 1'), 'button', 'Check'))
  await settle()
  assert.match(text(all(document, '.toast-error').at(-1)), /Could not check the key/)
})

test('removing asks first and says what it means; yes deletes, no does not; a refusal is reported', async () => {
  const { root, api } = open()
  await settle()
  click(byText(rowFor(root, 'Account 1'), 'button', 'Remove'))
  await settle()
  assert.match(text(dialog()), /Remove Account 1\?/)
  assert.match(text(dialog()), /added again/)
  click(dialog().querySelector('button[type=button]'))
  await settle()
  assert.equal(calls(api, '/delete').length, 0)

  api.routes['POST /api/admin/kie-keys/delete'] = () => { throw apiError('1 generation is still running with this key. Pause it, and remove it once they have finished.', 409, 'KEY_IN_USE') }
  click(byText(rowFor(root, 'Account 1'), 'button', 'Remove'))
  await settle()
  submit(dialog().querySelector('form'))
  await settle()
  assert.deepEqual(calls(api, '/delete')[0].input, { id: ID(1) })
  assert.match(text(document.querySelector('.toast-error')), /Could not remove the key/)

  api.routes['POST /api/admin/kie-keys/delete'] = { ok: true }
  click(byText(rowFor(root, 'Account 1'), 'button', 'Remove'))
  await settle()
  submit(dialog().querySelector('form'))
  await settle()
  assert.match(text(all(document, '.toast-success').at(-1)), /Removed Account 1/)
})
