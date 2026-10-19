// The credits page: what people bought and spent, what they hold, what KIE charged — and, below,
// every change to every balance and every message the store sent us. What it asks for, what it
// says, and that "someone paid and got nothing" cannot hide.

import test, { beforeEach, mock } from 'node:test'
import assert from './assert.js'

import {
  installDom, reset, click, type, change, settle, microtasks, text, all, byText, fakeApi, viewContext, apiError, creditsSummary, ID,
} from './helpers.js'

installDom()
const { renderCredits, outcomeTone, PERIODS } = await import('../views/credits.js')
const { parseRoute } = await import('../lib/router.js')

beforeEach(reset)

const recent = seconds => new Date(Date.now() - seconds * 1000).toISOString()
const dayAgo = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

const entry = (n, over = {}) => ({
  id: String(n), userId: ID(n), email: `user${n}@test.example`, kind: 'purchase', delta: 500, note: 'credits_500', model: null, taskId: null, by: null, createdAt: recent(300 * n), ...over,
})
const activity = (entries, extra = {}) => ({ entries, total: entries.length, page: 1, pageSize: 25, ...extra })

const delivery = (n, over = {}) => ({
  id: `evt-${n}`, type: 'NON_RENEWING_PURCHASE', productId: 'credits_500', environment: 'SANDBOX', transactionId: `GPA.${n}`, outcome: 'credited',
  credits: 500, problem: false, userId: ID(n), email: `user${n}@test.example`, receivedAt: recent(300 * n), ...over,
})
const deliveries = (events, extra = {}) => ({ events, total: events.length, page: 1, pageSize: 25, ...extra })

async function open({ hash = '#/credits', summary = creditsSummary(), act = activity([entry(1), entry(2, { kind: 'spend', delta: -18, note: 'Generation', model: 'nano-banana-pro' })]), store = deliveries([delivery(1)]), problems = 0, routes = {} } = {}) {
  const api = fakeApi({
    'GET /api/admin/billing/summary': () => summary,
    'GET /api/admin/billing/activity': () => act,
    'GET /api/admin/billing/store-events': input => (input?.pageSize === 1 && input?.problems === 1 ? { events: [], total: problems, page: 1, pageSize: 1 } : store),
    ...routes,
  })
  const { ctx, navigations } = viewContext(api, parseRoute(hash))
  document.body.append(ctx.container)
  const controller = renderCredits(ctx)
  await settle()
  return { api, ctx, navigations, controller, root: ctx.container }
}

const tile = (root, label) => all(root, '.kpi').find(k => k.querySelector('.kpi-label')?.textContent === label)
const select = (root, label) => root.querySelector(`select[aria-label="${label}"]`)
const lastQuery = (api, path) => api.of('GET', path).at(-1).input

// ── What it asks for ────────────────────────────────────────────────────────

test('it asks for the summary of the period, how many deliveries need a look, and the first page of activity', async () => {
  const { api } = await open({ hash: '#/credits?days=7' })
  assert.deepEqual(api.of('GET', '/api/admin/billing/summary')[0].input, { days: 7 })
  assert.deepEqual(api.of('GET', '/api/admin/billing/store-events')[0].input, { problems: 1, pageSize: 1 })
  assert.deepEqual(lastQuery(api, '/api/admin/billing/activity'), { kind: '', q: '', userId: '', page: 1, pageSize: 25 })
  assert.equal(api.of('GET', '/api/admin/billing/activity').length, 1)
})

test('the period comes from the address: 7, 30 or 90 days; anything else is 30', async () => {
  assert.deepEqual(PERIODS, [7, 30, 90])
  for (const [hash, days] of [['#/credits?days=7', 7], ['#/credits?days=90', 90], ['#/credits?days=14', 30], ['#/credits?days=abc', 30], ['#/credits', 30]]) {
    reset()
    const { api, root } = await open({ hash })
    assert.deepEqual(api.of('GET', '/api/admin/billing/summary')[0].input, { days }, hash)
    assert.equal(byText(root, '[role=radio]', `${days} days`).getAttribute('aria-checked'), 'true', hash)
  }
})

