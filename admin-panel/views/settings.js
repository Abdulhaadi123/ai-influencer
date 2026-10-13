/*
 * Settings: how this server is set up, read-only.
 *
 * Nothing here can be changed from the panel — these are environment variables,
 * set where the server runs (backend/.env.example says what each does), and a change
 * takes a restart. The page exists so "why is nothing being checked?" has an answer
 * that does not need shell access.
 */

import { h, mount } from '../lib/dom.js'
import { badge, callout, card, loadInto, pageHeader, skeletonRows } from '../lib/components.js'
import { categoryLabel } from '../lib/format.js'

/** A row of the settings table: a name, a value, and what to do about it. */
function row(label, value, hint = null) {
  return h('div', { class: 'setting' },
    h('div', { class: 'setting-name' }, label, hint ? h('div', { class: 'muted small' }, hint) : null),
    h('div', { class: 'setting-value' }, value))
}

const yesNo = (value, goodWhen = true) => badge(value ? 'Yes' : 'No', value === goodWhen ? 'success' : 'danger', { dot: true })

/**
 * The thresholds as rows: the category and the two numbers, or "ignored".
 *
 * @returns {Array<{category: string, label: string, review: number|null, block: number|null, ignored: boolean}>}
 */
export function thresholdRows(thresholds) {
  return Object.entries(thresholds || {}).map(([category, rule]) => ({
    category, label: categoryLabel(category), ignored: rule === false,
    review: rule && typeof rule.review === 'number' ? rule.review : null,
    block: rule && typeof rule.block === 'number' ? rule.block : null,
  }))
}

/** Credits: whether they are charged, and whether a purchase can reach us. */
function creditsCard(b) {
  return card({
    title: 'Credits', subtitle: 'Prepaid packs, spent per generation, never expiring.',
    body: h('div', { class: 'settings' },
      row('Charging for generations', badge(b.enforced ? 'On' : 'Off: watching only', b.enforced ? 'success' : 'warning', { dot: true }),
        'BILLING_ENFORCED. While it is off nothing is taken and nobody is stopped; the server log says who would have been.'),
      row('Purchases can be credited', yesNo(b.webhookConfigured), 'REVENUECAT_WEBHOOK_AUTH. Without it every RevenueCat delivery is refused, so no purchase adds credits.'),
      row('Test purchases are credited', badge(b.acceptSandbox ? 'Yes' : 'No', b.acceptSandbox ? 'warning' : 'success', { dot: true }),
        'REVENUECAT_ACCEPT_SANDBOX. Fine while testing; set it to false once real sales start.')),
  })
}

export function renderSettings(ctx) {
  const { api, container, signal } = ctx
  const body = h('div', { class: 'stack' })
  mount(container, pageHeader({ title: 'Settings', subtitle: 'How the server is configured. Read-only: these are set with environment variables.' }), body)

  loadInto(body, {
    signal,
    skeleton: () => skeletonRows(2, 8),
    load: () => api.get('/api/admin/config', null, { signal }),
    render: config => {
      const m = config.moderation
      mount(body,
        !m.enabled ? callout({ tone: 'danger', title: 'Content moderation is off', body: m.checkerConfigured ? 'Switched off with MODERATION_ENABLED=false.' : 'There is no OPENAI_API_KEY on the server.' }) : null,
        config.billing?.enforced && !config.billing.webhookConfigured
          ? callout({ tone: 'danger', title: 'Credits are charged but purchases cannot be credited', body: 'BILLING_ENFORCED is on and REVENUECAT_WEBHOOK_AUTH is not set, so every RevenueCat delivery is refused: people who buy a pack get nothing.' })
          : null,
        m.thresholdsProblem ? callout({ tone: 'warning', title: 'MODERATION_THRESHOLDS is invalid', body: `${m.thresholdsProblem} The default thresholds are in use.` }) : null,

        card({
          title: 'Content moderation', subtitle: 'Prompts, uploads and results are checked before and after generation.',
          body: h('div', { class: 'settings' },
            row('Checking content', yesNo(m.enabled)),
            row('Checker key configured', yesNo(m.checkerConfigured), 'OPENAI_API_KEY'),
            row('When the checker is down', badge(m.failMode === 'closed' ? 'Refuse the request' : 'Let it through', m.failMode === 'closed' ? 'success' : 'warning'), 'MODERATION_FAIL_MODE. Results already paid for are never withheld.'),
            row('Model', h('span', { class: 'mono small' }, m.model)),
            row('Strikes before suspension', `${m.strikeLimit} within ${m.strikeWindowDays} days`, 'MODERATION_STRIKE_LIMIT, MODERATION_STRIKE_WINDOW_DAYS'),
            row('Suspend at once for minors', yesNo(m.suspendOnMinors), 'MODERATION_SUSPEND_ON_MINORS'),
            row('Frames checked per video', String(m.videoFrames), 'MODERATION_VIDEO_FRAMES')),
        }),

        card({
          title: 'Thresholds', subtitle: 'A score at or above “review” holds an item for a person; at or above “refuse” it is refused.', flush: true,
          body: h('div', { class: 'table-wrap' }, h('table', { class: 'table', 'aria-label': 'Moderation thresholds' },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Category'), h('th', { scope: 'col', class: 'num' }, 'Review at'), h('th', { scope: 'col', class: 'num' }, 'Refuse at'))),
            h('tbody', {}, thresholdRows(m.thresholds).map(r => h('tr', {},
              h('td', {}, r.label, r.category === 'sexual/minors' ? badge('Always on', 'accent') : null),
              h('td', { class: 'num' }, r.ignored ? badge('Ignored', 'neutral') : r.review ?? '—'),
              h('td', { class: 'num' }, r.ignored ? badge('Ignored', 'neutral') : r.block ?? '—')))))),
        }),

        card({
          title: 'Generation (KIE)',
          body: h('div', { class: 'settings' },
            row('Generation callbacks', yesNo(config.kie.callbacksConfigured), 'KIE_WEBHOOK_SECRET and PUBLIC_BASE_URL. Without them results arrive via the worker, within a minute or so.'),
            row('KIE’s own filter (nsfw_checker)', yesNo(config.kie.nsfwChecker), 'KIE_NSFW_CHECKER. Switched on for the models that have one.')),
        }),

        config.billing ? creditsCard(config.billing) : null)
    },
  })

  return { destroy() {} }
}
