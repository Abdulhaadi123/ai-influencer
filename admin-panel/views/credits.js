/*
 * Credits: what people buy, what they spend, and what the store told us.
 *
 * People buy packs of credits in the app (a Google Play purchase, reported to us by
 * RevenueCat) and every generation then costs credits. This page answers the questions
 * an owner asks of that: how much was bought and spent, how many credits are sitting on
 * accounts, what KIE charged us meanwhile — and, when someone says "I paid and got
 * nothing", what the store actually sent and what we did with it.
 *
 * Two lists share the page:
 *
 *   Activity           every change to every balance (bought, spent, given back, given by an admin)
 *   Store deliveries   every message from the store, and its outcome. The ones that should have
 *                      become credits and did not are marked, and counted on the tab.
 *
 * Read-only: credits are given or taken on the account's own page, where the reason is recorded.
 */

import { h, mount } from '../lib/dom.js'
import { buildRoute, intParam, oneOf, withQuery } from '../lib/router.js'
import {
  badge, barChart, button, callout, card, chartLegend, dataTable, debounce, emptyState, kpi, loadInto, pageHeader, pager,
  searchBox, segmented, selectControl, skeletonCards, skeletonRows, tabs,
} from '../lib/components.js'
import {
  creditKindLabel, creditSeries, environmentLabel, formatDate, formatNumber, outcomeLabel, plural, relativeTime, signedNumber, truncate,
} from '../lib/format.js'
import { icon } from '../lib/icons.js'

export const PERIODS = [7, 30, 90]
const PAGE_SIZES = [25, 50, 100]
const KINDS = ['purchase', 'spend', 'refund', 'grant', 'adjust', 'clawback']
const OUTCOMES = ['credited', 'clawed_back', 'duplicate', 'ignored', 'unmatched', 'sandbox_off', 'test']
const TABS = ['activity', 'store']

/** The colour of a delivery's outcome: green when credits arrived, red when someone paid and they did not. */
export function outcomeTone(outcome, problem) {
  if (outcome === 'credited') return 'success'
  if (problem) return outcome === 'sandbox_off' ? 'warning' : 'danger'
  if (outcome === 'clawed_back') return 'warning'
  return 'neutral'
}

const deltaClass = delta => ['delta', delta > 0 ? 'delta-up' : 'delta-down']

