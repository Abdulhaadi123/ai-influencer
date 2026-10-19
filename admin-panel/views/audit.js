/*
 * The audit log: who did what, when. Append-only on the server — nothing here can
 * change or remove an entry — so this page is only ever a way to read it.
 */

import { h, mount } from '../lib/dom.js'
import { intParam, oneOf, withQuery } from '../lib/router.js'
import {
  badge, copyButton, dataTable, debounce, emptyState, loadInto, pageHeader, pager, searchBox, selectControl, skeletonRows,
} from '../lib/components.js'
import { auditLabel, formatDate, formatNumber, relativeTime, signedNumber, truncate } from '../lib/format.js'

const FAMILIES = [
  { value: '', label: 'All actions' },
  { value: 'user.', label: 'Accounts' },
  { value: 'moderation.', label: 'Moderation' },
  { value: 'price.', label: 'Prices' },
  { value: 'billing.', label: 'Credits' },
]
const PAGE_SIZES = [25, 50, 100]

/**
 * An entry's details as readable [label, value] pairs, for the known actions; any
 * other action falls back to its fields as they are, so nothing is ever hidden.
 *
 * @returns {Array<[string, string]>}
 */
export function describeDetails(action, details) {
  const d = details && typeof details === 'object' ? details : {}
  const pairs = []
  const add = (label, value) => { if (value !== undefined && value !== null && value !== '') pairs.push([label, String(value)]) }

  switch (action) {
    case 'user.suspend':
      add('Account', d.email); add('Reason', d.reason); if (d.changed === false) add('Note', 'Already suspended')
      return pairs
    case 'user.unsuspend':
      add('Account', d.email); if (d.changed === false) add('Note', 'Was not suspended')
      return pairs
    case 'user.set-role':
      add('Account', d.email); add('Role', `${d.from} → ${d.to}`)
      return pairs
    case 'user.delete':
      add('Account', d.email); add('Files deleted', d.deletedObjects)
      return pairs
    case 'moderation.dismiss':
    case 'moderation.confirm':
      if (d.restored) add('Result', 'File restored to their gallery')
      if (d.blocked) add('Result', 'File blocked')
      if (d.deleted) add('Result', 'File deleted')
      if (d.suspended) add('Result', 'Account suspended')
      add('Note', d.note)
      return pairs
    case 'moderation.view-media':
      add('Item', d.eventId ? truncate(d.eventId, 13) : null)
      return pairs
    case 'price.upsert':
      add('Price', d.credits !== undefined ? `${formatNumber(d.credits)} credits ${d.unit ? d.unit.replace('per_', 'per ') : ''}`.trim() : null)
      add('Allowed', d.enabled === undefined ? null : d.enabled ? 'On' : 'Off')
      return pairs
    case 'price.delete':
      return pairs
    case 'billing.grant':
      add('Account', d.email); add('Credits', d.credits === undefined ? null : `${signedNumber(d.credits)} (${d.kind === 'adjust' ? 'taken back' : 'given'})`); add('Reason', d.note)
      return pairs
    default:
      for (const [key, value] of Object.entries(d)) add(key, value !== null && typeof value === 'object' ? JSON.stringify(value) : value)
      return pairs
  }
}

export function renderAudit(ctx) {
  const { api, container, navigate } = ctx
  let route = ctx.route
  let abort = new AbortController()
  let first = true

  const params = () => ({
    action: oneOf(route.query.action, FAMILIES.map(f => f.value), ''),
    admin: route.query.admin || '',
    page: intParam(route.query.page, 1),
    pageSize: oneOf(Number(route.query.pageSize), PAGE_SIZES, 50),
  })
  const key = () => JSON.stringify(params())
  const go = changes => navigate(withQuery(route, changes))

  const results = h('div', { class: 'card card-flush' })
  const family = h('div', { class: 'toolbar-item' })
  const search = searchBox({ value: params().admin, placeholder: 'Filter by admin email', label: 'Filter by admin', onInput: debounce(v => go({ admin: v.trim(), page: null }), 300) })

  mount(container,
    pageHeader({ title: 'Audit log', subtitle: 'Who did what in this panel, newest first: suspensions, role changes, prices, credits and moderation decisions. Entries cannot be edited or removed.' }),
    h('div', { class: 'toolbar' }, search, family),
    results)

  function load() {
    abort.abort()
    abort = new AbortController()
    const p = params()
    mount(family, selectControl({ label: 'Action', value: p.action, onChange: v => go({ action: v, page: null }), options: FAMILIES }))
    // Back and Forward change the filter; the box follows, unless it is being typed in.
    const input = search.querySelector('input')
    if (input && document.activeElement !== input && input.value !== p.admin) input.value = p.admin
    return loadInto(results, {
      signal: abort.signal,
      skeleton: () => skeletonRows(5, 8),
      load: () => api.get('/api/admin/audit', p, { signal: abort.signal }),
      render: data => {
        if (!data.entries.length) {
          mount(results, emptyState({ iconName: 'audit', title: p.action || p.admin ? 'No entries match' : 'Nothing recorded yet', body: p.action || p.admin ? 'Try different filters.' : 'Actions appear here as soon as an admin does something.' }))
          return
        }
        mount(results,
          dataTable({
            label: 'Audit log', rows: data.entries,
            columns: [
              { key: 'when', label: 'When', render: e => h('div', { class: 'nowrap' }, h('div', {}, formatDate(e.at)), h('div', { class: 'muted small' }, relativeTime(e.at))) },
              { key: 'admin', label: 'Admin', hideBelow: 'sm', render: e => e.admin },
              { key: 'action', label: 'Action', render: e => h('div', {}, h('div', {}, auditLabel(e.action)), h('div', { class: 'mono small muted' }, e.action)) },
              { key: 'target', label: 'Target', hideBelow: 'lg', render: e => (e.targetId
                ? h('div', { class: 'small' }, badge(e.targetType || 'item'), h('span', { class: 'mono muted' }, ` ${truncate(e.targetId, 14)}`), copyButton(e.targetId, 'Copy the id'))
                : h('span', { class: 'muted' }, '—')) },
              { key: 'details', label: 'Details', className: 'col-details', render: e => {
                const pairs = describeDetails(e.action, e.details)
                return pairs.length
                  ? h('dl', { class: 'detail-pairs' }, pairs.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', { title: v }, truncate(v, 90)))))
                  : h('span', { class: 'muted' }, '—')
              } },
            ],
          }),
          pager({ page: data.page, pageSize: data.pageSize, total: data.total, sizes: PAGE_SIZES, onChange: ({ page, pageSize }) => go({ page: page === 1 ? null : page, pageSize: pageSize === 50 ? null : pageSize }) }))
      },
    })
  }

  function sync(next) {
    const before = key()
    route = next
    if (first || key() !== before) load()
    first = false
  }

  sync(route)
  return { update: sync, destroy: () => abort.abort() }
}
