import test from 'node:test'
import assert from './assert.js'

import {
  formatNumber, formatCompact, formatBytes, formatPercent, formatDate, relativeTime, initials, truncate, plural,
  sourceLabel, actionLabel, categoryLabel, stateLabel, auditLabel, dailySeries, byModel, niceMax,
  SOURCE_LABELS, CATEGORY_LABELS,
} from '../lib/format.js'

test('formatNumber: separators, at most two decimals, and "—" for anything that is not a number', () => {
  assert.equal(formatNumber(1234567), '1,234,567')
  assert.equal(formatNumber(12.3456), '12.35')
  assert.equal(formatNumber(0), '0')
  assert.equal(formatNumber('42'), '42')
  assert.equal(formatNumber(-5), '-5')
  for (const bad of [null, undefined, '', '  ', 'abc', NaN, Infinity, -Infinity, {}, [], [5], true, false]) assert.equal(formatNumber(bad), '—', String(bad))
})

test('formatCompact keeps tiles short', () => {
  assert.equal(formatCompact(950), '950')
  assert.equal(formatCompact(12_400), '12.4K')
  assert.equal(formatCompact(2_500_000), '2.5M')
  assert.equal(formatCompact(null), '—')
})

test('formatBytes climbs units and refuses nonsense', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(4_200_000), '4.0 MB')
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB')
  assert.equal(formatBytes(5 * 1024 ** 4), '5.0 TB')
  assert.equal(formatBytes(1024 ** 6), '1048576.0 TB', 'beyond TB stays in TB')
  for (const bad of [-1, NaN, 'x', null, undefined, [], true, {}]) assert.equal(formatBytes(bad), '—', String(bad))
})

test('formatPercent never divides by zero', () => {
  assert.equal(formatPercent(1, 4), '25%')
  assert.equal(formatPercent(0, 4), '0%')
  assert.equal(formatPercent(5, 4), '125%')
  assert.equal(formatPercent(1, 0), '—')
  assert.equal(formatPercent(1, -3), '—')
  assert.equal(formatPercent(NaN, 4), '—')
  assert.equal(formatPercent(1, undefined), '—')
})

test('formatDate: a readable date in a given zone, "—" for nothing', () => {
  const iso = '2026-10-11T14:43:00.000Z'
  assert.equal(formatDate(iso, { timeZone: 'UTC' }), 'Oct 11, 2026, 2:43 PM')
  assert.equal(formatDate(iso, { timeZone: 'UTC', withTime: false }), 'Oct 11, 2026')
  assert.equal(formatDate(new Date(iso), { timeZone: 'UTC' }), 'Oct 11, 2026, 2:43 PM')
  assert.match(formatDate(iso, { timeZone: 'Asia/Karachi' }), /7:43 PM/)
  for (const bad of [null, undefined, '', 'not a date', NaN, {}]) assert.equal(formatDate(bad), '—', String(bad))
})

test('relativeTime: the scale, the edges between steps, and the future', () => {
  const now = Date.parse('2026-10-11T12:00:00Z')
  const ago = seconds => new Date(now - seconds * 1000).toISOString()
  const r = seconds => relativeTime(ago(seconds), { now, timeZone: 'UTC' })

  assert.equal(r(0), 'just now')
  assert.equal(r(44), 'just now')
  assert.equal(r(45), '1 min ago')
  assert.equal(r(90), '2 min ago')
  assert.equal(r(59 * 60), '59 min ago')
  assert.equal(r(3600), '1 h ago')
  assert.equal(r(5 * 3600), '5 h ago')
  assert.equal(r(23 * 3600), '23 h ago')
  assert.equal(r(86_400), '1 d ago')
  assert.equal(r(6 * 86_400), '6 d ago')
  assert.equal(r(7 * 86_400), 'Oct 4, 2026', 'a week or more is a date')
  assert.equal(r(400 * 86_400), 'Sep 6, 2025')

  assert.equal(r(-5), 'just now', 'a few seconds ahead is just now')
  assert.equal(r(-20), 'in a few seconds')
  assert.equal(r(-300), 'in 5 min')
  assert.equal(r(-7200), 'in 2 h')
  for (const bad of [null, undefined, '', 'nope']) assert.equal(relativeTime(bad, { now }), '—')
})

test('initials: two letters from a name or an email, a placeholder for nothing', () => {
  assert.equal(initials('mia@test.example'), 'MT')
  assert.equal(initials('Mia Brown'), 'MB')
  assert.equal(initials('mia'), 'MI')
  assert.equal(initials('x'), 'X')
  assert.equal(initials('  '), '?')
  assert.equal(initials(null), '?')
  assert.equal(initials(undefined), '?')
  assert.equal(initials('a.b_c-d'), 'AB')
  assert.equal(initials('😀 smile'), '😀S'.toUpperCase())
})

test('truncate: counts characters, not UTF-16 units, so an emoji is never split', () => {
  assert.equal(truncate('hello world', 20), 'hello world')
  assert.equal(truncate('hello world', 5), 'hell…')
  assert.equal(truncate('hello', 5), 'hello')
  assert.equal(truncate('😀😀😀😀', 3), '😀😀…')
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(truncate('😀😀😀😀', 3)), 'no lone surrogate')
  assert.equal(truncate(null, 5), '')
  assert.equal(truncate(undefined, 5), '')
  assert.equal(truncate('abc', 0), '…')
  assert.equal(truncate('abc', 1), '…')
})

