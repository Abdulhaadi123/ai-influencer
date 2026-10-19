/*
 * Generations: everything anyone has asked the generator to make, and what it cost.
 *
 * (The code and the address still call these "jobs"; to a person they are generations.)
 *
 * Read-only on purpose. A generation's status is whatever KIE says it is (the server never
 * lets anyone, admin or not, write it), so there is nothing here to edit — only to
 * find, and to read the reason when one failed.
 *
 * Two prices sit side by side: what the person was charged in credits, and what KIE
 * charged us. They are different currencies and the gap between them is the margin, so
 * both are shown and each says what it is.
 */

import { h, mount } from '../lib/dom.js'
import { buildRoute, intParam, oneOf, withQuery } from '../lib/router.js'
import {
  badge, button, copyButton, dataTable, debounce, emptyState, loadInto, pageHeader, pager, searchBox, selectControl, skeletonRows,
} from '../lib/components.js'
import { formatDate, formatNumber, modelName, plural, relativeTime, stateLabel, truncate } from '../lib/format.js'
import { icon } from '../lib/icons.js'

export const STATES = ['waiting', 'queuing', 'generating', 'success', 'fail']
const PAGE_SIZES = [25, 50, 100]

const stateTone = state => (state === 'success' ? 'success' : state === 'fail' ? 'danger' : 'info')