test('nonsense in the address is ignored, not sent', async () => {
  const { api } = await open({ hash: '#/credits?tab=hacked&kind=hacked&outcome=x&page=-4&pageSize=7' })
  assert.deepEqual(lastQuery(api, '/api/admin/billing/activity'), { kind: '', q: '', userId: '', page: 1, pageSize: 25 })
})

// ── The figures ─────────────────────────────────────────────────────────────

test('the four figures: bought, spent, held and what KIE charged — each explained, with the numbers behind it', async () => {
  const { root } = await open({
    summary: creditsSummary({
      enforced: true, providerCost: 708,
      window: { purchased: 5500, purchases: 5, purchasers: 4, spent: 726, refunded: 18, clawedBack: 500 },
      holding: { held: 4660, holders: 4, owed: 236, owing: 2 },
    }),
  })
  const bought = tile(root, 'Credits bought')
  assert.equal(text(bought.querySelector('.kpi-value')), '5,500 credits')
  assert.match(text(bought), /5 purchases by 4 people/)
  assert.match(text(bought), /500 taken back after refunds/)

  const spent = tile(root, 'Credits spent')
  assert.equal(text(spent.querySelector('.kpi-value')), '726 credits')
  assert.match(text(spent), /18 given back for failed generations/)

  const held = tile(root, 'Held by people')
  assert.equal(text(held.querySelector('.kpi-value')), '4,660 credits')
  assert.match(text(held), /4 accounts hold credits · 236 owed by 2 accounts/)

  const kie = tile(root, 'KIE charged us')
  assert.equal(text(kie.querySelector('.kpi-value')), '708 KIE credits')
  assert.match(text(kie), /For the same period/)

  for (const label of ['Credits bought', 'Credits spent', 'Held by people', 'KIE charged us']) {
    assert.ok(tile(root, label).querySelector('.tip').getAttribute('title').length > 30, `${label} says what it counts`)
  }
})

test('singular and plural in the hints', async () => {
  const { root } = await open({ summary: creditsSummary({ window: { purchases: 1, purchasers: 1, refunded: 0, clawedBack: 0 }, holding: { held: 10, holders: 1, owed: 0, owing: 0 } }) })
  assert.match(text(tile(root, 'Credits bought')), /1 purchase by 1 person/)
  assert.match(text(tile(root, 'Credits spent')), /None given back/)
  assert.match(text(tile(root, 'Held by people')), /1 account hold credits/)
})

test('while charging is off a banner says generations are free for now; once it is on the banner is gone', async () => {
  const off = await open({ summary: creditsSummary({ enforced: false }) })
  const banner = off.root.querySelector('.callout-warning')
  assert.match(text(banner), /Charging is off — generations are free for now/)
  assert.match(text(banner), /BILLING_ENFORCED=true/)

  reset()
  const on = await open({ summary: creditsSummary({ enforced: true }) })
  assert.equal(on.root.querySelector('.callout-warning'), null)
})

// ── The chart and the packs ─────────────────────────────────────────────────

test('the chart has a column per day with a pair of bars, a legend, and the hover text says what that day bought and spent', async () => {
  const series = [{ day: dayAgo(1), purchased: 1500, spent: 40 }, { day: dayAgo(0), purchased: 0, spent: 118 }]
  const { root } = await open({ hash: '#/credits?days=7', summary: creditsSummary({ series }) })
  const svg = root.querySelector('svg.chart-svg')
  assert.equal(svg.querySelectorAll('g.chart-col').length, 7, 'a gap day is a zero, not a missing column')
  const titles = all(svg, 'title').map(t => t.textContent)
  assert.ok(titles.includes(`${dayAgo(1)}: 1,500 bought · 40 spent`))
  assert.ok(titles.includes(`${dayAgo(0)}: 0 bought · 118 spent`))
  assert.equal(svg.querySelectorAll('rect.chart-bar').length, 1, 'one day bought something')
  assert.equal(svg.querySelectorAll('rect.chart-bar-2').length, 2, 'two days spent something')
  assert.match(text(root.querySelector('.chart-legend')), /Credits bought/)
  assert.match(text(root.querySelector('.chart-legend')), /Credits spent/)
  assert.ok(root.querySelector('.legend-swatch-2'), 'the second colour is named too')
})

