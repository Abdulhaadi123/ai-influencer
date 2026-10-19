// The generations page (the code still calls them jobs): a read-only list with filters. What it asks for, what it shows,
// and that nothing on it can change a job.

import test, { beforeEach, mock } from 'node:test'
import assert from './assert.js'

import {
  installDom, reset, click, type, change, settle, microtasks, text, all, byText, fakeApi, viewContext, apiError, ID,
} from './helpers.js'

installDom()
const { renderJobs } = await import('../views/jobs.js')
const { parseRoute } = await import('../lib/router.js')

beforeEach(() => { reset(); navigator.clipboard.written.length = 0 })

const recent = seconds => new Date(Date.now() - seconds * 1000).toISOString()

const job = (n, over = {}) => ({
  id: `job-${n}`, userId: ID(n), email: `user${n}@test.example`, taskId: `task-${n}-abcdefghijklmnopqrstuvwxyz`, kind: 'video', model: 'kling-3.0/video',
  state: 'success', failMessage: null, kieCredits: 27 + n, charged: null, createdAt: recent(300 * n), ...over,
})
const page = (jobs, extra = {}) => ({ jobs, total: jobs.length, page: 1, pageSize: 25, ...extra })

function open({ hash = '#/jobs', jobs = [job(1), job(2)], routes = {} } = {}) {
  const api = fakeApi({
    'GET /api/admin/jobs': () => page(jobs),
    'GET /api/admin/prices': { prices: [{ model: 'kling-3.0/video' }, { model: 'nano-banana-pro' }], unpriced: [{ model: 'veo-3-1' }], units: ['per_second'] },
    ...routes,
  })
  const { ctx, navigations } = viewContext(api, parseRoute(hash))
  document.body.append(ctx.container)
  const controller = renderJobs(ctx)
  return { api, ctx, navigations, controller, root: ctx.container }
}

const lastQuery = api => api.of('GET', '/api/admin/jobs').at(-1).input
const select = (root, label) => root.querySelector(`select[aria-label="${label}"]`)

test('each generation shows when, who, which model, its status, what the person was charged and what KIE charged', async () => {
  const { root } = open({ jobs: [
    job(1),
    job(2, { state: 'fail', failMessage: 'The prompt was flagged by the provider.', kieCredits: null, kind: 'image', model: 'nano-banana-pro' }),
    job(3, { state: 'generating', kieCredits: null }),
    job(4, { model: null, kieCredits: 0 }),
  ] })
  await settle()
  const rows = all(root, 'tbody tr')
  assert.equal(rows.length, 4)

  const ok = text(rows[0])
  assert.match(ok, /5 min ago/)
  assert.match(ok, /user1@test\.example/)
  assert.match(ok, /kling-3\.0\/video/, 'the id is always shown')
  assert.match(ok, /Kling 3\.0 · video/, 'and a name a person can read next to it')
  assert.match(ok, /Succeeded|Success/)
  assert.match(ok, /28/)

  const failed = text(rows[1])
  assert.match(failed, /Failed/)
  assert.match(failed, /The prompt was flagged/)
  const cell = (row, i) => row.querySelectorAll('td')[i]
  assert.equal(cell(rows[1], 6).querySelector('.muted').title, 'KIE did not report a charge for this generation.')

  assert.equal(cell(rows[2], 6).querySelector('.muted').title, 'Not finished yet.', 'a running generation has no charge yet, and says so')
  assert.match(text(rows[3]), /—/, 'no model recorded')
  assert.equal(text(cell(rows[3], 6)), '0', 'a KIE charge of zero is a charge, not a gap')
  assert.equal(rows[0].querySelector('a.link').getAttribute('href'), `#/users/${ID(1)}`)
})