export function renderJobs(ctx) {
  const { api, container, navigate } = ctx
  let route = ctx.route
  let abort = new AbortController()
  let first = true

  const params = () => ({
    state: oneOf(route.query.state, STATES, ''),
    model: route.query.model || '',
    userId: route.query.userId || '',
    q: route.query.q || '',
    page: intParam(route.query.page, 1),
    pageSize: oneOf(Number(route.query.pageSize), PAGE_SIZES, 25),
  })
  const key = () => JSON.stringify(params())
  const go = changes => navigate(withQuery(route, changes))

  const search = searchBox({
    value: params().q, placeholder: 'Search by email or task id', label: 'Search generations',
    onInput: debounce(value => go({ q: value.trim(), page: null }), 300),
  })
  const filters = h('div', { class: 'toolbar-item toolbar-wrap' })
  const results = h('div', { class: 'card card-flush' })
  const summary = h('span', { class: 'muted', 'aria-live': 'polite' })

  mount(container,
    pageHeader({
      title: 'Generations',
      subtitle: 'Every image and video people have asked for: what it cost them in credits, and what KIE charged us. Read-only — the status is whatever KIE reports.',
    }),
    h('div', { class: 'toolbar' }, search, filters, h('span', { class: 'toolbar-spacer' }), summary),
    results)

  // The model list for the filter: priced models plus any used without a price. The names an admin gave
  // them on the Pricing page are what a row shows, with the id under it.
  let models = []
  let labels = {}
  // Its own controller: the list aborts `abort` each time it reloads, which would cancel this request too.
  const modelsAbort = new AbortController()
  const loadModels = () => api.get('/api/admin/prices', null, { signal: modelsAbort.signal })
    .then(d => {
      models = [...new Set([...d.prices.map(p => p.model), ...d.unpriced.map(u => u.model)])].sort()
      labels = Object.fromEntries(d.prices.filter(p => p.label).map(p => [p.model, p.label]))
      paintFilters()
      if (shown) paint(shown.data, shown.p)   // the rows drawn before the names arrived are drawn again with them
    })
    .catch(() => {})
  let shown = null   // what is on screen: the answer and the filters it was asked with

  function paintFilters() {
    const p = params()
    mount(filters,
      selectControl({
        label: 'Status', value: p.state, onChange: v => go({ state: v, page: null }),
        options: [{ value: '', label: 'Any status' }, ...STATES.map(s => ({ value: s, label: stateLabel(s) }))],
      }),
      selectControl({
        label: 'Model', value: p.model, onChange: v => go({ model: v, page: null }),
        options: [{ value: '', label: 'Any model' }, ...models.map(m => ({ value: m, label: modelName(m, labels) })), ...(p.model && !models.includes(p.model) ? [{ value: p.model, label: p.model }] : [])],
      }),
      p.userId ? h('span', { class: 'chip' }, icon('users', { size: 14 }), 'One account',
        h('button', { class: 'chip-x', type: 'button', 'aria-label': 'Show every account again', onclick: () => go({ userId: null, page: null }) }, icon('x', { size: 12 }))) : null)
  }

  function load() {
    abort.abort()
    abort = new AbortController()
    const p = params()
    paintFilters()
    const input = search.querySelector('input')
    if (input && document.activeElement !== input && input.value !== p.q) input.value = p.q

    return loadInto(results, {
      signal: abort.signal,
      skeleton: () => skeletonRows(6, 7),
      load: () => api.get('/api/admin/jobs', p, { signal: abort.signal }),
      render: data => { shown = { data, p }; paint(data, p) },
    })
  }

  function paint(data, p) {
    summary.textContent = plural(data.total, 'generation')
    if (!data.jobs.length) {
      const filtered = Boolean(p.state || p.model || p.userId || p.q)
      mount(results, emptyState({
        iconName: filtered ? 'search' : 'jobs', title: filtered ? 'No generations match' : 'No generations yet',
        body: filtered ? 'Try different filters.' : 'They appear here as people generate.',
        action: filtered ? button({ label: 'Clear filters', onClick: () => go({ state: null, model: null, userId: null, q: null, page: null }) }) : null,
      }))
      return
    }
    mount(results,
      dataTable({
        label: 'Generations', rows: data.jobs,
        columns: [
          { key: 'started', label: 'Started', render: j => h('time', { class: 'nowrap', datetime: j.createdAt, title: formatDate(j.createdAt) }, relativeTime(j.createdAt)) },
          { key: 'user', label: 'Account', render: j => h('a', { class: 'link cell-clip block', href: buildRoute('users', { id: j.userId }), title: j.email }, truncate(j.email, 34)) },
          { key: 'model', label: 'Model', hideBelow: 'sm', render: j => h('div', {},
            h('div', { class: 'cell-main' }, modelName(j.model, labels)),
            j.model ? h('div', { class: 'cell-sub mono' }, j.model) : null) },
          { key: 'kind', label: 'Type', hideBelow: 'lg', render: j => h('span', { class: 'kind' }, icon(j.kind === 'video' ? 'video' : 'image', { size: 14 }), j.kind === 'video' ? 'Video' : 'Image') },
          { key: 'state', label: 'Status', render: j => h('div', {},
            badge(stateLabel(j.state), stateTone(j.state), { dot: true }),
            // Why it failed, where it is seen: under the badge, so it is read without widening the table.
            j.failMessage ? h('div', { class: 'error-text small cell-clip', title: j.failMessage }, truncate(j.failMessage, 60)) : null) },
          { key: 'charged', label: 'Charged to user', align: 'right',
            tip: 'Credits taken from the person for this generation, after any refund. A dash means nothing was charged — charging was off, or it did not go through the app.',
            render: j => (j.charged === null
              ? h('span', { class: 'muted', title: 'Nothing was charged.' }, '—')
              : h('span', { class: 'delta', title: j.charged === 0 && j.state === 'fail' ? 'Charged, then given back because it failed.' : null }, formatNumber(j.charged))) },
          { key: 'credits', label: 'KIE cost', align: 'right',
            tip: 'What KIE charged us for this generation, in KIE credits.',
            render: j => (j.kieCredits === null
              ? h('span', { class: 'muted', title: j.state === 'success' || j.state === 'fail' ? 'KIE did not report a charge for this generation.' : 'Not finished yet.' }, '—')
              : formatNumber(j.kieCredits)) },
          { key: 'detail', label: 'Task', hideBelow: 'lg', tip: 'KIE’s id for this generation. Give it to KIE support if something looks wrong.', render: j => h('span', { class: 'mono small muted nowrap' }, truncate(j.taskId, 16), copyButton(j.taskId, 'Copy the task id')) },
        ],
      }),
      pager({ page: data.page, pageSize: data.pageSize, total: data.total, sizes: PAGE_SIZES, onChange: ({ page, pageSize }) => go({ page: page === 1 ? null : page, pageSize: pageSize === 25 ? null : pageSize }) }))
  }

  function sync(next) {
    const before = key()
    route = next
    if (first || key() !== before) load()
    first = false
  }

  loadModels()
  sync(route)
  return { update: sync, destroy: () => { abort.abort(); modelsAbort.abort() } }
}
