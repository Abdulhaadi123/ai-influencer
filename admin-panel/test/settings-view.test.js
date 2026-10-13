// The settings page: how the server is set up, read-only. What it tells an admin
// must match what the server reports, and it must not offer to change any of it.

import test, { beforeEach } from 'node:test'
import assert from './assert.js'

import { installDom, reset, click, settle, text, all, byText, fakeApi, viewContext, apiError, config } from './helpers.js'

installDom()
const { renderSettings } = await import('../views/settings.js')

beforeEach(reset)

function open(cfg = config(), routes = {}) {
  const api = fakeApi({ 'GET /api/admin/config': () => cfg, ...routes })
  const { ctx } = viewContext(api, { view: 'settings', id: null, query: {} })
  document.body.append(ctx.container)
  const controller = renderSettings(ctx)
  return { api, controller, root: ctx.container }
}

const settingRow = (root, label) => all(root, '.setting').find(r => r.querySelector('.setting-name').textContent.includes(label))
const valueOf = (root, label) => text(settingRow(root, label).querySelector('.setting-value'))
const badgeOf = (root, label) => settingRow(root, label).querySelector('.setting-value .badge')

test('a healthy server: every check says yes, in green, with no warning above it', async () => {
  const { root } = open()
  await settle()
  assert.equal(root.querySelectorAll('.callout').length, 0)
  for (const label of ['Checking content', 'Checker key configured', 'Suspend at once for minors', 'Generation callbacks', 'nsfw_checker']) {
    assert.equal(valueOf(root, label), 'Yes', label)
    assert.ok(badgeOf(root, label).classList.contains('badge-success'), label)
  }
})

test('the numbers come from the server: model, strikes and window, frames per video', async () => {
  const { root } = open(config({ moderation: { model: 'omni-test', strikeLimit: 7, strikeWindowDays: 14, videoFrames: 6 } }))
  await settle()
  assert.equal(valueOf(root, 'Model'), 'omni-test')
  assert.equal(valueOf(root, 'Strikes before suspension'), '7 within 14 days')
  assert.equal(valueOf(root, 'Frames checked per video'), '6')
})

test('each setting names the environment variable that controls it', async () => {
  const { root } = open()
  await settle()
  const t = text(root)
  for (const name of ['OPENAI_API_KEY', 'MODERATION_FAIL_MODE', 'MODERATION_STRIKE_LIMIT', 'MODERATION_STRIKE_WINDOW_DAYS', 'MODERATION_SUSPEND_ON_MINORS', 'MODERATION_VIDEO_FRAMES', 'KIE_WEBHOOK_SECRET', 'PUBLIC_BASE_URL', 'KIE_NSFW_CHECKER']) {
    assert.match(t, new RegExp(name), name)
  }
})

test('the fail mode is described in plain words: closed is calm, open is a warning', async () => {
  const closed = open(config({ moderation: { failMode: 'closed' } }))
  await settle()
  assert.equal(valueOf(closed.root, 'When the checker is down'), 'Refuse the request')
  assert.ok(badgeOf(closed.root, 'When the checker is down').classList.contains('badge-success'))
  assert.match(text(settingRow(closed.root, 'When the checker is down')), /never withheld/)

  reset()
  const fail = open(config({ moderation: { failMode: 'open' } }))
  await settle()
  assert.equal(valueOf(fail.root, 'When the checker is down'), 'Let it through')
  assert.ok(badgeOf(fail.root, 'When the checker is down').classList.contains('badge-warning'))
})

test('moderation switched off on purpose says which setting did it', async () => {
  const { root } = open(config({ moderation: { enabled: false, checkerConfigured: true } }))
  await settle()
  const callout = root.querySelector('.callout-danger')
  assert.match(text(callout), /Content moderation is off/)
  assert.match(text(callout), /MODERATION_ENABLED=false/)
  assert.equal(valueOf(root, 'Checking content'), 'No')
  assert.ok(badgeOf(root, 'Checking content').classList.contains('badge-danger'))
})

test('moderation off because there is no key says that instead', async () => {
  const { root } = open(config({ moderation: { enabled: false, checkerConfigured: false } }))
  await settle()
  assert.match(text(root.querySelector('.callout-danger')), /no OPENAI_API_KEY/i)
  assert.equal(valueOf(root, 'Checker key configured'), 'No')
})

test('an invalid thresholds setting is called out with the reason and the fallback', async () => {
  const { root } = open(config({ moderation: { thresholdsProblem: 'MODERATION_THRESHOLDS is not valid JSON.' } }))
  await settle()
  const callout = root.querySelector('.callout-warning')
  assert.match(text(callout), /MODERATION_THRESHOLDS is invalid/)
  assert.match(text(callout), /not valid JSON/)
  assert.match(text(callout), /default thresholds are in use/)
})