test('with nothing bought or spent the chart says so instead of drawing an empty one', async () => {
  const { root } = await open({ summary: creditsSummary({ window: { purchased: 0, spent: 0 } }) })
  assert.equal(root.querySelector('svg.chart-svg'), null)
  assert.match(text(root), /Nothing was bought or spent in this period/)
})

test('packs sold: the pack with its id, where it was bought (live or test), how many and how many credits', async () => {
  const packs = [
    { productId: 'credits_1500', label: '1,500 credits', environment: 'PRODUCTION', purchases: 2, credits: 3000 },
    { productId: 'credits_500', label: null, environment: 'SANDBOX', purchases: 1, credits: 500 },
  ]
  const { root } = await open({ summary: creditsSummary({ packs }) })
  const rows = all(byText(root, '.card', 'Packs sold'), 'tbody tr')
  assert.equal(rows.length, 2)
  assert.match(text(rows[0]), /1,500 credits/)
  assert.match(text(rows[0]), /credits_1500/)
  assert.match(text(rows[0]), /Live/)
  assert.ok(rows[0].querySelector('.badge-success'))
  assert.equal(rows[0].querySelector('.badge').title, 'Paid with real money')
  assert.match(text(rows[1]), /credits_500/)
  assert.match(text(rows[1]), /Test/)
  assert.ok(rows[1].querySelector('.badge-warning'))
  assert.equal(rows[1].querySelector('.badge').title, 'A test purchase: nobody was charged')
  assert.deepEqual(all(rows[0], 'td').slice(1).map(c => text(c)), ['2', '3,000'])
})

test('no packs sold says so', async () => {
  const { root } = await open({ summary: creditsSummary({ packs: [] }) })
  assert.match(text(byText(root, '.card', 'Packs sold')), /No packs were sold in this period/)
})

// ── Activity ────────────────────────────────────────────────────────────────

test('activity: when, who (a link to the account), what happened in words, the credits with their sign, and the note', async () => {
  const { root } = await open({
    act: activity([
      entry(1, { kind: 'purchase', delta: 500, note: 'credits_500 (test purchase)' }),
      entry(2, { kind: 'spend', delta: -18, note: 'Generation', model: 'nano-banana-pro' }),
      entry(3, { kind: 'grant', delta: 50, note: 'support goodwill', by: 'boss@test.example' }),
      entry(4, { kind: 'clawback', delta: -500, note: 'Refunded purchase GPA.4' }),
      entry(5, { kind: 'refund', delta: 18, note: 'Generation failed', model: 'nano-banana-pro' }),
      entry(6, { kind: 'adjust', delta: -10, note: null, by: 'boss@test.example' }),
    ]),
  })
  const rows = all(root, 'tbody tr')
  assert.equal(rows.length, 6)
  assert.match(text(rows[0]), /5 min ago/)
  assert.equal(rows[0].querySelector('a.link').getAttribute('href'), `#/users/${ID(1)}`)
  assert.equal(text(rows[0].querySelector('a.link')), 'user1@test.example')

  const what = i => text(rows[i].querySelector('.cell-main'))
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(what), [
    'Bought a pack', 'Used for a generation', 'Given by an admin', 'Taken back (purchase refunded)', 'Given back (generation failed)', 'Corrected by an admin',
  ])
  assert.equal(text(rows[1].querySelector('.cell-sub')), 'nano-banana-pro', 'the model under a spend')

  const delta = i => rows[i].querySelector('.delta')
  assert.equal(text(delta(0)), '+500')
  assert.ok(delta(0).classList.contains('delta-up'))
  assert.equal(text(delta(1)), '−18', 'a real minus sign')
  assert.ok(delta(1).classList.contains('delta-down'))
  assert.equal(text(delta(4)), '+18')

  assert.match(text(rows[2]), /support goodwill · by boss@test\.example/)
  assert.match(text(rows[5]), /by boss@test\.example/)
  assert.doesNotMatch(text(rows[5]), /null|undefined/)
})

