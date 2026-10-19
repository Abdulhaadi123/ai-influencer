// The building blocks that are not overlays: badges, buttons, forms, tables, pagers,
// the loading / empty / error states, and the charts.

import test, { beforeEach, mock } from 'node:test'
import assert from './assert.js'

import { installDom, reset, click, press, type, change, settle, tick, text, all, byText } from './helpers.js'

const { clipboard } = installDom()
const C = await import('../lib/components.js')
const { h } = await import('../lib/dom.js')

beforeEach(() => { reset(); clipboard.written.length = 0; clipboard.fail = false })

// ── Badges, avatars, buttons ─────────────────────────────────────────────────

test('badge: tone class, optional dot and title', () => {
  const b = C.badge('Active', 'success', { dot: true, title: 'Signed in' })
  assert.ok(b.classList.contains('badge') && b.classList.contains('badge-success'))
  assert.equal(b.title, 'Signed in')
  assert.equal(b.querySelectorAll('.badge-dot').length, 1)
  assert.equal(text(b), 'Active')
  assert.equal(C.badge('x').classList.contains('badge-neutral'), true)
  assert.equal(C.badge('x', 'warning').querySelector('.badge-dot'), null)
})

test('badge text from data is text', () => {
  const b = C.badge('<img src=x onerror=1>')
  assert.equal(b.querySelectorAll('img').length, 0)
})

test('avatar: initials, a stable colour per person, and a colour from the six', () => {
  const a = C.avatar('mia@test.example', 40)
  assert.equal(text(a), 'MT')
  assert.equal(a.style.width, '40px')
  const cls = n => [...n.classList].find(c => /^avatar-\d$/.test(c))
  assert.equal(cls(C.avatar('mia@test.example')), cls(C.avatar('mia@test.example')), 'same person, same colour')
  const seen = new Set()
  for (let i = 0; i < 60; i++) { const c = cls(C.avatar(`person${i}@x.test`)); assert.match(c, /^avatar-[0-5]$/); seen.add(c) }
  assert.ok(seen.size > 3, 'the colours actually vary')
  assert.equal(text(C.avatar(null)), '?')
  assert.equal(C.avatar('x').getAttribute('aria-hidden'), 'true')
})

test('button: tone, size, label, icon, disabled, title, click', () => {
  let n = 0
  const b = C.button({ label: 'Save', iconName: 'check', tone: 'primary', small: true, title: 'Save it', onClick: () => { n++ } })
  assert.ok(b.classList.contains('btn-primary') && b.classList.contains('btn-sm'))
  assert.equal(b.type, 'button')
  assert.equal(b.title, 'Save it')
  assert.equal(b.querySelectorAll('svg').length, 1)
  assert.equal(text(b), 'Save')
  click(b)
  assert.equal(n, 1)
  assert.equal(C.button({ label: 'x', disabled: true }).disabled, true)
  assert.equal(C.button({ label: 'x', type: 'submit' }).type, 'submit')
  assert.equal(C.button({ iconName: 'x', ariaLabel: 'Close' }).getAttribute('aria-label'), 'Close')
  assert.equal(C.button({ iconName: 'x' }).querySelector('span'), null, 'an icon-only button has no empty label')
})

test('iconButton has an accessible name', () => {
  const b = C.iconButton({ iconName: 'trash', label: 'Delete', onClick() {} })
  assert.equal(b.getAttribute('aria-label'), 'Delete')
  assert.equal(b.title, 'Delete')
})

// ── Forms ────────────────────────────────────────────────────────────────────