test('the thresholds table lists every category with its two lines, "ignored" where there are none, and marks minors as always on', async () => {
  const { root } = open()
  await settle()
  const rows = all(root, 'table[aria-label="Moderation thresholds"] tbody tr')
  assert.equal(rows.length, 4)
  const byLabel = label => rows.find(r => r.textContent.includes(label))
  const cells = r => [...r.querySelectorAll('td')].map(c => text(c))

  assert.deepEqual(cells(byLabel('Sexual content') && rows[0]), ['Sexual content', '0.5', '0.85'])
  const minors = rows.find(r => r.textContent.includes('involving minors'))
  assert.match(text(minors), /Always on/)
  assert.deepEqual(cells(minors).slice(1), ['—', '0.1'], 'no review line: a dash, never "undefined"')
  const violence = rows.find(r => r.textContent.includes('Violence'))
  assert.deepEqual(cells(violence).slice(1), ['0.8', '—'])
  const harassment = rows.find(r => r.textContent.includes('Harassment'))
  assert.deepEqual(cells(harassment).slice(1), ['Ignored', 'Ignored'])
})

test('with no thresholds the table is empty rather than broken', async () => {
  const { root } = open(config({ moderation: { thresholds: {} } }))
  await settle()
  assert.equal(all(root, 'table[aria-label="Moderation thresholds"] tbody tr').length, 0)
  const nulls = open(config({ moderation: { thresholds: null } }))
  await settle()
  assert.ok(nulls.root.querySelector('table'))
})

test('generation callbacks off, and KIE\'s own filter off, are shown as No in red', async () => {
  const { root } = open(config({ kie: { callbacksConfigured: false, nsfwChecker: false } }))
  await settle()
  assert.equal(valueOf(root, 'Generation callbacks'), 'No')
  assert.ok(badgeOf(root, 'Generation callbacks').classList.contains('badge-danger'))
  assert.equal(valueOf(root, 'nsfw_checker'), 'No')
  assert.match(text(settingRow(root, 'Generation callbacks')), /within a minute or so/)
})

test('it is read-only: nothing on the page can change anything', async () => {
  const { root, api } = open()
  await settle()
  assert.equal(root.querySelectorAll('input, select, textarea, form').length, 0)
  assert.equal(all(root, 'button').length, 0)
  assert.match(text(root), /Read-only/)
  assert.equal(api.calls.filter(c => c.method !== 'GET').length, 0)
})

test('a failed load shows the error and Try again loads again', async () => {
  let n = 0
  const { root, api } = open(config(), { 'GET /api/admin/config': () => { if (++n === 1) throw apiError('Forbidden.', 403, 'NOT_ADMIN'); return config() } })
  await settle()
  assert.match(text(root), /Forbidden\./)
  click(byText(root, 'button', 'Try again'))
  await settle()
  assert.ok(settingRow(root, 'Checking content'))
  assert.equal(api.of('GET', '/api/admin/config').length, 2)
})

test('hostile text from the server stays text', async () => {
  const evil = '<img src=x onerror=1>'
  const { root } = open(config({ moderation: { model: evil, thresholdsProblem: evil, thresholds: { [evil]: { review: 0.1 } } } }))
  await settle()
  assert.equal(root.querySelectorAll('img').length, 0)
})

// ── Credits ──────────────────────────────────────────────────────────────────

test('the credits card says whether anything is being charged, whether purchases can reach us, and whether test purchases count', async () => {
  const { root } = open()
  await settle()
  assert.equal(valueOf(root, 'Charging for generations'), 'Off: watching only')
  assert.ok(badgeOf(root, 'Charging for generations').classList.contains('badge-warning'), 'off is a state to notice, not a failure')
  assert.equal(valueOf(root, 'Purchases can be credited'), 'Yes')
  assert.equal(valueOf(root, 'Test purchases are credited'), 'Yes')
  assert.ok(badgeOf(root, 'Test purchases are credited').classList.contains('badge-warning'), 'fine while testing, to be switched off at launch')
  const t = text(root)
  for (const name of ['BILLING_ENFORCED', 'REVENUECAT_WEBHOOK_AUTH', 'REVENUECAT_ACCEPT_SANDBOX']) assert.match(t, new RegExp(name), name)
})

test('charging on, test purchases off: both read as settled', async () => {
  const { root } = open(config({ billing: { enforced: true, acceptSandbox: false } }))
  await settle()
  assert.equal(valueOf(root, 'Charging for generations'), 'On')
  assert.ok(badgeOf(root, 'Charging for generations').classList.contains('badge-success'))
  assert.equal(valueOf(root, 'Test purchases are credited'), 'No')
  assert.ok(badgeOf(root, 'Test purchases are credited').classList.contains('badge-success'))
  assert.equal(root.querySelectorAll('.callout').length, 0)
})

test('charging without a way for purchases to arrive is the one dangerous combination, and is said loudly', async () => {
  const { root } = open(config({ billing: { enforced: true, webhookConfigured: false } }))
  await settle()
  const callout = root.querySelector('.callout')
  assert.ok(callout, 'a warning above the cards')
  assert.match(text(callout), /Credits are charged but purchases cannot be credited/)
  assert.equal(valueOf(root, 'Purchases can be credited'), 'No')

  // Not charging yet, and no webhook: nothing is wrong, so nothing is shouted.
  const quiet = open(config({ billing: { enforced: false, webhookConfigured: false } }))
  await settle()
  assert.equal(quiet.root.querySelectorAll('.callout').length, 0)
})

test('a server too old to report billing still shows the rest of the page', async () => {
  const { enforced: _a, ...rest } = config()
  const { billing: _drop, ...withoutBilling } = { ...rest }
  const { root } = open(withoutBilling)
  await settle()
  assert.ok(settingRow(root, 'Checking content'))
  assert.equal(settingRow(root, 'Charging for generations'), undefined)
})