test('activity: filtering by kind goes to page 1 with that filter; "every kind" removes it', async () => {
  const { root, navigations } = await open({ hash: '#/credits?page=3&q=a' })
  change(select(root, 'Kind'), 'spend')
  assert.equal(navigations.at(-1), '#/credits?q=a&kind=spend')
  assert.deepEqual(all(select(root, 'Kind'), 'option').map(o => o.value), ['', 'purchase', 'spend', 'refund', 'grant', 'adjust', 'clawback'])

  reset()
  const withKind = await open({ hash: '#/credits?kind=spend' })
  assert.equal(select(withKind.root, 'Kind').value, 'spend')
  change(select(withKind.root, 'Kind'), '')
  assert.equal(withKind.navigations.at(-1), '#/credits')
})

test('activity: searching waits for a pause in typing and then filters from page 1', async () => {
  const { root, navigations } = await open({ hash: '#/credits?page=2' })
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const input = root.querySelector('input[type=search]')
    type(input, 'mi'); mock.timers.tick(200)
    type(input, ' mia ')
    mock.timers.tick(299)
    assert.deepEqual(navigations, [])
    mock.timers.tick(1)
    assert.deepEqual(navigations, ['#/credits?q=mia'])
  } finally { mock.timers.reset() }
  await microtasks()
})

test('activity narrowed to one account says so, and the chip removes just that filter', async () => {
  const { root, navigations, api } = await open({ hash: `#/credits?userId=${ID(1)}&kind=spend` })
  assert.equal(lastQuery(api, '/api/admin/billing/activity').userId, ID(1))
  const chip = root.querySelector('.chip')
  assert.match(text(chip), /One account/)
  click(chip.querySelector('button'))
  assert.equal(navigations.at(-1), '#/credits?kind=spend')

  reset()
  const none = await open()
  assert.equal(none.root.querySelector('.chip'), null)
})

test('activity: an empty list says why; a filtered one can be cleared in a click', async () => {
  const plain = await open({ act: activity([]) })
  assert.match(text(plain.root.querySelector('.empty')), /No credit activity yet/)
  assert.equal(plain.root.querySelector('.empty button'), null)

  reset()
  const filtered = await open({ hash: `#/credits?kind=spend&q=zz&userId=${ID(1)}&page=2`, act: activity([]) })
  assert.match(text(filtered.root.querySelector('.empty')), /Nothing matches/)
  click(filtered.root.querySelector('.empty button'))
  assert.equal(filtered.navigations.at(-1), '#/credits')
})

test('activity pages: the default size and page 1 stay out of the address', async () => {
  const many = Array.from({ length: 25 }, (_, i) => entry(i + 1))
  const { root, navigations } = await open({ hash: '#/credits?kind=spend', act: activity(many, { total: 80 }) })
  assert.match(text(root), /1–25 of 80/)
  click(root.querySelector('[aria-label="Next page"]'))
  assert.equal(navigations.at(-1), '#/credits?kind=spend&page=2')
  change(root.querySelector('select[aria-label="Rows per page"]'), '50')
  assert.equal(navigations.at(-1), '#/credits?kind=spend&pageSize=50')
})

// ── Store deliveries ────────────────────────────────────────────────────────