test('field: the label points at the control, the hint is announced with it', () => {
  const input = h('input', {})
  const f = C.field({ label: 'Reason', hint: 'Be brief', control: input })
  assert.ok(input.id)
  assert.equal(f.querySelector('label').getAttribute('for'), input.id)
  assert.equal(input.getAttribute('aria-describedby'), `${input.id}-hint`)
  assert.equal(f.querySelector(`#${input.id}-hint`).textContent, 'Be brief')

  const bare = h('input', {})
  const f2 = C.field({ label: 'x', control: bare })
  assert.equal(bare.hasAttribute('aria-describedby'), false)
  assert.equal(f2.querySelector('.field-hint'), null)

  const named = h('input', { id: 'mine' })
  C.field({ label: 'y', control: named })
  assert.equal(named.id, 'mine', 'an id the caller chose is kept')
})

test('switchControl: waits for the change, reverts if it fails, is disabled meanwhile', async () => {
  let resolve
  const calls = []
  const sw = C.switchControl({ checked: false, label: 'Enable', onChange: next => { calls.push(next); return new Promise(r => { resolve = r }) } })
  assert.equal(sw.getAttribute('role'), 'switch')
  assert.equal(sw.getAttribute('aria-checked'), 'false')
  click(sw)
  assert.equal(sw.disabled, true, 'busy')
  click(sw)
  assert.deepEqual(calls, [true], 'a second click while busy does nothing')
  resolve()
  await settle()
  assert.equal(sw.getAttribute('aria-checked'), 'true')
  assert.equal(sw.disabled, false)

  const failing = C.switchControl({ checked: true, label: 'x', onChange: async () => { throw new Error('no') } })
  click(failing)
  await settle()
  assert.equal(failing.getAttribute('aria-checked'), 'true', 'the switch stays where it was')
  assert.equal(failing.disabled, false)
})

test('switchControl can start disabled', () => {
  const sw = C.switchControl({ checked: true, label: 'x', disabled: true, onChange() { throw new Error('must not run') } })
  click(sw)
  assert.equal(sw.getAttribute('aria-checked'), 'true')
})

test('meter: width as a percentage, clamped, with the numbers for screen readers', () => {
  const pct = m => m.querySelector('.meter-fill').style.width
  assert.equal(pct(C.meter({ value: 2, max: 5 })), '40%')
  assert.equal(pct(C.meter({ value: 9, max: 5 })), '100%')
  assert.equal(pct(C.meter({ value: -3, max: 5 })), '0%')
  assert.equal(pct(C.meter({ value: 3, max: 0 })), '0%')
  assert.equal(pct(C.meter({ value: 'x', max: 5 })), '0%')
  const m = C.meter({ value: 2, max: 5, tone: 'danger', label: 'Strikes' })
  assert.equal(m.getAttribute('role'), 'meter')
  assert.equal(m.getAttribute('aria-valuenow'), '2')
  assert.equal(m.getAttribute('aria-valuemax'), '5')
  assert.ok(m.classList.contains('meter-danger'))
})

test('copyButton copies, says so, and does not trigger the row it sits in', async () => {
  let rowClicks = 0
  const row = h('div', { onclick: () => { rowClicks++ } }, C.copyButton('task-123', 'Copy the task id'))
  document.body.append(row)
  click(row.querySelector('button'))
  await settle()
  assert.deepEqual(clipboard.written, ['task-123'])
  assert.equal(rowClicks, 0)
  assert.match(text(document.querySelector('.toast-success')), /Copied/)
})

test('copyButton tells the person when the browser refuses', async () => {
  clipboard.fail = true
  const b = C.copyButton('x')
  document.body.append(b)
  click(b)
  await settle()
  assert.match(text(document.querySelector('.toast-error')), /Could not copy/)
})

// ── Page furniture ───────────────────────────────────────────────────────────

test('pageHeader and card: titles, subtitles, actions', () => {
  const header = C.pageHeader({ title: 'Users', subtitle: 'Everyone', actions: [C.button({ label: 'Add' })] })
  assert.equal(header.querySelector('h1').textContent, 'Users')
  assert.equal(header.querySelector('.page-subtitle').textContent, 'Everyone')
  assert.equal(header.querySelectorAll('.page-actions button').length, 1)
  assert.equal(C.pageHeader({ title: 'x' }).querySelector('.page-actions'), null)

  const card = C.card({ title: 'T', subtitle: 'S', actions: h('button', {}, 'a'), body: h('p', {}, 'body'), flush: true })
  assert.ok(card.classList.contains('card-flush'))
  assert.equal(card.querySelector('h2').textContent, 'T')
  assert.equal(text(card.querySelector('.card-body')), 'body')
  assert.equal(C.card({ body: 'x' }).querySelector('.card-header'), null, 'no header without a title or actions')
})

