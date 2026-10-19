/*
 * Overview: what needs attention, how the platform is doing, how the credits are moving.
 *
 * The first thing on the page is the list of things that are wrong or waiting — an
 * admin opening the panel wants "is anything on fire?" before any number. Then two
 * rows of figures, each with a heading that says what it is about (the platform;
 * the credits), and the chart of what generations cost.
 */

import { h, mount } from '../lib/dom.js'
import { buildRoute } from '../lib/router.js'
import {
  barChart, barList, button, card, kpi, loadInto, pageHeader, segmented, skeletonCards,
} from '../lib/components.js'
import {
  auditLabel, byModel, dailySeries, formatCompact, formatNumber, formatPercent, modelName, plural, relativeTime,
} from '../lib/format.js'
import { icon } from '../lib/icons.js'

export const PERIODS = [7, 30, 90]

/**
 * The things worth an admin's attention right now, most urgent first.
 *
 * @param {{users: object, jobs: object, moderation: object, unpricedModels: number, billingProblems30d?: number}} stats
 * @param {{moderation: {enabled: boolean, checkerConfigured: boolean, failMode: string, thresholdsProblem?: string|null}, kie: {callbacksConfigured: boolean}}} config
 * @returns {Array<{id: string, tone: 'danger'|'warning'|'info', title: string, body: string, href?: string, action?: string}>}
 */
export function attentionItems(stats, config) {
  const items = []
  const mod = config?.moderation

  if (mod && !mod.enabled) {
    items.push({
      id: 'moderation-off', tone: 'danger', title: 'Content moderation is off',
      body: mod.checkerConfigured
        ? 'It was switched off with MODERATION_ENABLED=false. Prompts, uploads and results are not being checked.'
        : 'No OPENAI_API_KEY is set on the server, so prompts, uploads and results are not being checked.',
      href: buildRoute('settings'), action: 'See settings',
    })
  } else if (mod && !mod.checkerConfigured) {
    items.push({
      id: 'moderation-no-key', tone: 'danger', title: 'Moderation is on but has no key',
      body: mod.failMode === 'closed'
        ? 'Every generation request will be refused until OPENAI_API_KEY is set.'
        : 'Nothing is being checked (fail-open) until OPENAI_API_KEY is set.',
      href: buildRoute('settings'), action: 'See settings',
    })
  }
  if (mod?.thresholdsProblem) {
    items.push({ id: 'thresholds', tone: 'warning', title: 'The moderation thresholds setting is invalid', body: `${mod.thresholdsProblem} The defaults are in use.`, href: buildRoute('settings'), action: 'See settings' })
  }

  // Someone paid and the credits did not arrive: the most expensive kind of silence.
  const billing = stats?.billingProblems30d ?? 0
  if (billing > 0) {
    items.push({
      id: 'billing-problems', tone: 'danger', title: `${plural(billing, 'store purchase')} did not become credits`,
      body: 'Someone paid, or tried to, and no credits were added: an unknown account, an unrecognised product, or a test purchase while those are off. See what the store sent.',
      href: buildRoute('credits', { query: { tab: 'store', problems: 1 } }), action: 'Look into it',
    })
  }

  const open = stats?.moderation?.open ?? 0
  if (open > 0) {
    items.push({
      id: 'moderation-open', tone: stats.moderation.openBlocked > 0 ? 'warning' : 'info',
      title: `${plural(open, 'moderation item')} waiting for review`,
      body: stats.moderation.openBlocked > 0
        ? `${plural(stats.moderation.openBlocked, 'of them was', 'of them were')} refused automatically — check the checker was right.`
        : 'Held back or reported; nothing has been refused yet.',
      href: buildRoute('moderation'), action: 'Review',
    })
  }

  const started = stats?.jobs?.started24h ?? 0
  const failed = stats?.jobs?.failed24h ?? 0
  if (started >= 10 && failed / started >= 0.3) {
    items.push({
      id: 'failures', tone: 'warning', title: `${formatPercent(failed, started)} of today's generations failed`,
      body: `${plural(failed, 'generation')} of ${formatNumber(started)} started in the last 24 hours failed.`,
      href: buildRoute('jobs', { query: { state: 'fail' } }), action: 'See failed ones',
    })
  }

  if ((stats?.unpricedModels ?? 0) > 0) {
    items.push({
      id: 'unpriced', tone: 'info', title: `${plural(stats.unpricedModels, 'model')} in use without a price`,
      body: 'People can use them, but they cost no credits. Set a price on the Pricing page.',
      href: buildRoute('prices'), action: 'Set prices',
    })
  }
  if (config?.kie && !config.kie.callbacksConfigured) {
    items.push({
      id: 'callbacks', tone: 'info', title: 'Generation callbacks are off',
      body: 'Results are collected by the worker within a minute or so instead of within seconds. Set KIE_WEBHOOK_SECRET and PUBLIC_BASE_URL to turn them on.',
      href: buildRoute('settings'), action: 'See settings',
    })
  }
  return items
}