test('plural keeps the number and the noun in agreement', () => {
  assert.equal(plural(1, 'job'), '1 job')
  assert.equal(plural(0, 'job'), '0 jobs')
  assert.equal(plural(2, 'job'), '2 jobs')
  assert.equal(plural(1234, 'job'), '1,234 jobs')
  assert.equal(plural(2, 'person', 'people'), '2 people')
  assert.equal(plural(1, 'was', 'were'), '1 was')
})

test('every code the server can send has words — no raw code reaches a screen', () => {
  for (const source of ['prompt', 'prompt_assist', 'image', 'video', 'output', 'report', 'provider']) assert.notEqual(sourceLabel(source), source, source)
  for (const action of ['blocked', 'review']) assert.notEqual(actionLabel(action), action)
  for (const category of [...Object.keys(CATEGORY_LABELS), 'unverifiable', 'flagged-by-generator', 'other']) assert.notEqual(categoryLabel(category), category, category)
  for (const state of ['waiting', 'queuing', 'generating', 'success', 'fail']) assert.notEqual(stateLabel(state), state)
  for (const action of ['user.suspend', 'user.unsuspend', 'user.set-role', 'user.delete', 'moderation.dismiss', 'moderation.confirm', 'moderation.view-media', 'price.upsert', 'price.delete']) {
    assert.notEqual(auditLabel(action), action, action)
  }
})

test('an unknown code is shown as it is rather than hidden or crashing', () => {
  assert.equal(sourceLabel('something-new'), 'something-new')
  assert.equal(categoryLabel(undefined), '—')
  assert.equal(categoryLabel('__proto__'), '__proto__', 'a prototype key is not a label')
  assert.equal(categoryLabel('constructor'), 'constructor')
  assert.equal(stateLabel('toString'), 'toString')
  assert.equal(auditLabel('hasOwnProperty'), 'hasOwnProperty')
})

test('the label tables are frozen', () => {
  assert.ok(Object.isFrozen(CATEGORY_LABELS) && Object.isFrozen(SOURCE_LABELS))
})

// ── Chart data ───────────────────────────────────────────────────────────────

test('dailySeries: one point per day ending today, zeros where nothing ran, rows on one day summed', () => {
  const now = Date.parse('2026-10-11T08:00:00Z')
  const series = dailySeries([
    { day: '2026-10-11', credits: 50, succeeded: 2, failed: 0 },
    { day: '2026-10-11', credits: 20, succeeded: 1, failed: 1 },
    { day: '2026-10-09', credits: 5, succeeded: 1, failed: 0 },
    { day: '2020-01-01', credits: 999, succeeded: 9, failed: 9 },   // outside the window
  ], 4, now)

  assert.deepEqual(series.map(d => d.day), ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'])
  assert.deepEqual(series.map(d => d.credits), [0, 5, 0, 70])
  assert.deepEqual(series[3], { day: '2026-10-11', credits: 70, succeeded: 3, failed: 1 })
})

test('dailySeries: ISO timestamps, junk numbers, no rows and month/year boundaries', () => {
  const now = Date.parse('2027-01-02T00:30:00Z')
  const series = dailySeries([{ day: '2026-12-31T00:00:00.000Z', credits: '12', succeeded: null, failed: undefined }, { day: '2027-01-02', credits: 'junk' }], 4, now)
  assert.deepEqual(series.map(d => d.day), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'])
  assert.equal(series[1].credits, 12)
  assert.equal(series[3].credits, 0)
  assert.equal(dailySeries([], 7, now).length, 7)
  assert.equal(dailySeries(undefined, 3, now).length, 3)
  assert.equal(dailySeries(null, 1, now)[0].day, '2027-01-02')
})

test('dailySeries uses UTC days, whatever the viewer\'s clock says', () => {
  // 23:30 UTC on the 10th is already the 11th in Karachi; the series still ends on the 10th.
  const series = dailySeries([], 2, Date.parse('2026-10-10T23:30:00Z'))
  assert.equal(series.at(-1).day, '2026-10-10')
})

test('byModel: folds days together, biggest spend first, ties broken by activity then name', () => {
  const rows = [
    { model: 'b', credits: 10, succeeded: 1, failed: 0 }, { model: 'a', credits: 10, succeeded: 1, failed: 0 },
    { model: 'c', credits: 10, succeeded: 5, failed: 0 }, { model: 'big', credits: 100, succeeded: 1, failed: 0 },
    { model: 'big', credits: 50, succeeded: 2, failed: 1 }, { model: 'free', credits: 0, succeeded: 3, failed: 0 },
  ]
  const out = byModel(rows)
  assert.deepEqual(out.map(m => m.model), ['big', 'c', 'a', 'b', 'free'])
  assert.deepEqual(out[0], { model: 'big', credits: 150, succeeded: 3, failed: 1 })
  assert.deepEqual(byModel([]), [])
  assert.deepEqual(byModel(undefined), [])
})

test('niceMax picks a round ceiling for a chart\'s top line', () => {
  assert.equal(niceMax(137.4), 200)
  assert.equal(niceMax(203), 250)
  assert.equal(niceMax(250), 250)
  assert.equal(niceMax(251), 500)
  assert.equal(niceMax(1), 1)
  assert.equal(niceMax(0.3), 0.5)
  assert.equal(niceMax(9), 10)
  assert.equal(niceMax(10), 10)
  assert.equal(niceMax(10_001), 20_000)
  for (const bad of [0, -5, NaN, null, undefined, 'x', Infinity]) assert.equal(niceMax(bad), 1, String(bad))
})