test('kpi: a link when given an href, otherwise a plain tile', () => {
  const link = C.kpi({ label: 'Accounts', value: '5', hint: '2 new', iconName: 'users', href: '#/users', tone: 'warning', title: 'Five' })
  assert.equal(link.tagName, 'A')
  assert.equal(link.getAttribute('href'), '#/users')
  assert.equal(link.title, 'Five')
  assert.equal(text(link.querySelector('.kpi-value')), '5')
  assert.ok(link.querySelector('.kpi-icon-warning'))
  const plain = C.kpi({ label: 'x', value: 1 })
  assert.equal(plain.tagName, 'DIV')
  assert.equal(plain.querySelector('.kpi-hint'), null)
})

test('callout: urgent ones are announced as alerts, calm ones as status', () => {
  assert.equal(C.callout({ tone: 'danger', title: 'x' }).getAttribute('role'), 'alert')
  assert.equal(C.callout({ tone: 'warning', title: 'x' }).getAttribute('role'), 'alert')
  assert.equal(C.callout({ tone: 'info', title: 'x' }).getAttribute('role'), 'status')
  assert.equal(C.callout({ tone: 'success', title: 'x' }).getAttribute('role'), 'status')
  const c = C.callout({ tone: 'info', title: 'T', body: 'B', action: h('a', { href: '#/x' }, 'Go') })
  assert.equal(c.querySelector('strong').textContent, 'T')
  assert.equal(c.querySelector('a').textContent, 'Go')
})

test('emptyState and errorState', () => {
  const e = C.emptyState({ iconName: 'users', title: 'No accounts', body: 'None yet', action: C.button({ label: 'Clear' }) })
  assert.equal(e.querySelector('h3').textContent, 'No accounts')
  assert.equal(e.querySelectorAll('button').length, 1)

  let retried = 0
  const err = C.errorState({ message: 'Boom', onRetry: () => { retried++ } })
  assert.equal(err.getAttribute('role'), 'alert')
  assert.match(text(err), /Boom/)
  click(err.querySelector('button'))
  assert.equal(retried, 1)
  assert.match(text(C.errorState({})), /could not be loaded/)
  assert.equal(C.errorState({ message: 'x' }).querySelector('button'), null, 'no retry button without a retry')
})

test('skeletons are busy regions of the requested size', () => {
  const rows = C.skeletonRows(4, 3)
  assert.equal(rows.getAttribute('aria-busy'), 'true')
  assert.equal(rows.querySelectorAll('.skeleton-row').length, 3)
  assert.equal(rows.querySelectorAll('.skeleton').length, 12)
  assert.equal(C.skeletonCards(5).querySelectorAll('.kpi').length, 5)
})

// ── loadInto ─────────────────────────────────────────────────────────────────

test('loadInto: skeleton first, then the rendered result', async () => {
  const box = h('div', {})
  let release
  const done = C.loadInto(box, { load: () => new Promise(r => { release = r }), render: data => box.replaceChildren(h('p', {}, `got ${data}`)) })
  assert.equal(box.querySelectorAll('[aria-busy]').length, 1, 'a skeleton while waiting')
  release('it')
  await done
  assert.equal(text(box), 'got it')
})