test('the Store deliveries tab carries the count of ones that need a look, in red; with none it carries no count', async () => {
  const bad = await open({ problems: 3 })
  const tab = byText(bad.root, '[role=tab]', 'Store deliveries')
  assert.equal(text(tab.querySelector('.tab-count')), '3')
  assert.ok(tab.querySelector('.tab-count-alert'))

  reset()
  const fine = await open({ problems: 0 })
  assert.equal(byText(fine.root, '[role=tab]', 'Store deliveries').querySelector('.tab-count'), null)
})

test('switching tab goes to the store list and drops the other tab\'s filters; going back to Activity leaves the address clean', async () => {
  const { root, navigations } = await open({ hash: '#/credits?kind=spend&q=a&page=2' })
  click(byText(root, '[role=tab]', 'Store deliveries'))
  assert.equal(navigations.at(-1), '#/credits?tab=store')

  reset()
  const store = await open({ hash: '#/credits?tab=store&outcome=credited' })
  click(byText(store.root, '[role=tab]', 'Activity'))
  assert.equal(store.navigations.at(-1), '#/credits')
})

test('each delivery: when, the product as the store sent it, test or live, the result in words and colour, the credits, the account', async () => {
  const events = [
    delivery(1, { outcome: 'credited', credits: 500 }),
    delivery(2, { outcome: 'clawed_back', credits: 1500, environment: 'PRODUCTION', productId: 'credits_1500' }),
    delivery(3, { outcome: 'unmatched', credits: null, problem: true, userId: null, email: null, productId: 'credits_5000' }),
    delivery(4, { outcome: 'ignored', credits: null, problem: true, productId: 'credits_500:base-plan' }),
    delivery(5, { outcome: 'sandbox_off', credits: null, problem: true }),
    delivery(6, { outcome: 'ignored', credits: null, problem: false, type: 'INITIAL_PURCHASE' }),
    delivery(7, { outcome: 'duplicate', credits: null }),
    delivery(8, { outcome: 'test', credits: null }),
  ]
  const { root } = await open({ hash: '#/credits?tab=store', store: deliveries(events) })
  const rows = all(root, 'tbody tr')
  assert.equal(rows.length, 8)
  const result = i => rows[i].querySelector('td:nth-child(4) .badge')

  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(i => text(result(i))), [
    'Credits added', 'Credits taken back', 'No matching account', 'Product not recognised', 'Test purchase refused', 'Not ours to act on', 'Duplicate, ignored', 'Test event',
  ])
  assert.ok(result(0).classList.contains('badge-success'))
  assert.ok(result(1).classList.contains('badge-warning'))
  assert.ok(result(2).classList.contains('badge-danger'), 'someone paid and nothing arrived: red')
  assert.ok(result(3).classList.contains('badge-danger'))
  assert.ok(result(4).classList.contains('badge-warning'), 'a test purchase while tests are off is a setting, not a loss')
  assert.ok(result(5).classList.contains('badge-neutral'), 'an event that is none of our business is a shrug')
  assert.match(result(2).title, /Someone paid and the credits did not arrive/)
  assert.equal(result(0).title, '')

  assert.equal(text(rows[3].querySelector('.mono')), 'credits_500:base-plan', 'the product id exactly as the store sent it')
  assert.match(text(rows[0]), /Test/)
  assert.match(text(rows[1]), /Live/)
  const credits = i => rows[i].querySelector('td:nth-child(5)')
  assert.equal(text(credits(0)), '+500')
  assert.equal(text(credits(1)), '−1,500', 'a clawback is a minus')
  assert.equal(text(credits(2)), '—')
  assert.equal(text(rows[2].querySelector('td:nth-child(6)')), 'No account')
  assert.equal(rows[0].querySelector('a.link').getAttribute('href'), `#/users/${ID(1)}`)
})