export function renderCredits(ctx) {
  const { api, container, navigate } = ctx
  let route = ctx.route
  let summaryAbort = new AbortController()
  let listAbort = new AbortController()
  let problems = null      // store deliveries to look into, for the tab's count
  let first = true

  const params = () => ({
    days: PERIODS.includes(Number(route.query.days)) ? Number(route.query.days) : 30,
    tab: oneOf(route.query.tab, TABS, 'activity'),
    kind: oneOf(route.query.kind, KINDS, ''),
    q: route.query.q || '',
    userId: route.query.userId || '',
    outcome: oneOf(route.query.outcome, OUTCOMES, ''),
    problems: route.query.problems === '1',
    page: intParam(route.query.page, 1),
    pageSize: oneOf(Number(route.query.pageSize), PAGE_SIZES, 25),
  })
  const summaryKey = () => String(params().days)
  const listKey = () => { const { days: _days, ...rest } = params(); return JSON.stringify(rest) }
  const go = changes => navigate(withQuery(route, changes))

  const periodBox = h('div')
  const summaryBox = h('div', { class: 'stack' })
  const tabsBox = h('div')
  const toolbarBox = h('div', { class: 'toolbar toolbar-below-tabs' })
  const results = h('div', { class: 'card card-flush' })

  // The search box is built once, so typing in it never loses focus to a re-render.
  const search = searchBox({
    value: params().q, placeholder: 'Search by account email', label: 'Search credit activity',
    onInput: debounce(value => go({ q: value.trim(), page: null }), 300),
  })

  mount(container,
    pageHeader({
      title: 'Credits',
      subtitle: 'What people buy and spend. Packs are sold through the Play Store (reported by RevenueCat); every generation then costs credits.',
      actions: [periodBox],
    }),
    summaryBox,
    h('div', { class: 'stack-sm' }, tabsBox, toolbarBox, results))

  // ── The period ─────────────────────────────────────────────────────────────
  function paintPeriod() {
    mount(periodBox, segmented({
      label: 'Period', value: params().days,
      options: PERIODS.map(d => ({ value: d, label: `${d} days` })),
      onChange: d => go({ days: d === 30 ? null : d }),
    }))
  }

  // ── The summary ────────────────────────────────────────────────────────────
  function loadSummary() {
    summaryAbort.abort()
    summaryAbort = new AbortController()
    const { signal } = summaryAbort
    const { days } = params()
    paintPeriod()
    return loadInto(summaryBox, {
      signal,
      skeleton: () => skeletonCards(4),
      load: () => Promise.all([
        api.get('/api/admin/billing/summary', { days }, { signal }),
        api.get('/api/admin/billing/store-events', { problems: 1, pageSize: 1 }, { signal }),
      ]),
      render: ([s, bad]) => {
        problems = bad.total
        paintTabs()
        const w = s.window
        const series = creditSeries(s.series, days)
        mount(summaryBox,
          s.enforced
            ? null
            : callout({
              tone: 'warning', title: 'Charging is off — generations are free for now',
              body: 'Purchases and gifts still add credits, but nothing is taken when someone generates, so “Credits spent” stays at 0. Turn charging on with BILLING_ENFORCED=true once prices are set (see Settings).',
            }),

          h('div', { class: 'grid grid-kpi' },
            kpi({
              label: 'Credits bought', value: formatNumber(w.purchased), unit: 'credits', iconName: 'coins',
              tip: 'Credits added by store purchases in this period. Test purchases count too — the Store deliveries list says which were test and which were live.',
              hint: `${plural(w.purchases, 'purchase')} by ${plural(w.purchasers, 'person', 'people')}${w.clawedBack ? ` · ${formatNumber(w.clawedBack)} taken back after refunds` : ''}`,
            }),
            kpi({
              label: 'Credits spent', value: formatNumber(w.spent), unit: 'credits', iconName: 'jobs',
              tip: 'Credits people used on generations in this period, before refunds.',
              hint: w.refunded ? `${formatNumber(w.refunded)} given back for failed generations` : 'None given back',
            }),
            kpi({
              label: 'Held by people', value: formatNumber(s.holding.held), unit: 'credits', iconName: 'users',
              tip: 'Every credit sitting on an account right now (not limited to the period): what people could still spend.',
              hint: `${plural(s.holding.holders, 'account')} hold credits${s.holding.owing ? ` · ${formatNumber(s.holding.owed)} owed by ${plural(s.holding.owing, 'account')}` : ''}`,
            }),
            kpi({
              label: 'KIE charged us', value: formatNumber(s.providerCost), unit: 'KIE credits', iconName: 'clock',
              tip: 'What KIE billed us for generations that finished in this period. Compare it with “Credits spent”; the price list decides the gap.',
              hint: 'For the same period',
            })),

          h('div', { class: 'grid grid-2' },
            card({
              title: 'Bought and spent per day', subtitle: `Last ${days} days (UTC)`,
              body: w.purchased > 0 || w.spent > 0
                ? h('div', {}, chartLegend([{ label: 'Credits bought' }, { label: 'Credits spent', second: true }]),
                  barChart({
                    label: `Credits bought and spent per day over the last ${days} days`, height: 200,
                    data: series.map(d => ({
                      key: d.day.slice(5), value: d.purchased, value2: d.spent,
                      title: `${d.day}: ${formatNumber(d.purchased)} bought · ${formatNumber(d.spent)} spent`,
                    })),
                  }))
                : h('p', { class: 'muted' }, 'Nothing was bought or spent in this period.'),
            }),
            card({
              title: 'Packs sold', subtitle: `Last ${days} days`, flush: true,
              body: s.packs.length
                ? dataTable({
                  label: 'Packs sold', rows: s.packs, rowKey: p => `${p.productId}|${p.environment}`,
                  columns: [
                    // The pack, its id, and whether it was bought for real or as a test — one cell, so the table fits its card.
                    { key: 'pack', label: 'Pack', render: p => h('div', {},
                      h('div', { class: 'cell-main' }, p.label || p.productId),
                      h('div', { class: 'cell-sub pack-meta' },
                        p.label ? h('span', { class: 'mono' }, p.productId) : null,
                        badge(environmentLabel(p.environment), String(p.environment).toUpperCase() === 'PRODUCTION' ? 'success' : 'warning', { title: String(p.environment).toUpperCase() === 'PRODUCTION' ? 'Paid with real money' : 'A test purchase: nobody was charged' }))) },
                    { key: 'sold', label: 'Sold', align: 'right', render: p => formatNumber(p.purchases) },
                    { key: 'credits', label: 'Credits', align: 'right', render: p => formatNumber(p.credits) },
                  ],
                })
                : h('p', { class: 'muted pad' }, 'No packs were sold in this period.'),
            })))
      },
    })
  }

  // ── The lists ──────────────────────────────────────────────────────────────
  function paintTabs() {
    const p = params()
    mount(tabsBox, tabs({
      label: 'Credits lists', value: p.tab,
      items: [
        { id: 'activity', label: 'Activity' },
        { id: 'store', label: 'Store deliveries', count: problems || undefined, alert: problems > 0 },
      ],
      onChange: id => go({ tab: id === 'activity' ? null : id, page: null, kind: null, q: null, outcome: null, problems: null, userId: null }),
    }))
  }

  function paintToolbar() {
    const p = params()
    const input = search.querySelector('input')
    if (input && document.activeElement !== input && input.value !== p.q) input.value = p.q
    if (p.tab === 'store') {
      mount(toolbarBox,
        segmented({
          label: 'Which deliveries', value: p.problems ? 'problems' : 'all',
          options: [{ value: 'all', label: 'All deliveries' }, { value: 'problems', label: 'Needs a look' }],
          onChange: v => go({ problems: v === 'problems' ? '1' : null, page: null }),
        }),
        selectControl({
          label: 'Result', value: p.outcome, onChange: v => go({ outcome: v, page: null }),
          options: [{ value: '', label: 'Any result' }, ...OUTCOMES.map(o => ({ value: o, label: outcomeLabel(o) }))],
        }),
        h('span', { class: 'toolbar-spacer' }))
    } else {
      mount(toolbarBox,
        search,
        selectControl({
          label: 'Kind', value: p.kind, onChange: v => go({ kind: v, page: null }),
          options: [{ value: '', label: 'Every kind' }, ...KINDS.map(k => ({ value: k, label: creditKindLabel(k) }))],
        }),
        p.userId ? h('span', { class: 'chip' }, icon('users', { size: 14 }), 'One account',
          h('button', { class: 'chip-x', type: 'button', 'aria-label': 'Show every account again', onclick: () => go({ userId: null, page: null }) }, icon('x', { size: 12 }))) : null,
        h('span', { class: 'toolbar-spacer' }))
    }
  }

  const when = iso => h('time', { class: 'nowrap', datetime: iso, title: formatDate(iso) }, relativeTime(iso))
  const accountLink = (userId, email) => (userId && email
    ? h('a', { class: 'link cell-clip block', href: buildRoute('users', { id: userId }), title: email }, email)
    : h('span', { class: 'muted' }, 'No account'))

  function loadList() {
    listAbort.abort()
    listAbort = new AbortController()
    const { signal } = listAbort
    const p = params()
    paintTabs()
    paintToolbar()

    const store = p.tab === 'store'
    const path = store ? '/api/admin/billing/store-events' : '/api/admin/billing/activity'
    const query = store
      ? { outcome: p.outcome, problems: p.problems ? 1 : null, page: p.page, pageSize: p.pageSize }
      : { kind: p.kind, q: p.q, userId: p.userId, page: p.page, pageSize: p.pageSize }

    return loadInto(results, {
      signal,
      skeleton: () => skeletonRows(5, 7),
      load: () => api.get(path, query, { signal }),
      render: data => {
        const rows = store ? data.events : data.entries
        if (!rows.length) {
          const filtered = store ? Boolean(p.outcome || p.problems) : Boolean(p.kind || p.q || p.userId)
          mount(results, emptyState({
            iconName: filtered ? 'search' : 'coins',
            title: filtered ? 'Nothing matches' : store ? 'No store deliveries yet' : 'No credit activity yet',
            body: filtered
              ? (store && p.problems ? 'Nothing needs a look. Every purchase the store told us about became credits.' : 'Try different filters.')
              : store ? 'When someone buys a pack, the store tells us and it appears here.' : 'Purchases, gifts and generations appear here.',
            action: filtered ? button({ label: 'Clear filters', onClick: () => go({ kind: null, q: null, userId: null, outcome: null, problems: null, page: null }) }) : null,
          }))
          return
        }

        const table = store
          ? dataTable({
            label: 'Store deliveries', rows,
            columns: [
              { key: 'when', label: 'When', render: e => when(e.receivedAt) },
              { key: 'product', label: 'Product', render: e => h('span', { class: 'mono cell-clip block', title: e.productId || '' }, e.productId || '—') },
              { key: 'where', label: 'Where', hideBelow: 'sm', render: e => (e.environment ? badge(environmentLabel(e.environment), String(e.environment).toUpperCase() === 'PRODUCTION' ? 'success' : 'warning', { title: String(e.environment).toUpperCase() === 'PRODUCTION' ? 'Paid with real money' : 'A test purchase: nobody was charged' }) : h('span', { class: 'muted' }, '—')) },
              { key: 'result', label: 'Result', render: e => badge(outcomeLabel(e.outcome, e.problem, e.type), outcomeTone(e.outcome, e.problem), { dot: true, title: e.problem ? (e.type === 'INITIAL_PURCHASE' || e.type === 'RENEWAL' ? 'Someone paid for a subscription. We sell credit packs, not subscriptions, so they got nothing. Look into it.' : 'Someone paid and the credits did not arrive. Look into it.') : null }) },
              { key: 'credits', label: 'Credits', align: 'right', render: e => (e.credits === null ? h('span', { class: 'muted' }, '—') : h('span', { class: deltaClass(e.outcome === 'clawed_back' ? -1 : 1) }, signedNumber(e.outcome === 'clawed_back' ? -e.credits : e.credits))) },
              { key: 'account', label: 'Account', hideBelow: 'md', render: e => accountLink(e.userId, e.email) },
              { key: 'txn', label: 'Transaction', hideBelow: 'lg', render: e => h('span', { class: 'mono cell-clip block muted', title: e.transactionId || '' }, truncate(e.transactionId || '—', 26)) },
            ],
          })
          : dataTable({
            label: 'Credit activity', rows,
            columns: [
              { key: 'when', label: 'When', render: e => when(e.createdAt) },
              { key: 'account', label: 'Account', render: e => accountLink(e.userId, e.email) },
              { key: 'what', label: 'What happened', render: e => h('div', {}, h('div', { class: 'cell-main' }, creditKindLabel(e.kind)), e.model ? h('div', { class: 'cell-sub mono' }, e.model) : null) },
              { key: 'delta', label: 'Credits', align: 'right', render: e => h('span', { class: deltaClass(e.delta) }, signedNumber(e.delta)) },
              { key: 'note', label: 'Note', hideBelow: 'md', render: e => (e.note || e.by
                ? h('div', { class: 'cell-clip note-clip', title: e.note || '' }, truncate(e.note || '', 70), e.by ? h('span', { class: 'muted' }, `${e.note ? ' · ' : ''}by ${e.by}`) : null)
                : h('span', { class: 'muted' }, '—')) },
            ],
          })

        mount(results, table,
          pager({ page: data.page, pageSize: data.pageSize, total: data.total, sizes: PAGE_SIZES, onChange: ({ page, pageSize }) => go({ page: page === 1 ? null : page, pageSize: pageSize === 25 ? null : pageSize }) }))
      },
    })
  }

  function sync(next) {
    const beforeSummary = summaryKey()
    const beforeList = listKey()
    route = next
    if (first || summaryKey() !== beforeSummary) loadSummary()
    if (first || listKey() !== beforeList) loadList()
    first = false
  }

  sync(route)
  return { update: sync, destroy: () => { summaryAbort.abort(); listAbort.abort() } }
}