test('loadInto: a failure shows the error with a retry that runs everything again', async () => {
  const box = h('div', {})
  let attempt = 0
  const opts = {
    load: async () => { attempt++; if (attempt === 1) throw new Error('first try failed'); return 'ok' },
    render: data => box.replaceChildren(h('p', {}, data)),
  }
  await C.loadInto(box, opts)
  assert.match(text(box), /first try failed/)
  click(box.querySelector('button'))
  await settle()
  assert.equal(text(box), 'ok')
  assert.equal(attempt, 2)
})

test('loadInto: a cancelled load neither renders nor reports', async () => {
  const box = h('div', {}, 'untouched')
  const controller = new AbortController()
  let release
  const done = C.loadInto(box, { signal: controller.signal, load: () => new Promise(r => { release = r }), render: () => { throw new Error('must not render') } })
  controller.abort()
  release('late')
  await done
  assert.equal(box.querySelectorAll('[role=alert]').length, 0)

  const box2 = h('div', {})
  await C.loadInto(box2, { load: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }) }, render: () => {} })
  assert.equal(box2.querySelectorAll('[role=alert]').length, 0, 'an AbortError is not an error to show')
})

test('loadInto: a render that throws is reported, not swallowed into a blank page', async () => {
  const box = h('div', {})
  await C.loadInto(box, { load: async () => 1, render: () => { throw new Error('render bug') } })
  assert.match(text(box), /render bug/)
})

// ── debounce ─────────────────────────────────────────────────────────────────

test('debounce runs once, with the last arguments, after the quiet period', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const seen = []
    const d = C.debounce(v => seen.push(v), 300)
    d('a'); mock.timers.tick(100); d('b'); mock.timers.tick(100); d('c')
    mock.timers.tick(299)
    assert.deepEqual(seen, [])
    mock.timers.tick(1)
    assert.deepEqual(seen, ['c'])
    d('d'); d.cancel(); mock.timers.tick(1000)
    assert.deepEqual(seen, ['c'], 'a cancelled call never runs')
    d('e'); mock.timers.tick(300)
    assert.deepEqual(seen, ['c', 'e'])
  } finally { mock.timers.reset() }
})

// ── Choosing ─────────────────────────────────────────────────────────────────

