// The overview: "is anything on fire?" first, then the numbers. What it asks the
// server for, what it says back, and that a bad day looks different from a good one.

import test, { beforeEach } from 'node:test'
import assert from './assert.js'

import {
  installDom, reset, click, settle, text, all, byText, fakeApi, viewContext, apiError, stats, config, ID,
} from './helpers.js'

installDom()
const { renderOverview } = await import('../views/overview.js')
const { parseRoute } = await import('../lib/router.js')

beforeEach(reset)

const recent = seconds => new Date(Date.now() - seconds * 1000).toISOString()
const dayAgo = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

const usage = (rows = [
  { day: dayAgo(0), model: 'kling-3.0/video', credits: 120, succeeded: 4, failed: 1 },
  { day: dayAgo(1), model: 'kling-3.0/video', credits: 80, succeeded: 3, failed: 0 },
  { day: dayAgo(1), model: 'nano-banana-pro', credits: 10, succeeded: 5, failed: 0 },
]) => ({ days: 30, rows })

const auditPage = (entries = [{ id: 1, at: recent(120), admin: 'boss@test.example', action: 'user.suspend', targetType: 'user', targetId: ID(1), details: {} }]) => ({ entries, total: entries.length, page: 1, pageSize: 6 })

async function open({ hash = '#/overview', st = stats(), cfg = config(), use = usage(), audit = auditPage(), routes = {} } = {}) {
  const forced = []
  const api = fakeApi({
    'GET /api/admin/stats': () => st,
    'GET /api/admin/usage': () => use,
    'GET /api/admin/config': () => cfg,
    'GET /api/admin/audit': () => audit,
    ...routes,
  })
  const { ctx, navigations } = viewContext(api, parseRoute(hash), { onNavigate: (hash2, opts) => forced.push(opts) })
  document.body.append(ctx.container)
  await renderOverview(ctx)
  return { api, ctx, navigations, forced, root: ctx.container }
}

const tile = (root, label) => all(root, '.kpi').find(k => k.querySelector('.kpi-label')?.textContent === label)

test('it asks for the four things once each: stats, usage for the period, settings, and the last six audit entries', async () => {
  const { api } = await open()
  assert.equal(api.of('GET', '/api/admin/stats').length, 1)
  assert.deepEqual(api.of('GET', '/api/admin/usage')[0].input, { days: 30 })
  assert.equal(api.of('GET', '/api/admin/config').length, 1)
  assert.deepEqual(api.of('GET', '/api/admin/audit')[0].input, { pageSize: 6 })
})

test('the period comes from the address: 7, 30 or 90 days; anything else is 30', async () => {
  for (const [hash, days] of [['#/overview?days=7', 7], ['#/overview?days=90', 90], ['#/overview?days=30', 30], ['#/overview?days=14', 30], ['#/overview?days=abc', 30], ['#/overview', 30], ['#/overview?days=-7', 30]]) {
    reset()
    const { api, root } = await open({ hash })
    assert.deepEqual(api.of('GET', '/api/admin/usage')[0].input, { days }, hash)
    assert.equal(byText(root, '[role=radio]', `${days} days`).getAttribute('aria-checked'), 'true', hash)
  }
})

test('the tiles show the figures, with a link to where each one leads', async () => {
  const { root } = await open({ st: stats({ users: { total: 1234, suspended: 3, new_7d: 9 }, jobs: { running: 2, started24h: 40, failed24h: 4, credits24h: 12_345, credits7d: 80_000, credits30d: 1_200_000, chargeUnknown30d: 0 }, moderation: { open: 6, openBlocked: 2, events24h: 11 } }) })
  const accounts = tile(root, 'Accounts')
  assert.equal(text(accounts.querySelector('.kpi-value')), '1,234')
  assert.match(text(accounts), /9 new this week · 3 suspended/)
  assert.equal(accounts.getAttribute('href'), '#/users')

  assert.equal(text(tile(root, 'Running now').querySelector('.kpi-value')), '2')
  const started = tile(root, 'Started in 24 h')
  assert.equal(text(started.querySelector('.kpi-value')), '40')
  assert.match(text(started), /4 failed/)
  assert.ok(started.querySelector('.kpi-icon-warning'), 'failures colour the tile')

  const credits = tile(root, 'KIE credits · 24 h')
  assert.equal(text(credits.querySelector('.kpi-value')), '12.3K')
  assert.equal(credits.getAttribute('title'), '12,345 credits', 'the exact figure is one hover away')
  assert.match(text(credits), /80K in 7 days · 1\.2M in 30/)

  const review = tile(root, 'To review')
  assert.equal(text(review.querySelector('.kpi-value')), '6')
  assert.match(text(review), /11 events in 24 h/)
  assert.equal(review.getAttribute('href'), '#/moderation')
  assert.ok(review.querySelector('.kpi-icon-warning'))
})

test('a quiet day looks quiet: no warning colours on the tiles', async () => {
  const { root } = await open({ st: stats({ jobs: { running: 0, started24h: 3, failed24h: 0, credits24h: 5, credits7d: 5, credits30d: 5, chargeUnknown30d: 0 }, moderation: { open: 0, openBlocked: 0, events24h: 0 } }) })
  assert.equal(root.querySelectorAll('.kpi-icon-warning').length, 0)
})