test('the credits the person was charged sit beside what KIE charged: a number, a refund, or a dash for "nothing was charged"', async () => {
  const { root } = open({ jobs: [
    job(1, { charged: 28 }),
    job(2, { state: 'fail', kieCredits: 0, charged: 0 }),
    job(3, { charged: null }),
  ] })
  await settle()
  const rows = all(root, 'tbody tr')
  const charged = i => rows[i].querySelectorAll('td')[5]
  assert.equal(text(charged(0)), '28')
  assert.equal(text(charged(1)), '0')
  assert.equal(charged(1).querySelector('span').title, 'Charged, then given back because it failed.')
  assert.equal(text(charged(2)), '—')
  assert.equal(charged(2).querySelector('.muted').title, 'Nothing was charged.')
  assert.match(text(root.querySelector('thead')), /Charged to user/)
  assert.match(text(root.querySelector('thead')), /KIE cost/)
  assert.ok(root.querySelectorAll('thead .tip').length >= 2, 'each of the two prices says what it is')
})

test('a model reads as the name an admin gave it on the Pricing page, with its id under it', async () => {
  const { root } = open({
    jobs: [job(1, { model: 'kling-3.0/video' })],
    routes: { 'GET /api/admin/prices': { prices: [{ model: 'kling-3.0/video', label: 'Kling Studio' }], unpriced: [], units: [] } },
  })
  await settle()
  const model = root.querySelectorAll('tbody tr td')[2]
  assert.equal(text(model.querySelector('.cell-main')), 'Kling Studio')
  assert.equal(text(model.querySelector('.cell-sub')), 'kling-3.0/video')
  assert.ok(all(select(root, 'Model'), 'option').some(o => o.textContent === 'Kling Studio'), 'the filter uses the name too')
})

test('why a generation failed is shown under its status, where it is read', async () => {
  const { root } = open({ jobs: [job(1, { state: 'fail', failMessage: 'The generator refused this request', kieCredits: 0 })] })
  await settle()
  const status = root.querySelectorAll('tbody tr td')[4]
  assert.match(text(status), /Failed/)
  assert.match(text(status.querySelector('.error-text')), /The generator refused this request/)
})

test('the summary counts the generations, in the singular too', async () => {
  const one = open({ jobs: [job(1)] })
  await settle()
  assert.equal(text(one.root.querySelector('[aria-live=polite]')), '1 generation')
  reset()
  const two = open({ jobs: [job(1), job(2)] })
  await settle()
  assert.equal(text(two.root.querySelector('[aria-live=polite]')), '2 generations')
})

test('the first request asks for the defaults; nonsense in the address is ignored', async () => {
  const plain = open()
  await settle()
  assert.deepEqual(lastQuery(plain.api), { state: '', model: '', userId: '', q: '', page: 1, pageSize: 25 })

  reset()
  const filtered = open({ hash: '#/jobs?state=fail&model=veo-3-1&userId=abc&q=x&page=3&pageSize=100' })
  await settle()
  assert.deepEqual(lastQuery(filtered.api), { state: 'fail', model: 'veo-3-1', userId: 'abc', q: 'x', page: 3, pageSize: 100 })

  reset()
  const bad = open({ hash: '#/jobs?state=hacked&page=-4&pageSize=7' })
  await settle()
  assert.deepEqual(lastQuery(bad.api), { state: '', model: '', userId: '', q: '', page: 1, pageSize: 25 })
})

test('the model filter lists priced models and models used without a price, once each, sorted', async () => {
  const { root } = open({ routes: { 'GET /api/admin/prices': { prices: [{ model: 'b' }, { model: 'a' }], unpriced: [{ model: 'a' }, { model: 'c' }], units: [] } } })
  await settle()
  const values = all(select(root, 'Model'), 'option').map(o => o.value)
  assert.deepEqual(values, ['', 'a', 'b', 'c'])
})