test('segmented: a radio group; only a different choice calls back', () => {
  const picked = []
  const seg = C.segmented({ label: 'Status', value: 'a', onChange: v => picked.push(v), options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', count: 1234 }] })
  assert.equal(seg.getAttribute('role'), 'radiogroup')
  const [a, b] = all(seg, 'button')
  assert.equal(a.getAttribute('aria-checked'), 'true')
  assert.equal(b.getAttribute('aria-checked'), 'false')
  assert.equal(text(b), 'B1,234')
  click(a)
  assert.deepEqual(picked, [])
  click(b)
  assert.deepEqual(picked, ['b'])
})

test('tabs: a tablist with counts; only a different tab calls back; a missing count shows none', () => {
  const picked = []
  const t = C.tabs({ label: 'Status', value: 'open', onChange: v => picked.push(v), items: [{ id: 'open', label: 'Open', count: 5 }, { id: 'done', label: 'Done', count: 0 }, { id: 'all', label: 'All' }] })
  assert.equal(t.getAttribute('role'), 'tablist')
  const buttons = all(t, '[role=tab]')
  assert.deepEqual(buttons.map(b => b.getAttribute('aria-selected')), ['true', 'false', 'false'])
  assert.equal(text(buttons[1]), 'Done0', 'zero is shown')
  assert.equal(buttons[2].querySelector('.tab-count'), null)
  click(buttons[0]); click(buttons[1])
  assert.deepEqual(picked, ['done'])
})

test('selectControl and searchBox report what the person chose or typed', () => {
  const got = []
  const sel = C.selectControl({ label: 'Model', value: 'b', onChange: v => got.push(v), options: [{ value: '', label: 'Any' }, { value: 'a', label: 'A' }, { value: 'b', label: 'B' }] })
  assert.equal(sel.value, 'b')
  assert.equal(sel.getAttribute('aria-label'), 'Model')
  change(sel, 'a')
  assert.deepEqual(got, ['a'])

  const typed = []
  const box = C.searchBox({ value: 'mia', placeholder: 'Search', label: 'Find', onInput: v => typed.push(v) })
  const input = box.querySelector('input')
  assert.equal(input.value, 'mia')
  assert.equal(input.getAttribute('aria-label'), 'Find')
  type(input, 'mia b')
  assert.deepEqual(typed, ['mia b'])
})

// ── Tables ───────────────────────────────────────────────────────────────────

const rows = [{ id: 'r1', name: 'Alpha', n: 3 }, { id: 'r2', name: 'Beta', n: 1 }]
const columns = [
  { key: 'name', label: 'Name', sortKey: 'name', defaultDir: 'asc', render: r => r.name },
  { key: 'n', label: 'Count', sortKey: 'n', align: 'right', hideBelow: 'md', render: r => String(r.n) },
  { key: 'x', label: '', render: r => h('button', { type: 'button', class: 'inner' }, `act ${r.id}`) },
]

test('dataTable renders a header and a row per item, with alignment and responsive classes', () => {
  const t = C.dataTable({ label: 'Things', columns, rows })
  assert.equal(t.querySelector('table').getAttribute('aria-label'), 'Things')
  assert.equal(all(t, 'thead th').length, 3)
  assert.equal(all(t, 'tbody tr').length, 2)
  assert.ok(all(t, 'thead th')[1].classList.contains('num'))
  assert.ok(all(t, 'thead th')[1].classList.contains('hide-md'))
  assert.equal(text(all(t, 'tbody tr')[0]), 'Alpha3act r1')
})

test('dataTable: cell content that is data is shown as text', () => {
  const t = C.dataTable({ label: 'x', columns: [{ key: 'n', label: 'N', render: r => r.name }], rows: [{ id: '1', name: '<img src=x onerror=1>' }] })
  assert.equal(t.querySelectorAll('img').length, 0)
})

test('dataTable sorting: aria-sort, and which direction a click asks for', () => {
  const asked = []
  const make = sort => C.dataTable({ label: 'x', columns, rows, sort, onSort: (key, dir) => asked.push([key, dir]) })

  let t = make({ key: 'name', dir: 'asc' })
  assert.deepEqual(all(t, 'thead th').map(th => th.getAttribute('aria-sort')), ['ascending', 'none', null], 'a column that cannot sort has no aria-sort')
  click(t.querySelector('thead th:first-child button'))   // active ascending → descending
  click(t.querySelector('thead th:nth-child(2) button'))  // inactive → its own default (desc)
  t = make({ key: 'name', dir: 'desc' })
  assert.equal(all(t, 'thead th')[0].getAttribute('aria-sort'), 'descending')
  click(t.querySelector('thead th:first-child button'))   // active descending → ascending
  t = make({ key: 'n', dir: 'asc' })
  click(t.querySelector('thead th:first-child button'))   // inactive → its default (asc)
  assert.deepEqual(asked, [['name', 'desc'], ['n', 'desc'], ['name', 'asc'], ['name', 'asc']])
})

test('dataTable without onSort has plain headers', () => {
  const t = C.dataTable({ label: 'x', columns, rows })
  assert.equal(t.querySelectorAll('thead button').length, 0)
})

test('dataTable rows: click and keyboard open a row, but not when the click was on a control inside it', () => {
  const opened = []
  const t = C.dataTable({ label: 'x', columns, rows, onRowClick: r => opened.push(r.id), selectedKey: 'r2' })
  document.body.append(t)
  const trs = all(t, 'tbody tr')
  assert.equal(trs[0].getAttribute('tabindex'), '0')
  assert.ok(trs[1].classList.contains('row-selected'))
  assert.ok(!trs[0].classList.contains('row-selected'))

  click(trs[0].querySelector('td'))
  assert.deepEqual(opened, ['r1'])
  click(trs[0].querySelector('.inner'))
  assert.deepEqual(opened, ['r1'], 'a button inside the row is its own action')

  press(trs[1], 'Enter'); press(trs[1], ' ')
  assert.deepEqual(opened, ['r1', 'r2', 'r2'])
  press(trs[1], 'a')
  press(trs[1].querySelector('.inner'), 'Enter')
  assert.deepEqual(opened, ['r1', 'r2', 'r2'], 'other keys, and keys inside a control, do nothing')
})

test('dataTable without onRowClick has unfocusable rows and does nothing on click', () => {
  const t = C.dataTable({ label: 'x', columns, rows })
  const tr = t.querySelector('tbody tr')
  assert.equal(tr.hasAttribute('tabindex'), false)
  assert.doesNotThrow(() => click(tr))
})

test('dataTable honours a custom rowKey and handles no rows', () => {
  const t = C.dataTable({ label: 'x', columns, rows: [{ model: 'a' }, { model: 'b' }], rowKey: r => r.model })
  assert.deepEqual(all(t, 'tbody tr').map(r => r.getAttribute('data-key')), ['a', 'b'])
  assert.equal(all(C.dataTable({ label: 'x', columns, rows: [] }), 'tbody tr').length, 0)
})

// ── Pager ────────────────────────────────────────────────────────────────────

test('pager: the range, the page, and previous / next at the edges', () => {
  const moved = []
  const p = (page, total, pageSize = 25) => C.pager({ page, pageSize, total, onChange: v => moved.push(v) })

  let el = p(1, 132)
  assert.match(text(el), /1–25 of 132/)
  assert.match(text(el), /Page 1 of 6/)
  assert.equal(el.querySelector('[aria-label="Previous page"]').disabled, true)
  assert.equal(el.querySelector('[aria-label="Next page"]').disabled, false)
  click(el.querySelector('[aria-label="Next page"]'))

  el = p(6, 132)
  assert.match(text(el), /126–132 of 132/)
  assert.equal(el.querySelector('[aria-label="Next page"]').disabled, true)
  click(el.querySelector('[aria-label="Previous page"]'))
  assert.deepEqual(moved, [{ page: 2, pageSize: 25 }, { page: 5, pageSize: 25 }])
})

test('pager: no results, exactly one page, and exactly full pages', () => {
  const noop = () => {}
  assert.match(text(C.pager({ page: 1, pageSize: 25, total: 0, onChange: noop })), /No results/)
  assert.match(text(C.pager({ page: 1, pageSize: 25, total: 0, onChange: noop })), /Page 1 of 1/)
  const one = C.pager({ page: 1, pageSize: 25, total: 25, onChange: noop })
  assert.match(text(one), /1–25 of 25/)
  assert.equal(one.querySelector('[aria-label="Next page"]').disabled, true)
  assert.match(text(C.pager({ page: 2, pageSize: 25, total: 50, onChange: noop })), /26–50 of 50/)
  assert.match(text(C.pager({ page: 1, pageSize: 25, total: 1234, onChange: noop })), /of 1,234/)
})

test('pager: changing the page size goes back to page 1; a single size has no selector', () => {
  const moved = []
  const el = C.pager({ page: 4, pageSize: 25, total: 500, onChange: v => moved.push(v) })
  change(el.querySelector('select'), '100')
  assert.deepEqual(moved, [{ page: 1, pageSize: 100 }])
  assert.equal(C.pager({ page: 1, pageSize: 25, total: 5, sizes: [25], onChange() {} }).querySelector('select'), null)
})

// ── Charts ───────────────────────────────────────────────────────────────────

test('barChart: a bar and a title per day, an axis rounded up, and an accessible name', () => {
  const chart = C.barChart({ label: 'Credits per day', data: [{ key: '10-09', value: 5, title: '10-09: 5' }, { key: '10-10', value: 0, title: '10-10: 0' }, { key: '10-11', value: 203, title: '10-11: 203' }] })
  assert.equal(chart.querySelector('svg').getAttribute('role'), 'img')
  assert.equal(chart.querySelector('svg').getAttribute('aria-label'), 'Credits per day')
  assert.equal(chart.querySelectorAll('.chart-col').length, 3)
  assert.equal(chart.querySelectorAll('.chart-bar').length, 2, 'a day with nothing has no bar')
  assert.deepEqual(all(chart, 'title').map(t => t.textContent), ['10-09: 5', '10-10: 0', '10-11: 203'])
  assert.deepEqual(all(chart, '.chart-axis span').map(s => s.textContent), ['250', '125', '0'])
  assert.deepEqual(all(chart, '.chart-x span').map(s => s.textContent), ['10-09', '10-11'])
})

test('barChart: the tallest bar fills the plot; others are proportional; a tiny value is still visible', () => {
  const chart = C.barChart({ label: 'x', data: [{ key: 'a', value: 100, title: 'a' }, { key: 'b', value: 50, title: 'b' }, { key: 'c', value: 0.01, title: 'c' }] })
  const heights = all(chart, '.chart-bar').map(r => Number(r.getAttribute('height')))
  assert.equal(heights[0], 100)
  assert.equal(heights[1], 50)
  assert.equal(heights[2], 1.5, 'a minimum, so it can be seen and hovered')
})

test('barChart: all zeros, no data, negatives and junk do not break it', () => {
  assert.doesNotThrow(() => C.barChart({ label: 'x', data: [{ key: 'a', value: 0, title: 'a' }] }))
  const empty = C.barChart({ label: 'x', data: [] })
  assert.equal(empty.querySelectorAll('.chart-col').length, 0)
  const odd = C.barChart({ label: 'x', data: [{ key: 'a', value: -5, title: 'a' }, { key: 'b', value: 'junk', title: 'b' }, { key: 'c', value: NaN, title: 'c' }] })
  assert.equal(odd.querySelectorAll('.chart-bar').length, 0)
})

test('barList: widths relative to the biggest, a floor so a small one shows, and an empty message', () => {
  const list = C.barList({ items: [{ label: 'a', value: 100, sub: '3 jobs' }, { label: 'b', value: 50 }, { label: 'c', value: 0 }] })
  const widths = all(list, '.barlist-fill').map(f => f.style.width)
  assert.deepEqual(widths, ['100%', '50%', '2%'])
  assert.equal(all(list, '.barlist-sub').length, 1)
  assert.match(text(C.barList({ items: [] })), /Nothing yet/)
  assert.match(text(C.barList({ items: [], emptyText: 'No spend.' })), /No spend/)
  assert.equal(all(C.barList({ items: [{ label: 'z', value: 0 }] }), '.barlist-fill')[0].style.width, '0%', 'all zero: no division by zero')
  assert.equal(all(C.barList({ items: [{ label: 'a', value: 10 }, { label: 'j', value: 'junk' }] }), '.barlist-fill')[1].style.width, '2%', 'a value that is not a number is a floor-width bar, never NaN%')
})

test('barList: a label that is data is text', () => {
  const list = C.barList({ items: [{ label: '<b>x</b>', value: 1 }] })
  assert.equal(list.querySelectorAll('b').length, 0)
  assert.ok(byText(list, '.barlist-label', '<b>x</b>'))
})

void tick

// ── Explanations, paired charts, alert counts ───────────────────────────────

test('infoTip: the words are the tooltip and the accessible name, and it can be reached by keyboard', () => {
  const tip = C.infoTip('What this counts.')
  assert.equal(tip.getAttribute('title'), 'What this counts.')
  assert.equal(tip.getAttribute('aria-label'), 'What this counts.')
  assert.equal(tip.getAttribute('role'), 'img')
  assert.equal(tip.getAttribute('tabindex'), '0')
  assert.ok(tip.querySelector('svg'))
})

test('kpi: an optional explanation beside the label and a unit after the number, with a space between', () => {
  const plain = C.kpi({ label: 'Accounts', value: '5' })
  assert.equal(plain.querySelector('.tip'), null)
  assert.equal(plain.querySelector('.kpi-unit'), null)

  const full = C.kpi({ label: 'Credits bought', value: '5,500', unit: 'credits', tip: 'What was bought.' })
  assert.equal(text(full.querySelector('.kpi-label')), 'Credits bought')
  assert.equal(full.querySelector('.kpi-label .tip').getAttribute('title'), 'What was bought.')
  assert.equal(text(full.querySelector('.kpi-value')), '5,500 credits')
  assert.equal(text(full.querySelector('.kpi-unit')), 'credits')
})

test('dataTable: a column can carry an explanation in its heading, sortable or not', () => {
  const table = C.dataTable({
    label: 'T', rows: [{ id: 'a' }], onSort: () => {}, sort: { key: 'x', dir: 'desc' },
    columns: [
      { key: 'x', label: 'Credits', sortKey: 'x', tip: 'What it is.', render: () => '1' },
      { key: 'y', label: 'Plain', render: () => '2' },
      { key: 'z', label: 'Cost', tip: 'KIE charged.', render: () => '3' },
    ],
  })
  const heads = all(table, 'th')
  assert.equal(heads[0].querySelector('.tip').getAttribute('title'), 'What it is.')
  assert.ok(heads[0].querySelector('button'), 'still sortable')
  assert.equal(heads[1].querySelector('.tip'), null)
  assert.equal(heads[2].querySelector('.tip').getAttribute('title'), 'KIE charged.')
})

test('barChart with a second series draws a pair of bars per day, in two colours, and scales to the larger of the two', () => {
  const chart = C.barChart({ label: 'Bought and spent', data: [
    { key: '10-01', value: 100, value2: 400, title: 'd1' },
    { key: '10-02', value: 0, value2: 0, title: 'd2' },
    { key: '10-03', value: 50, value2: 0, title: 'd3' },
  ] })
  assert.equal(chart.querySelectorAll('g.chart-col').length, 3)
  assert.equal(chart.querySelectorAll('rect.chart-bar').length, 2)
  assert.equal(chart.querySelectorAll('rect.chart-bar-2').length, 1)
  assert.equal(text(chart.querySelector('.chart-axis span')), '500', 'the axis tops out above the larger series')
  const first = chart.querySelector('rect.chart-bar')
  const second = chart.querySelector('rect.chart-bar-2')
  assert.ok(Number(second.getAttribute('x')) > Number(first.getAttribute('x')), 'side by side, not on top of each other')
  assert.ok(Number(first.getAttribute('width')) < 5, 'each is half a column')
})

test('barChart without a second series is unchanged: one full-width bar per day', () => {
  const chart = C.barChart({ label: 'One', data: [{ key: 'a', value: 5, title: 't' }] })
  assert.equal(chart.querySelectorAll('rect.chart-bar-2').length, 0)
  assert.ok(Number(chart.querySelector('rect.chart-bar').getAttribute('width')) > 7)
})

test('chartLegend names each colour; the second series gets the second swatch', () => {
  const legend = C.chartLegend([{ label: 'Bought' }, { label: 'Spent', second: true }])
  const items = all(legend, '.legend-item')
  assert.equal(items.length, 2)
  assert.equal(text(items[0]), 'Bought')
  assert.ok(!items[0].querySelector('.legend-swatch-2'))
  assert.ok(items[1].querySelector('.legend-swatch-2'))
})

test('tabs: a count can be flagged as an alert', () => {
  const t = C.tabs({ label: 'x', value: 'a', onChange: () => {}, items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', count: 3, alert: true }, { id: 'c', label: 'C', count: 0 }] })
  assert.ok(t.querySelectorAll('.tab-count-alert').length === 1)
  assert.equal(text(t.querySelectorAll('.tab-count')[0]), '3')
  assert.ok(!t.querySelectorAll('.tab-count')[1].classList.contains('tab-count-alert'))
})