test('with nothing wrong the top of the page says so', async () => {
  const { root } = await open({ st: stats({ moderation: { open: 0, openBlocked: 0, events24h: 0 }, unpricedModels: 0 }) })
  const section = root.querySelector('[aria-label="Needs attention"]')
  assert.equal(section.querySelectorAll('.attention-item').length, 1)
  assert.ok(section.querySelector('.attention-success'))
  assert.match(text(section), /Nothing needs attention/)
  assert.match(text(section), /All clear/)
  assert.equal(section.querySelector('a'), null, 'nothing to go and do')
})

test('things that need attention are listed first, each with a link to deal with it', async () => {
  const { root } = await open({
    st: stats({ moderation: { open: 3, openBlocked: 2, events24h: 5 }, unpricedModels: 2, jobs: { running: 0, started24h: 20, failed24h: 10, credits24h: 1, credits7d: 1, credits30d: 1, chargeUnknown30d: 0 } }),
    cfg: config({ moderation: { enabled: false, checkerConfigured: false } }),
  })
  const section = root.querySelector('[aria-label="Needs attention"]')
  const rows = all(section, '.attention-item')
  assert.ok(rows.length >= 4)
  assert.ok(section.querySelector('.attention-danger'))
  assert.match(text(rows[0]), /Content moderation is off/, 'the worst problem comes first')
  assert.match(text(section), new RegExp(`${rows.length} items`), 'the heading counts them')
  assert.equal(section.querySelectorAll('.callout').length, 0, 'one calm list, not a stack of boxes')
  assert.equal(byText(section, 'a', 'Review').getAttribute('href'), '#/moderation')
  assert.equal(byText(section, 'a', 'See failed jobs').getAttribute('href'), '#/jobs?state=fail')
  assert.equal(byText(section, 'a', 'Set prices').getAttribute('href'), '#/prices')
  assert.equal(byText(section, 'a', 'See settings').getAttribute('href'), '#/settings')
  assert.match(text(section), /50% of today's jobs failed/)
  assert.match(text(section), /2 models in use without a price/)
})

test('a note says when some finished jobs have no recorded charge, in the singular and the plural', async () => {
  const one = await open({ st: stats({ jobs: { running: 0, started24h: 1, failed24h: 0, credits24h: 1, credits7d: 1, credits30d: 1, chargeUnknown30d: 1 } }) })
  assert.match(text(one.root.querySelector('.note')), /1 finished job in the last 30 days has no recorded charge/)
  assert.match(text(one.root.querySelector('.note')), /leave it out/)

  reset()
  const many = await open({ st: stats({ jobs: { running: 0, started24h: 1, failed24h: 0, credits24h: 1, credits7d: 1, credits30d: 1, chargeUnknown30d: 4 } }) })
  assert.match(text(many.root.querySelector('.note')), /4 finished jobs in the last 30 days have no recorded charge/)
  assert.match(text(many.root.querySelector('.note')), /leave them out/)

  reset()
  const none = await open()
  assert.equal(none.root.querySelector('.note'), null)
})

test('the chart has one column per day of the period, and the hover text gives that day\'s exact numbers', async () => {
  const { root } = await open({ hash: '#/overview?days=7' })
  const svg = root.querySelector('svg.chart-svg')
  assert.equal(svg.querySelectorAll('g.chart-col').length, 7)
  assert.match(svg.getAttribute('aria-label'), /last 7 days/)
  const titles = all(svg, 'title').map(t => t.textContent)
  assert.ok(titles.some(t => t.startsWith(dayAgo(1)) && /90 credits · 8 succeeded · 0 failed/.test(t)), 'yesterday: 80 + 10 credits, 3 + 5 jobs')
  assert.ok(titles.some(t => t.startsWith(dayAgo(0)) && /120 credits · 4 succeeded · 1 failed/.test(t)))
  assert.equal(svg.querySelectorAll('rect.chart-bar').length, 2, 'only days with spend have a bar')
  assert.match(text(root), /Last 7 days \(UTC\) · 210 credits · 92% of jobs succeeded/)
})

test('rows older than the period are not counted', async () => {
  const { root } = await open({ hash: '#/overview?days=7', use: usage([
    { day: dayAgo(1), model: 'm', credits: 10, succeeded: 1, failed: 0 },
    { day: dayAgo(20), model: 'm', credits: 999, succeeded: 9, failed: 9 },
  ]) })
  assert.match(text(root), /10 credits/)
  assert.doesNotMatch(text(root), /999/)
})

test('with no finished jobs both panels say so instead of drawing an empty chart', async () => {
  const { root } = await open({ use: usage([]) })
  assert.equal(root.querySelector('svg.chart-svg'), null)
  assert.equal(all(root, '.muted').filter(e => e.textContent === 'No finished jobs in this period.').length, 2)
  assert.match(text(root), /0 credits · —/, 'a percentage of nothing is a dash, not NaN')
})

test('spend by model lists the biggest first, at most eight, with each model\'s outcome', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ day: dayAgo(0), model: `model-${i}`, credits: (i + 1) * 10, succeeded: i + 1, failed: i === 9 ? 2 : 0 }))
  const { root } = await open({ use: usage(rows) })
  const items = all(root, '.barlist-row')
  assert.equal(items.length, 8)
  assert.match(text(items[0]), /model-9/)
  assert.match(text(items[0]), /10 jobs succeeded · 2 failed/)
  assert.match(text(items[7]), /model-2/)
  assert.match(text(items[1]), /9 jobs succeeded/)
  assert.doesNotMatch(text(items[1]), /failed/, 'no "0 failed" clutter')
  assert.equal(items[0].querySelector('.barlist-fill').style.width, '100%')
})