test('the model list is not cancelled by the job list loading beside it', async () => {
  // A real fetch stops the moment its signal aborts, and the job list aborts its own previous request as it
  // starts. A model request that shared that signal was cancelled every time, and the filter stayed empty.
  const { root } = open({ routes: { 'GET /api/admin/prices': async (_input, opts) => {
    await microtasks()
    if (opts?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    return { prices: [{ model: 'a' }], unpriced: [], units: [] }
  } } })
  await settle()
  assert.deepEqual(all(select(root, 'Model'), 'option').map(o => o.value), ['', 'a'])
})

test('a model in the address that is in no list is still shown in the filter', async () => {
  const { root } = open({ hash: '#/jobs?model=old-model' })
  await settle()
  assert.ok(all(select(root, 'Model'), 'option').some(o => o.value === 'old-model'))
})

test('if the model list cannot be fetched the page still works', async () => {
  const { root } = open({ routes: { 'GET /api/admin/prices': () => { throw apiError('nope', 500, 'X') } } })
  await settle()
  assert.equal(all(root, 'tbody tr').length, 2)
  assert.deepEqual(all(select(root, 'Model'), 'option').map(o => o.value), [''])
})

test('choosing a state or a model goes to page 1 with that filter; choosing "any" removes it', async () => {
  const { root, navigations } = open({ hash: '#/jobs?page=3&q=a' })
  await settle()
  change(select(root, 'Status'), 'fail')
  assert.equal(navigations.at(-1), '#/jobs?q=a&state=fail')
  change(select(root, 'Model'), 'nano-banana-pro')
  assert.equal(navigations.at(-1), '#/jobs?q=a&model=nano-banana-pro')

  reset()
  const withState = open({ hash: '#/jobs?state=fail' })
  await settle()
  assert.equal(select(withState.root, 'Status').value, 'fail')
  change(select(withState.root, 'Status'), '')
  assert.equal(withState.navigations.at(-1), '#/jobs')
})

test('the state filter offers every state KIE can report, in order', async () => {
  const { root } = open()
  await settle()
  assert.deepEqual(all(select(root, 'Status'), 'option').map(o => o.value), ['', 'waiting', 'queuing', 'generating', 'success', 'fail'])
})

test('searching waits for a pause in typing and then filters from page 1', async () => {
  const { root, navigations } = open({ hash: '#/jobs?page=2' })
  await settle()
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const input = root.querySelector('input[type=search]')
    type(input, 'ta'); mock.timers.tick(200)
    type(input, ' task-9 ')
    mock.timers.tick(299)
    assert.deepEqual(navigations, [])
    mock.timers.tick(1)
    assert.deepEqual(navigations, ['#/jobs?q=task-9'])
  } finally { mock.timers.reset() }
  await microtasks()
})

test('a job list narrowed to one account says so, and the chip removes just that filter', async () => {
  const { root, navigations } = open({ hash: `#/jobs?userId=${ID(1)}&state=fail` })
  await settle()
  const chip = root.querySelector('.chip')
  assert.match(text(chip), /One account/)
  click(chip.querySelector('button'))
  assert.equal(navigations.at(-1), '#/jobs?state=fail')

  reset()
  const none = open()
  await settle()
  assert.equal(none.root.querySelector('.chip'), null)
})

test('an empty result says why; a filtered one can be cleared in a click', async () => {
  const plain = open({ jobs: [] })
  await settle()
  assert.match(text(plain.root), /No generations yet/)
  assert.equal(plain.root.querySelector('.empty button'), null)

  reset()
  const filtered = open({ hash: `#/jobs?state=fail&model=x&userId=${ID(1)}&q=zz&page=2`, jobs: [] })
  await settle()
  assert.match(text(filtered.root), /No generations match/)
  click(filtered.root.querySelector('.empty button'))
  assert.equal(filtered.navigations.at(-1), '#/jobs')
})

test('paging moves one page at a time; the default size and page 1 stay out of the address', async () => {
  const many = Array.from({ length: 25 }, (_, i) => job(i + 1))
  const { root, navigations } = open({ hash: '#/jobs?state=fail', jobs: many, routes: { 'GET /api/admin/jobs': () => page(many, { total: 80 }) } })
  await settle()
  assert.match(text(root), /1–25 of 80/)
  click(root.querySelector('[aria-label="Next page"]'))
  assert.equal(navigations.at(-1), '#/jobs?state=fail&page=2')
  change(root.querySelector('select[aria-label="Rows per page"]'), '50')
  assert.equal(navigations.at(-1), '#/jobs?state=fail&pageSize=50')
  assert.equal(root.querySelector('[aria-label="Previous page"]').disabled, true)
})

