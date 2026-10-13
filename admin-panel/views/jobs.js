/*
 * Jobs: everything anyone has asked the generator to do, and what it cost.
 *
 * Read-only on purpose. A job's state is whatever KIE says it is (the server never
 * lets anyone, admin or not, write it), so there is nothing here to edit — only to
 * find, and to read the reason when one failed.
 */

import { h, mount } from '../lib/dom.js'
import { buildRoute, intParam, oneOf, withQuery } from '../lib/router.js'
import {
  badge, button, copyButton, dataTable, debounce, emptyState, loadInto, pageHeader, pager, searchBox, selectControl, skeletonRows,
} from '../lib/components.js'
import { formatDate, formatNumber, plural, relativeTime, stateLabel, truncate } from '../lib/format.js'
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
    value: params().q, placeholder: 'Search by email or task id', label: 'Search jobs',
    onInput: debounce(value => go({ q: value.trim(), page: null }), 300),
  })
  const filters = h('div', { class: 'toolbar-item toolbar-wrap' })
  const results = h('div', { class: 'card card-flush' })
  const summary = h('span', { class: 'muted', 'aria-live': 'polite' })

  mount(container,
    pageHeader({ title: 'Jobs', subtitle: 'Every generation, with what KIE charged for it. Read-only.' }),
    h('div', { class: 'toolbar' }, search, filters, h('span', { class: 'toolbar-spacer' }), summary),
    results)

  // The model list for the filter: priced models plus any used without a price.
  let models = []
  // Its own controller: the list aborts `abort` each time it reloads, which would cancel this request too.
  const modelsAbort = new AbortController()
  const loadModels = () => api.get('/api/admin/prices', null, { signal: modelsAbort.signal })
    .then(d => { models = [...new Set([...d.prices.map(p => p.model), ...d.unpriced.map(u => u.model)])].sort(); paintFilters() })
    .catch(() => {})

  function paintFilters() {
    const p = params()
    mount(filters,
      selectControl({
        label: 'State', value: p.state, onChange: v => go({ state: v, page: null }),
        options: [{ value: '', label: 'Any state' }, ...STATES.map(s => ({ value: s, label: stateLabel(s) }))],
      }),
      selectControl({
        label: 'Model', value: p.model, onChange: v => go({ model: v, page: null }),
        options: [{ value: '', label: 'Any model' }, ...models.map(m => ({ value: m, label: m })), ...(p.model && !models.includes(p.model) ? [{ value: p.model, label: p.model }] : [])],
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
      render: data => {
        summary.textContent = plural(data.total, 'job')
        if (!data.jobs.length) {
          const filtered = Boolean(p.state || p.model || p.userId || p.q)
          mount(results, emptyState({
            iconName: filtered ? 'search' : 'jobs', title: filtered ? 'No jobs match' : 'No jobs yet',
            body: filtered ? 'Try different filters.' : 'Jobs appear here as people generate.',
            action: filtered ? button({ label: 'Clear filters', onClick: () => go({ state: null, model: null, userId: null, q: null, page: null }) }) : null,
          }))
          return
        }
        mount(results,
          dataTable({
            label: 'Jobs', rows: data.jobs,
            columns: [
              { key: 'started', label: 'Started', render: j => h('time', { datetime: j.createdAt, title: formatDate(j.createdAt) }, relativeTime(j.createdAt)) },
              { key: 'user', label: 'Account', render: j => h('a', { class: 'link', href: buildRoute('users', { id: j.userId }) }, truncate(j.email, 34)) },
              { key: 'model', label: 'Model', hideBelow: 'sm', render: j => h('span', { class: 'mono small' }, j.model || '—') },
              { key: 'kind', label: 'Kind', hideBelow: 'lg', render: j => h('span', { class: 'kind' }, icon(j.kind === 'video' ? 'video' : 'image', { size: 14 }), j.kind) },
              { key: 'state', label: 'State', render: j => badge(stateLabel(j.state), stateTone(j.state), { dot: true }) },
              { key: 'credits', label: 'KIE credits', align: 'right', render: j => (j.kieCredits === null
                ? h('span', { class: 'muted', title: j.state === 'success' || j.state === 'fail' ? 'KIE did not report a charge for this job.' : 'Not finished yet.' }, '—')
                : formatNumber(j.kieCredits)) },
              { key: 'detail', label: 'Detail', hideBelow: 'md', render: j => h('div', { class: 'job-detail' },
                j.failMessage ? h('div', { class: 'error-text small', title: j.failMessage }, truncate(j.failMessage, 80)) : null,
                h('span', { class: 'mono small muted' }, truncate(j.taskId, 22), copyButton(j.taskId, 'Copy the task id'))) },
            ],
          }),
          pager({ page: data.page, pageSize: data.pageSize, total: data.total, sizes: PAGE_SIZES, onChange: ({ page, pageSize }) => go({ page: page === 1 ? null : page, pageSize: pageSize === 25 ? null : pageSize }) }))
      },
    })
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