test('a single job is "1 job", not "1 jobs"', async () => {
  const { root } = await open({ use: usage([{ day: dayAgo(0), model: 'solo', credits: 5, succeeded: 1, failed: 0 }]) })
  assert.match(text(root.querySelector('.barlist-row')), /1 job succeeded/)
})

test('recent admin activity lists who did what and when, and links to the whole log', async () => {
  const { root } = await open()
  const card = byText(root, '.card', 'Recent admin activity')
  const li = card.querySelector('.activity-item')
  assert.match(text(li), /boss@test\.example/)
  assert.match(text(li), /Suspended an account|Suspend/i)
  assert.match(text(li), /2 min ago/)
  assert.equal(byText(card, 'a', 'View all').getAttribute('href'), '#/audit')
})

test('with no activity it says nothing has been recorded', async () => {
  const { root } = await open({ audit: auditPage([]) })
  assert.match(text(byText(root, '.card', 'Recent admin activity')), /Nothing has been recorded yet/)
})

test('choosing another period navigates to it; 30 days is the default so it is not written; the chosen one does nothing', async () => {
  const { root, navigations } = await open()
  click(byText(root, '[role=radio]', '7 days'))
  assert.equal(navigations.at(-1), '#/overview?days=7')
  click(byText(root, '[role=radio]', '90 days'))
  assert.equal(navigations.at(-1), '#/overview?days=90')
  click(byText(root, '[role=radio]', '30 days'))
  assert.equal(navigations.length, 2, 'already on 30 days')

  reset()
  const on7 = await open({ hash: '#/overview?days=7' })
  click(byText(on7.root, '[role=radio]', '30 days'))
  assert.equal(on7.navigations.at(-1), '#/overview')
})

test('Refresh goes to the same page again and asks the shell to draw it afresh, keeping the period', async () => {
  const { root, navigations, forced } = await open({ hash: '#/overview?days=90' })
  click(byText(root, 'button', 'Refresh'))
  assert.equal(navigations.at(-1), '#/overview?days=90')
  assert.deepEqual(forced.at(-1), { force: true })

  reset()
  const plain = await open()
  click(byText(plain.root, 'button', 'Refresh'))
  assert.equal(plain.navigations.at(-1), '#/overview')
})

test('if any one of the four requests fails the page shows one error, and Try again repeats all of them', async () => {
  for (const failing of ['stats', 'usage', 'config', 'audit']) {
    reset()
    let n = 0
    const path = `GET /api/admin/${failing}`
    const { root, api } = await open({ routes: { [path]: () => { if (++n === 1) throw apiError(`${failing} is down.`, 503, 'X'); return ({ stats: stats(), usage: usage(), config: config(), audit: auditPage() })[failing] } } })
    assert.match(text(root), new RegExp(`${failing} is down`), failing)
    assert.equal(root.querySelectorAll('.kpi-value').length, 0, 'no half-drawn page')
    click(byText(root, 'button', 'Try again'))
    await settle()
    assert.ok(tile(root, 'Accounts'), `${failing}: recovered`)
    assert.equal(api.of('GET', '/api/admin/stats').length, 2, failing)
  }
})

test('a view that has been left draws nothing when its answers arrive', async () => {
  const controller = new AbortController()
  const api = fakeApi({ 'GET /api/admin/stats': () => stats(), 'GET /api/admin/usage': () => usage(), 'GET /api/admin/config': () => config(), 'GET /api/admin/audit': () => auditPage() })
  const { ctx } = viewContext(api, parseRoute('#/overview'), { ctx: { signal: controller.signal } })
  document.body.append(ctx.container)
  const pending = renderOverview(ctx)
  controller.abort()
  await pending
  assert.equal(ctx.container.querySelectorAll('.kpi-value').length, 0, 'only the loading placeholders are left')
  assert.equal(ctx.container.querySelector('.empty-error'), null, 'and no error either')
})

test('hostile model names, admins and actions are text', async () => {
  const evil = '<img src=x onerror=1>'
  const { root } = await open({
    use: usage([{ day: dayAgo(0), model: evil, credits: 5, succeeded: 1, failed: 0 }]),
    audit: auditPage([{ id: 1, at: recent(5), admin: evil, action: evil, targetType: null, targetId: null, details: {} }]),
  })
  assert.equal(root.querySelectorAll('img').length, 0)
})