test('the store list asks for what the filters say: all, only the ones to look at, or one result', async () => {
  const { root, navigations, api } = await open({ hash: '#/credits?tab=store' })
  assert.deepEqual(lastQuery(api, '/api/admin/billing/store-events'), { outcome: '', problems: null, page: 1, pageSize: 25 })

  click(byText(root, '[role=radio]', 'Needs a look'))
  assert.equal(navigations.at(-1), '#/credits?tab=store&problems=1')
  change(select(root, 'Result'), 'unmatched')
  assert.equal(navigations.at(-1), '#/credits?tab=store&outcome=unmatched')
  assert.deepEqual(all(select(root, 'Result'), 'option').map(o => o.value), ['', 'credited', 'clawed_back', 'duplicate', 'ignored', 'unmatched', 'sandbox_off', 'test'])

  reset()
  const problems = await open({ hash: '#/credits?tab=store&problems=1&outcome=ignored' })
  assert.deepEqual(lastQuery(problems.api, '/api/admin/billing/store-events'), { outcome: 'ignored', problems: 1, page: 1, pageSize: 25 })
  assert.equal(byText(problems.root, '[role=radio]', 'Needs a look').getAttribute('aria-checked'), 'true')
  click(byText(problems.root, '[role=radio]', 'All deliveries'))
  assert.equal(problems.navigations.at(-1), '#/credits?tab=store&outcome=ignored')
})

test('an empty store list says why — and when nothing needs a look it says that is good news', async () => {
  const none = await open({ hash: '#/credits?tab=store', store: deliveries([]) })
  assert.match(text(none.root.querySelector('.empty')), /No store deliveries yet/)

  reset()
  const clean = await open({ hash: '#/credits?tab=store&problems=1', store: deliveries([]) })
  assert.match(text(clean.root.querySelector('.empty')), /Nothing needs a look/)
  assert.match(text(clean.root.querySelector('.empty')), /Every purchase the store told us about became credits/)
  click(clean.root.querySelector('.empty button'))
  assert.equal(clean.navigations.at(-1), '#/credits?tab=store')
})

test('outcomeTone: green when credits arrived, red when someone paid and they did not, amber for a refund or a setting', () => {
  assert.equal(outcomeTone('credited', false), 'success')
  assert.equal(outcomeTone('unmatched', true), 'danger')
  assert.equal(outcomeTone('ignored', true), 'danger')
  assert.equal(outcomeTone('sandbox_off', true), 'warning')
  assert.equal(outcomeTone('clawed_back', false), 'warning')
  assert.equal(outcomeTone('ignored', false), 'neutral')
  assert.equal(outcomeTone('duplicate', false), 'neutral')
})

// ── Moving about ────────────────────────────────────────────────────────────

test('update: a changed period reloads the summary only; a changed filter reloads the list only', async () => {
  const { api, controller } = await open()
  const summaries = () => api.of('GET', '/api/admin/billing/summary').length
  const lists = () => api.of('GET', '/api/admin/billing/activity').length
  assert.deepEqual([summaries(), lists()], [1, 1])

  controller.update(parseRoute('#/credits'))
  await settle()
  assert.deepEqual([summaries(), lists()], [1, 1], 'nothing changed, nothing asked')

  controller.update(parseRoute('#/credits?days=7'))
  await settle()
  assert.deepEqual([summaries(), lists()], [2, 1], 'the period is the summary\'s')

  controller.update(parseRoute('#/credits?days=7&kind=spend'))
  await settle()
  assert.deepEqual([summaries(), lists()], [2, 2], 'a filter is the list\'s')
})

test('a slow earlier answer never replaces a later one', async () => {
  let call = 0
  let releaseFirst
  const { root, controller } = await open({
    routes: {
      'GET /api/admin/billing/activity': () => (++call === 1 ? activity([entry(1)]) : call === 2 ? new Promise(r => { releaseFirst = () => r(activity([entry(8)])) }) : activity([entry(9)])),
    },
  })
  controller.update(parseRoute('#/credits?kind=spend'))
  controller.update(parseRoute('#/credits?kind=refund'))
  await settle()
  releaseFirst()
  await settle()
  assert.match(text(root), /user9@test\.example/)
  assert.doesNotMatch(text(root), /user8@test\.example/)
})