const ATTENTION_ICON = Object.freeze({ danger: 'alert', warning: 'alert', info: 'info', success: 'check' })

/** One row of the "needs attention" list: a tinted icon, what is wrong, and where to deal with it. */
function attentionRow({ tone, title, body, href = null, action = null }) {
  const row = h(href ? 'li' : 'div', { class: ['attention-item', `attention-${tone}`] },
    h('span', { class: 'attention-icon' }, icon(ATTENTION_ICON[tone], { size: 18 })),
    h('div', { class: 'attention-text' }, h('div', { class: 'attention-title' }, title), h('div', { class: 'attention-body' }, body)),
    href ? h('a', { class: 'btn btn-secondary btn-sm', href }, action) : null)
  return row
}

/** A heading for a run of figures: what they are about, and a line of what they cover. */
const sectionHead = (title, hint = null) => h('div', { class: 'section-head-row' }, h('h2', { class: 'section-title' }, title), hint ? h('span', { class: 'section-hint' }, hint) : null)

export async function renderOverview(ctx) {
  const { api, container, route, navigate, signal } = ctx
  const days = PERIODS.includes(Number(route.query.days)) ? Number(route.query.days) : 30

  const body = h('div', { class: 'stack' })
  const refresh = () => navigate(buildRoute('overview', { query: { days: days === 30 ? null : days } }), { force: true })

  mount(container,
    pageHeader({
      title: 'Overview',
      subtitle: 'How the platform is doing, and what needs you.',
      actions: [
        segmented({
          label: 'Period', value: days,
          options: PERIODS.map(d => ({ value: d, label: `${d} days` })),
          onChange: d => navigate(buildRoute('overview', { query: { days: d === 30 ? null : d } })),
        }),
        button({ label: 'Refresh', iconName: 'refresh', onClick: refresh }),
      ],
    }),
    body)

  await loadInto(body, {
    signal,
    skeleton: () => skeletonCards(4),
    load: () => Promise.all([
      api.get('/api/admin/stats', null, { signal }),
      api.get('/api/admin/usage', { days }, { signal }),
      api.get('/api/admin/config', null, { signal }),
      api.get('/api/admin/audit', { pageSize: 6 }, { signal }),
      // The credits row is a bonus: if it cannot be read, the rest of the page still shows.
      api.get('/api/admin/billing/summary', { days }, { signal }).catch(e => { if (e?.name === 'AbortError') throw e; return null }),
      // The pricing page's labels, so a model reads as a name and not only an id.
      api.get('/api/admin/prices', null, { signal }).then(d => Object.fromEntries(d.prices.filter(p => p.label).map(p => [p.model, p.label]))).catch(e => { if (e?.name === 'AbortError') throw e; return {} }),
    ]),
    render: ([stats, usage, config, audit, credits, labels]) => {
      const series = dailySeries(usage.rows, days)
      const models = byModel(usage.rows)
      const succeeded = series.reduce((n, d) => n + d.succeeded, 0)
      const failed = series.reduce((n, d) => n + d.failed, 0)
      const cost = series.reduce((n, d) => n + d.credits, 0)
      const attention = attentionItems(stats, config)
      const creditsLink = buildRoute('credits', { query: { days: days === 30 ? null : days } })

      mount(body,
        h('section', { 'aria-label': 'Needs attention' }, card({
          title: 'Needs attention', flush: true,
          subtitle: attention.length ? plural(attention.length, 'item') : 'All clear',
          body: attention.length
            ? h('ul', { class: 'attention' }, attention.map(item => attentionRow(item)))
            : h('div', { class: 'attention' }, attentionRow({
              tone: 'success', title: 'Nothing needs attention', body: 'Moderation is on, no items are waiting, and every model in use has a price.',
            })),
        })),

        h('section', { 'aria-label': 'The platform' },
          sectionHead('The platform', 'People and generations'),
          h('div', { class: 'grid grid-kpi' },
            kpi({ label: 'Accounts', value: formatNumber(stats.users.total), iconName: 'users', href: buildRoute('users'),
              tip: 'Everyone who has signed up.',
              hint: `${formatNumber(stats.users.new_7d)} new this week · ${formatNumber(stats.users.suspended)} suspended` }),
            kpi({ label: 'Generating now', value: formatNumber(stats.jobs.running), iconName: 'jobs', href: buildRoute('jobs'),
              tip: 'Generations that have started and are not finished yet.',
              hint: stats.jobs.running === 1 ? 'generation in progress' : 'generations in progress' }),
            kpi({ label: 'Started in 24 h', value: formatNumber(stats.jobs.started24h), iconName: 'clock', href: buildRoute('jobs'),
              tip: 'Generations people asked for in the last 24 hours, whatever happened to them.',
              hint: `${formatNumber(stats.jobs.failed24h)} failed`, tone: stats.jobs.failed24h ? 'warning' : null }),
            kpi({ label: 'To review', value: formatNumber(stats.moderation.open), iconName: 'moderation', href: buildRoute('moderation'),
              tip: 'Content the safety checker held back or refused, or that a user reported, which nobody has decided on yet.',
              tone: stats.moderation.open ? 'warning' : null, hint: `${formatNumber(stats.moderation.events24h)} flagged in 24 h` }))),

        credits
          ? h('section', { 'aria-label': 'Credits' },
            sectionHead(`Credits · last ${days} days`, 'What people bought and spent'),
            h('div', { class: 'grid grid-kpi' },
              kpi({ label: 'Credits bought', value: formatCompact(credits.window.purchased), iconName: 'coins', href: creditsLink,
                title: `${formatNumber(credits.window.purchased)} credits`,
                tip: 'Credits added by store purchases in this period (test purchases included).',
                hint: `${plural(credits.window.purchases, 'purchase')} by ${plural(credits.window.purchasers, 'person', 'people')}` }),
              kpi({ label: 'Credits spent', value: formatCompact(credits.window.spent), iconName: 'jobs', href: creditsLink,
                title: `${formatNumber(credits.window.spent)} credits`,
                tip: 'Credits people used on generations in this period.',
                hint: !credits.enforced && credits.window.spent === 0 ? 'Charging is off, so nothing is spent yet' : `${formatNumber(credits.window.refunded)} given back after failures` }),
              kpi({ label: 'Held by people', value: formatCompact(credits.holding.held), iconName: 'users', href: creditsLink,
                title: `${formatNumber(credits.holding.held)} credits`,
                tip: 'Every credit sitting on an account right now. What people could still spend.',
                hint: `across ${plural(credits.holding.holders, 'account')}` }),
              kpi({ label: 'KIE charged us', value: formatCompact(credits.providerCost), iconName: 'clock', href: creditsLink,
                title: `${formatNumber(credits.providerCost)} KIE credits`,
                tip: 'What KIE billed us for generations that finished in this period, in KIE credits. Compare it with “Credits spent”.',
                hint: `${formatCompact(stats.jobs.credits24h)} of it in the last 24 h` })))
          : null,

        stats.jobs.chargeUnknown30d
          ? h('p', { class: 'note' }, icon('info', { size: 14 }), ` ${plural(stats.jobs.chargeUnknown30d, 'finished generation')} in the last 30 days ${stats.jobs.chargeUnknown30d === 1 ? 'has' : 'have'} no recorded KIE charge (KIE did not report one). The totals leave ${stats.jobs.chargeUnknown30d === 1 ? 'it' : 'them'} out.`)
          : null,

        h('div', { class: 'grid grid-2' },
          card({
            title: 'What generations cost us, per day', subtitle: `Last ${days} days (UTC) · ${formatNumber(cost)} KIE credits · ${formatPercent(succeeded, succeeded + failed)} of generations succeeded`,
            body: cost > 0 || succeeded + failed > 0
              ? barChart({
                label: `KIE credits per day over the last ${days} days`, height: 200,
                data: series.map(d => ({ key: d.day.slice(5), value: d.credits, title: `${d.day}: ${formatNumber(d.credits)} KIE credits · ${d.succeeded} succeeded · ${d.failed} failed` })),
              })
              : h('p', { class: 'muted' }, 'No finished generations in this period.'),
          }),
          card({
            title: 'Cost by model', subtitle: `Last ${days} days · KIE credits`,
            body: barList({
              emptyText: 'No finished generations in this period.',
              items: models.slice(0, 8).map(m => ({
                label: modelName(m.model, labels), value: m.credits, title: `${m.model}: ${formatNumber(m.credits)} KIE credits`,
                sub: `${plural(m.succeeded, 'generation')} succeeded${m.failed ? ` · ${m.failed} failed` : ''}`,
              })),
            }),
          })),

        card({
          title: 'Recent admin activity', actions: h('a', { class: 'btn btn-ghost btn-sm', href: buildRoute('audit') }, 'View all'),
          flush: true,
          body: audit.entries.length
            ? h('ul', { class: 'activity' }, audit.entries.map(entry => h('li', { class: 'activity-item' },
              h('span', { class: 'activity-dot', 'aria-hidden': 'true' }),
              h('div', { class: 'activity-text' }, h('strong', {}, entry.admin), ' — ', auditLabel(entry.action)),
              h('time', { class: 'muted', datetime: entry.at, title: entry.at }, relativeTime(entry.at)))))
            : h('p', { class: 'muted pad' }, 'Nothing has been recorded yet.'),
        }))
    },
  })
}
