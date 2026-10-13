/*
 * Overview: what needs attention, how the platform is doing, what it is costing.
 *
 * The first thing on the page is the list of things that are wrong or waiting — an
 * admin opening the panel wants "is anything on fire?" before any number. The
 * figures and the chart come after.
 */

import { h, mount } from '../lib/dom.js'
import { buildRoute } from '../lib/router.js'
import {
  barChart, barList, button, card, kpi, loadInto, pageHeader, segmented, skeletonCards,
} from '../lib/components.js'
import {
  auditLabel, byModel, dailySeries, formatCompact, formatNumber, formatPercent, plural, relativeTime,
} from '../lib/format.js'
import { icon } from '../lib/icons.js'

export const PERIODS = [7, 30, 90]

/**
 * The things worth an admin's attention right now, most urgent first.
 *
 * @param {{users: object, jobs: object, moderation: object, unpricedModels: number}} stats
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
      id: 'failures', tone: 'warning', title: `${formatPercent(failed, started)} of today's jobs failed`,
      body: `${plural(failed, 'job')} of ${formatNumber(started)} started in the last 24 hours failed.`,
      href: buildRoute('jobs', { query: { state: 'fail' } }), action: 'See failed jobs',
    })
  }

  if ((stats?.unpricedModels ?? 0) > 0) {
    items.push({
      id: 'unpriced', tone: 'info', title: `${plural(stats.unpricedModels, 'model')} in use without a price`,
      body: 'They run for free until a price is set (and billing is on).',
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
    h('span', { class: 'attention-icon' }, icon(ATTENTION_ICON[tone], { size: 22 })),
    h('div', { class: 'attention-text' }, h('div', { class: 'attention-title' }, title), h('div', { class: 'attention-body' }, body)),
    href ? h('a', { class: 'btn btn-secondary btn-sm', href }, action) : null)
  return row
}

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
    skeleton: () => skeletonCards(5),
    load: () => Promise.all([
      api.get('/api/admin/stats', null, { signal }),
      api.get('/api/admin/usage', { days }, { signal }),
      api.get('/api/admin/config', null, { signal }),
      api.get('/api/admin/audit', { pageSize: 6 }, { signal }),
    ]),
    render: ([stats, usage, config, audit]) => {
      const series = dailySeries(usage.rows, days)
      const models = byModel(usage.rows)
      const succeeded = series.reduce((n, d) => n + d.succeeded, 0)
      const failed = series.reduce((n, d) => n + d.failed, 0)
      const credits = series.reduce((n, d) => n + d.credits, 0)
      const attention = attentionItems(stats, config)

      mount(body,
        h('section', { 'aria-label': 'Needs attention' }, card({
          title: 'Needs attention', flush: true,
          subtitle: attention.length ? plural(attention.length, 'item') : 'All clear',
          body: attention.length
            ? h('ul', { class: 'attention' }, attention.map(item => attentionRow(item)))
            : h('div', { class: 'attention' }, attentionRow({
              tone: 'success', title: 'Nothing needs attention', body: 'Moderation is on, no items are waiting, and no model is running unpriced.',
            })),
        })),

        h('div', { class: 'grid grid-kpi' },
          kpi({ label: 'Accounts', value: formatNumber(stats.users.total), iconName: 'users', href: buildRoute('users'),
            hint: `${formatNumber(stats.users.new_7d)} new this week · ${formatNumber(stats.users.suspended)} suspended` }),
          kpi({ label: 'Running now', value: formatNumber(stats.jobs.running), iconName: 'jobs', href: buildRoute('jobs'), hint: 'Jobs in progress' }),
          kpi({ label: 'Started in 24 h', value: formatNumber(stats.jobs.started24h), iconName: 'clock', href: buildRoute('jobs'),
            hint: `${formatNumber(stats.jobs.failed24h)} failed`, tone: stats.jobs.failed24h ? 'warning' : null }),
          kpi({ label: 'KIE credits · 24 h', value: formatCompact(stats.jobs.credits24h), iconName: 'coins', title: `${formatNumber(stats.jobs.credits24h)} credits`,
            hint: `${formatCompact(stats.jobs.credits7d)} in 7 days · ${formatCompact(stats.jobs.credits30d)} in 30` }),
          kpi({ label: 'To review', value: formatNumber(stats.moderation.open), iconName: 'moderation', href: buildRoute('moderation'),
            tone: stats.moderation.open ? 'warning' : null, hint: `${formatNumber(stats.moderation.events24h)} events in 24 h` })),

        stats.jobs.chargeUnknown30d
          ? h('p', { class: 'note' }, icon('info', { size: 14 }), ` ${plural(stats.jobs.chargeUnknown30d, 'finished job')} in the last 30 days ${stats.jobs.chargeUnknown30d === 1 ? 'has' : 'have'} no recorded charge (KIE did not report one). The credit totals leave ${stats.jobs.chargeUnknown30d === 1 ? 'it' : 'them'} out.`)
          : null,

        h('div', { class: 'grid grid-2' },
          card({
            title: 'KIE credits per day', subtitle: `Last ${days} days (UTC) · ${formatNumber(credits)} credits · ${formatPercent(succeeded, succeeded + failed)} of jobs succeeded`,
            body: credits > 0 || succeeded + failed > 0
              ? barChart({
                label: `KIE credits per day over the last ${days} days`, height: 220,
                data: series.map(d => ({ key: d.day.slice(5), value: d.credits, title: `${d.day}: ${formatNumber(d.credits)} credits · ${d.succeeded} succeeded · ${d.failed} failed` })),
              })
              : h('p', { class: 'muted' }, 'No finished jobs in this period.'),
          }),
          card({
            title: 'Spend by model', subtitle: `Last ${days} days`,
            body: barList({
              emptyText: 'No finished jobs in this period.',
              items: models.slice(0, 8).map(m => ({
                label: m.model, value: m.credits, title: `${m.model}: ${formatNumber(m.credits)} credits`,
                sub: `${plural(m.succeeded, 'job')} succeeded${m.failed ? ` · ${m.failed} failed` : ''}`,
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