test('the search box follows the address when you are not typing in it', async () => {
  const { root, controller } = await open({ hash: '#/credits?q=one' })
  const input = root.querySelector('input[type=search]')
  assert.equal(input.value, 'one')
  controller.update(parseRoute('#/credits?q=two'))
  await settle()
  assert.equal(input.value, 'two')
})

test('destroy cancels what is in flight', async () => {
  const { api, controller } = await open()
  controller.destroy()
  assert.equal(api.of('GET', '/api/admin/billing/summary')[0].signal.aborted, true)
  assert.equal(api.of('GET', '/api/admin/billing/activity')[0].signal.aborted, true)
})

// ── Failing well ────────────────────────────────────────────────────────────

test('a failed list shows the error with Try again, which loads it again — and the summary above is unaffected', async () => {
  let n = 0
  const { root, api } = await open({ routes: { 'GET /api/admin/billing/activity': () => { if (++n === 1) throw apiError('Could not reach the server.', 0, 'NETWORK'); return activity([entry(1)]) } } })
  assert.match(text(root), /Could not reach the server/)
  assert.ok(tile(root, 'Credits bought'), 'the figures are still there')
  click(byText(root, 'button', 'Try again'))
  await settle()
  assert.equal(all(root, 'tbody tr').length, 1)
  assert.equal(api.of('GET', '/api/admin/billing/activity').length, 2)
})

test('a failed summary shows the error with Try again, and the list below still works', async () => {
  let n = 0
  const { root } = await open({ routes: { 'GET /api/admin/billing/summary': () => { if (++n === 1) throw apiError('Unable to load the credits summary.', 500, 'X'); return creditsSummary() } } })
  assert.match(text(root), /Unable to load the credits summary/)
  assert.equal(root.querySelector('.kpi-value'), null, 'no half-drawn figures')
  assert.equal(all(root, 'tbody tr').length, 2, 'the list is there')
  click(byText(root, 'button', 'Try again'))
  await settle()
  assert.ok(tile(root, 'Credits bought'))
})

test('nothing on the page changes anything: no POST is ever made', async () => {
  const { root, api } = await open()
  for (const b of all(root, 'tbody button')) click(b)
  await settle()
  assert.equal(api.calls.filter(c => c.method === 'POST').length, 0)
})

test('server text is text: hostile emails, notes, models and product ids build no elements', async () => {
  const evil = '<img src=x onerror=1>'
  const act = await open({ act: activity([entry(1, { email: evil, note: '<script>alert(1)</script>', model: '<b>m</b>', by: '<i>x</i>' })]) })
  assert.equal(act.root.querySelectorAll('tbody img, tbody script, tbody b, tbody i').length, 0)
  assert.match(text(act.root), /<script>alert\(1\)<\/script>/)

  reset()
  const store = await open({ hash: '#/credits?tab=store', store: deliveries([delivery(1, { productId: evil, transactionId: '<b>t</b>', email: evil })]) })
  assert.equal(store.root.querySelectorAll('tbody img, tbody b').length, 0)
})

test('a paid subscription that we ignored is red, says it is a subscription, and explains what happened', async () => {
  const events = [
    delivery(1, { type: 'INITIAL_PURCHASE', productId: 'basic_monthly:p1m', outcome: 'ignored', credits: null, problem: true }),
    delivery(2, { type: 'EXPIRATION', outcome: 'ignored', credits: null, problem: false }),
  ]
  const { root } = await open({ hash: '#/credits?tab=store', store: deliveries(events) })
  const rows = all(root, 'tbody tr')
  const badgeOf = i => rows[i].querySelector('td:nth-child(4) .badge')
  assert.equal(text(badgeOf(0)), 'Subscription, not supported')
  assert.ok(badgeOf(0).classList.contains('badge-danger'))
  assert.match(badgeOf(0).title, /We sell credit packs, not subscriptions/)
  assert.equal(text(badgeOf(1)), 'Not ours to act on')
  assert.ok(badgeOf(1).classList.contains('badge-neutral'))
})