test('a failed load shows the error with Try again, which loads again', async () => {
  let n = 0
  const { root, api } = open({ routes: { 'GET /api/admin/jobs': () => { if (++n === 1) throw apiError('Could not reach the server.', 0, 'NETWORK'); return page([job(1)]) } } })
  await settle()
  assert.match(text(root), /Could not reach the server/)
  click(byText(root, 'button', 'Try again'))
  await settle()
  assert.equal(all(root, 'tbody tr').length, 1)
  assert.equal(api.of('GET', '/api/admin/jobs').length, 2)
})

test('update: only a changed filter reloads; the older request is cancelled', async () => {
  const { api, controller } = open()
  await settle()
  controller.update(parseRoute('#/jobs'))
  await settle()
  assert.equal(api.of('GET', '/api/admin/jobs').length, 1)

  controller.update(parseRoute('#/jobs?state=fail'))
  controller.update(parseRoute('#/jobs?state=success'))
  await settle()
  const calls = api.of('GET', '/api/admin/jobs')
  assert.equal(calls.length, 3)
  assert.equal(calls[1].signal.aborted, true)
  assert.equal(calls[2].signal.aborted, false)
})

test('a slow earlier answer never replaces a later one', async () => {
  let releaseFirst
  let call = 0
  const { root, controller } = open({
    routes: {
      'GET /api/admin/jobs': () => (++call === 1 ? page([job(1)]) : call === 2 ? new Promise(r => { releaseFirst = () => r(page([job(8)])) }) : page([job(9)])),
    },
  })
  await settle()
  controller.update(parseRoute('#/jobs?q=slow'))
  controller.update(parseRoute('#/jobs?q=fast'))
  await settle()
  releaseFirst()
  await settle()
  assert.match(text(root), /user9@test\.example/)
  assert.doesNotMatch(text(root), /user8@test\.example/)
})

test('the search box follows the address when you are not typing in it', async () => {
  const { root, controller } = open({ hash: '#/jobs?q=one' })
  await settle()
  const input = root.querySelector('input[type=search]')
  assert.equal(input.value, 'one')
  controller.update(parseRoute('#/jobs?q=two'))
  await settle()
  assert.equal(input.value, 'two')
  controller.update(parseRoute('#/jobs'))
  await settle()
  assert.equal(input.value, '')
})

test('destroy cancels what is in flight', async () => {
  const { api, controller } = open()
  await settle()
  controller.destroy()
  assert.equal(api.of('GET', '/api/admin/jobs')[0].signal.aborted, true)
})

test('there is nothing on the page that changes a job: no POST is ever made, and no action buttons exist', async () => {
  const { root, api } = open()
  await settle()
  for (const b of all(root, 'tbody button')) click(b)
  await settle()
  assert.equal(api.calls.filter(c => c.method === 'POST').length, 0)
  assert.equal(byText(root, 'button', 'Retry'), null)
  assert.equal(byText(root, 'button', 'Delete'), null)
})

test('the task id has a copy button which copies the whole id, not the shortened one', async () => {
  const { root } = open({ jobs: [job(1)] })
  await settle()
  const copy = root.querySelector('tbody .copy-btn, tbody [aria-label="Copy the task id"]')
  assert.ok(copy, 'a copy control exists')
  click(copy)
  await settle()
  assert.deepEqual(navigator.clipboard.written, ['task-1-abcdefghijklmnopqrstuvwxyz'])
})

test('server text is text: hostile emails, models and failure messages build no elements', async () => {
  const { root } = open({ jobs: [job(1, { email: '<img src=x onerror=1>@x.test', model: '<b>m</b>', state: 'fail', failMessage: '<script>alert(1)</script>', taskId: '<i>t</i>' })] })
  await settle()
  assert.equal(root.querySelectorAll('tbody img, tbody script, tbody b, tbody i').length, 0)
  assert.match(text(root), /<script>alert\(1\)<\/script>/)
})
