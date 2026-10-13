/*
 * Moderation: decide what the checker was unsure about, or got wrong.
 *
 * A list on the left, the selected item on the right, and a decision at the bottom
 * of it. Deciding moves straight to the next open item, so a queue can be worked
 * through without going back to the list.
 *
 * Two safeguards worth knowing about:
 *
 *   • A flagged file is NOT loaded just because the item is selected. It sits behind
 *     "Reveal", and revealing it is recorded in the audit log: looking at what a
 *     person uploaded is something that should be a choice, and leave a trace.
 *   • Every outcome of a decision is stated back ("restored to their gallery", "file
 *     deleted", "account suspended"), not just "saved".
 */

import { h, mount } from '../lib/dom.js'
import { buildRoute, intParam, oneOf, withQuery } from '../lib/router.js'
import {
  badge, button, callout, copyButton, emptyState, errorState, loadInto, notify, pageHeader, pager, selectControl, skeletonRows, tabs,
} from '../lib/components.js'
import {
  actionLabel, categoryLabel, formatDate, formatNumber, relativeTime, sourceLabel, truncate,
} from '../lib/format.js'
import { icon } from '../lib/icons.js'

const STATUSES = ['open', 'dismissed', 'confirmed', 'all']
const SOURCES = ['prompt', 'prompt_assist', 'image', 'video', 'output', 'report', 'provider']
const PAGE_SIZE = 25

/**
 * Where on a 0–1 score bar the review and block lines sit, from the server's rules.
 * A category set to "ignore" has none.
 *
 * @returns {{review: number|null, block: number|null}}
 */
export function thresholdMarks(thresholds, category) {
  const rule = thresholds?.[category]
  if (!rule) return { review: null, block: null }
  return { review: typeof rule.review === 'number' ? rule.review : null, block: typeof rule.block === 'number' ? rule.block : null }
}

/** What a decision did, as one sentence for the toast. */
export function outcomeMessage(resolution, outcome) {
  const parts = []
  if (resolution === 'dismiss') {
    parts.push('Dismissed — the strike is withdrawn')
    if (outcome.restored) parts.push('the file is back in their gallery')
  } else {
    parts.push('Confirmed')
    if (outcome.blocked) parts.push('the file is now blocked and hidden from them')
    if (outcome.deleted) parts.push('the file was deleted')
    if (outcome.suspended) parts.push('the account was suspended')
  }
  return `${parts.join('; ')}.`
}

const toneFor = event => (event.action === 'blocked' ? 'danger' : 'warning')

export function renderModeration(ctx) {
  const { api, container, navigate, notify: say = notify } = ctx
  let route = ctx.route
  let listAbort = new AbortController()
  let detailAbort = new AbortController()
  let thresholds = null
  let paintScores = null // redraws the score bars of the item on show, when the rules arrive late
  let events = []        // the current page, for "next item"
  let counts = null
  let first = true

  const params = () => ({
    status: oneOf(route.query.status, STATUSES, 'open'),
    source: oneOf(route.query.source, SOURCES, ''),
    userId: route.query.userId || '',
    page: intParam(route.query.page, 1),
  })
  const listKey = () => JSON.stringify(params())
  const go = changes => navigate(withQuery({ ...route, id: null }, changes))
  const select = id => navigate(buildRoute('moderation', { id, query: route.query }))

  const tabsBox = h('div')
  const filtersBox = h('div', { class: 'toolbar-item toolbar-wrap' })
  const list = h('div', { class: 'mod-list card card-flush' })
  const detail = h('section', { class: 'mod-detail card' })
  const layout = h('div', { class: 'mod-layout' }, list, detail)

  mount(container,
    pageHeader({ title: 'Moderation', subtitle: 'Items the checker refused, held back, or that someone reported.' }),
    tabsBox,
    h('div', { class: 'toolbar toolbar-below-tabs' }, filtersBox),
    layout)

  function paintToolbar() {
    const p = params()
    const c = counts || { open: undefined, dismissed: undefined, confirmed: undefined }
    mount(tabsBox, tabs({
      label: 'Status', value: p.status,
      items: [
        { id: 'open', label: 'Open', count: c.open }, { id: 'dismissed', label: 'Dismissed', count: c.dismissed },
        { id: 'confirmed', label: 'Confirmed', count: c.confirmed }, { id: 'all', label: 'All' },
      ],
      onChange: id => go({ status: id === 'open' ? null : id, page: null }),
    }))
    mount(filtersBox,
      selectControl({
        label: 'Source', value: p.source, onChange: v => go({ source: v, page: null }),
        options: [{ value: '', label: 'Any source' }, ...SOURCES.map(s => ({ value: s, label: sourceLabel(s) }))],
      }),
      p.userId ? h('span', { class: 'chip' }, icon('users', { size: 14 }), 'One account',
        h('button', { class: 'chip-x', type: 'button', 'aria-label': 'Show every account again', onclick: () => go({ userId: null, page: null }) }, icon('x', { size: 12 }))) : null)
  }

  // ── The list ───────────────────────────────────────────────────────────────
  function loadList() {
    listAbort.abort()
    listAbort = new AbortController()
    const p = params()
    paintToolbar()
    return loadInto(list, {
      signal: listAbort.signal,
      skeleton: () => skeletonRows(2, 6),
      load: () => api.get('/api/admin/moderation', { ...p, pageSize: PAGE_SIZE }, { signal: listAbort.signal }),
      render: data => {
        events = data.events
        counts = data.counts
        paintToolbar()
        layout.classList.toggle('has-selection', Boolean(route.id))
        if (!events.length) {
          mount(list, emptyState({
            iconName: p.status === 'open' ? 'check' : 'shield',
            title: p.status === 'open' ? 'Nothing to review' : 'Nothing here',
            body: p.status === 'open' ? 'You are all caught up.' : 'No items match these filters.',
          }))
          if (!route.id) mount(detail, hint())
          return
        }
        mount(list,
          h('ul', { class: 'mod-items', role: 'listbox', 'aria-label': 'Moderation items' }, events.map(e => itemRow(e))),
          data.total > PAGE_SIZE ? pager({ page: data.page, pageSize: data.pageSize, total: data.total, sizes: [PAGE_SIZE], onChange: ({ page }) => go({ page: page === 1 ? null : page }) }) : null)
        // On a wide screen the first item is shown without being asked.
        if (!route.id && window.matchMedia?.('(min-width: 1181px)')?.matches) select(events[0].id)
      },
    })
  }

  function itemRow(e) {
    const selected = e.id === route.id
    return h('li', { role: 'none' }, h('button', {
      class: ['mod-item', selected && 'mod-item-on'], type: 'button', role: 'option', 'aria-selected': String(selected), 'data-id': e.id,
      onclick: () => select(e.id),
    },
    h('div', { class: 'mod-item-top' }, h('div', { class: 'badges' }, badge(sourceLabel(e.source)), badge(actionLabel(e.action), toneFor(e), { dot: true })),
      h('time', { class: 'muted small', datetime: e.createdAt, title: formatDate(e.createdAt) }, relativeTime(e.createdAt))),
    h('div', { class: 'mod-item-user' }, e.email),
    h('div', { class: 'muted small' }, e.categories.map(categoryLabel).join(', ') || '—'),
    e.excerpt ? h('div', { class: 'small quote-line' }, truncate(e.excerpt, 80)) : null,
    e.status !== 'open' ? h('div', {}, badge(e.status === 'dismissed' ? 'Dismissed' : 'Confirmed', e.status === 'dismissed' ? 'success' : 'danger')) : null))
  }

  const hint = () => emptyState({ iconName: 'moderation', title: 'Select an item', body: 'Pick something from the list to see it and decide.' })

  // ── The selected item ──────────────────────────────────────────────────────
  async function loadDetail() {
    detailAbort.abort()
    detailAbort = new AbortController()
    paintScores = null
    layout.classList.toggle('has-selection', Boolean(route.id))
    for (const b of list.querySelectorAll('.mod-item')) {
      const on = b.getAttribute('data-id') === route.id
      b.classList.toggle('mod-item-on', on)
      b.setAttribute('aria-selected', String(on))
    }
    if (!route.id) { mount(detail, hint()); return }

    const id = route.id
    // Usually already in the loaded page; otherwise (a shared link) ask for it.
    let event = events.find(e => e.id === id)
    if (!event) {
      try {
        mount(detail, skeletonRows(2, 5))
        event = (await api.get('/api/admin/moderation/item', { eventId: id }, { signal: detailAbort.signal })).event
      } catch (e) {
        if (e?.name === 'AbortError' || route.id !== id) return
        mount(detail, e.status === 404
          ? emptyState({ iconName: 'search', title: 'That item was not found', body: 'It may have been removed, or the link is wrong.', action: button({ label: 'Back to the list', onClick: () => go({}) }) })
          : errorState({ message: e.message, onRetry: loadDetail }))
        return
      }
    }
    if (route.id !== id) return
    paintDetail(event)
  }

  function paintDetail(e) {
    const open = e.status === 'open'
    const scores = Object.entries(e.scores || {}).sort((a, b) => b[1] - a[1])
    const labels = e.categories.length ? e.categories : scores.map(([c]) => c)

    // The bars are drawn on their own, so the rules arriving after the item (they are
    // fetched once, alongside it) redraw only them — never a note being typed.
    const scoreBars = h('div', { class: 'scores' })
    const drawScores = () => mount(scoreBars,
      scores.map(([category, score]) => scoreRow(category, score, thresholds)),
      h('div', { class: 'score-legend muted small' },
        h('span', { class: 'legend-key legend-review' }), 'review line ', h('span', { class: 'legend-key legend-block' }), 'refuse line'))
    drawScores()
    paintScores = scores.length ? drawScores : null

    // ── the file, behind a reveal ───────────────────────────────────────────
    const stage = h('div', { class: 'reveal' })
    const showFile = async () => {
      mount(stage, h('div', { class: 'muted' }, 'Loading…'))
      try {
        const m = await api.get('/api/admin/moderation/media', { eventId: e.id }, { signal: detailAbort.signal })
        mount(stage, m.kind === 'video'
          ? h('video', { class: 'reveal-media', controls: true, src: m.url, preload: 'metadata' })
          : h('img', { class: 'reveal-media', src: m.url, alt: 'The file under review' }),
        h('div', { class: 'reveal-note muted small' }, `This link expires in ${m.expiresIn} seconds. The view was recorded.`))
      } catch (err) {
        if (err?.name === 'AbortError') return
        mount(stage, h('div', { class: 'error-text' }, err.message), button({ label: 'Try again', onClick: showFile }))
      }
    }
    function paintStage() {
      mount(stage,
        h('div', { class: 'reveal-cover' }, icon(e.assetKind === 'video' ? 'video' : 'image', { size: 28 }),
          h('div', {}, h('strong', {}, e.assetKind === 'video' ? 'Video hidden' : 'Image hidden')),
          h('div', { class: 'muted small' }, 'Revealing it is recorded in the audit log.'),
          button({ label: 'Reveal file', iconName: 'eye', onClick: showFile })))
    }
    paintStage()

    // ── the decision ────────────────────────────────────────────────────────
    const decision = { value: 'dismiss' }
    const note = h('textarea', { id: 'mod-note', class: 'control', rows: 2, maxlength: 500, placeholder: 'Optional note for the audit log' })
    const deleteFile = h('input', { type: 'checkbox', id: 'mod-delete' })
    const suspend = h('input', { type: 'checkbox', id: 'mod-suspend' })
    const extras = h('div', { class: ['decision-extras', 'hidden'] },
      e.assetId ? h('label', { class: 'check', for: 'mod-delete' }, deleteFile, h('span', {}, h('strong', {}, 'Delete the file permanently'), h('span', { class: 'muted small block' }, 'It cannot be recovered. Otherwise it stays blocked and hidden, and can still be released later.'))) : null,
      h('label', { class: 'check', for: 'mod-suspend' }, suspend, h('span', {}, h('strong', {}, 'Suspend this account'), h('span', { class: 'muted small block' }, 'Signs them out everywhere. Administrators are never suspended.'))))
    const submit = button({ label: 'Save decision', tone: 'primary', type: 'submit' })
    const error = h('div', { class: 'form-error form-error-empty', role: 'alert' })

    const choice = (value, title, body) => {
      const radio = h('input', { type: 'radio', name: 'decision', value, checked: decision.value === value })
      radio.addEventListener('change', () => {
        decision.value = value
        extras.classList.toggle('hidden', value !== 'confirm')
        submit.querySelector('span').textContent = value === 'confirm' ? 'Confirm violation' : 'Dismiss'
      })
      return h('label', { class: 'decision-card' }, radio, h('span', {}, h('strong', {}, title), h('span', { class: 'muted small block' }, body)))
    }

    const form = h('form', {
      class: 'decision',
      onsubmit: async event => {
        event.preventDefault()
        submit.disabled = true
        error.classList.add('form-error-empty')
        try {
          const confirming = decision.value === 'confirm'
          const result = await api.post('/api/admin/moderation/resolve', {
            eventId: e.id, resolution: decision.value, note: note.value.trim() || undefined,
            deleteContent: confirming && deleteFile.checked, suspendUser: confirming && suspend.checked,
          })
          say.success(outcomeMessage(decision.value, result), 'Decision saved')
          ctx.refreshShell?.()
          advance(e.id)
        } catch (err) {
          error.textContent = err.message
          error.classList.remove('form-error-empty')
          submit.disabled = false
        }
      },
    },
    h('h3', {}, 'Your decision'),
    h('div', { class: 'decision-cards' },
      choice('dismiss', 'Dismiss — the checker was wrong', e.assetId ? 'Withdraws the strike. A blocked file goes back to its owner.' : 'Withdraws the strike. Nothing else changes.'),
      choice('confirm', 'Confirm — this is a violation', 'Keeps the strike.' + (e.assetId ? ' A file that was let through is blocked and hidden.' : ''))),
    extras,
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'mod-note' }, 'Note'), note),
    error,
    h('div', { class: 'decision-actions' }, submit))
    submit.querySelector('span').textContent = 'Dismiss'

    mount(detail,
      h('button', { class: 'btn btn-ghost btn-sm mod-back', type: 'button', onclick: () => go({}) }, icon('chevron-left', { size: 14 }), 'All items'),
      h('header', { class: 'mod-detail-head' },
        h('div', {},
          h('div', { class: 'badges' }, badge(sourceLabel(e.source)), badge(actionLabel(e.action), toneFor(e), { dot: true }),
            e.status !== 'open' ? badge(e.status === 'dismissed' ? 'Dismissed' : 'Confirmed', e.status === 'dismissed' ? 'success' : 'danger') : null),
          h('h2', { class: 'mod-detail-title' }, e.categories.map(categoryLabel).join(' · ') || 'Flagged')),
        h('time', { class: 'muted small', datetime: e.createdAt, title: e.createdAt }, formatDate(e.createdAt))),

      h('dl', { class: 'facts facts-2' },
        h('div', { class: 'fact' }, h('dt', {}, 'Account'), h('dd', {}, h('a', { class: 'link', href: buildRoute('users', { id: e.userId }) }, e.email), e.userStatus === 'suspended' ? badge('Suspended', 'danger') : null)),
        e.model ? h('div', { class: 'fact' }, h('dt', {}, 'Model'), h('dd', { class: 'mono small' }, e.model)) : null,
        e.taskId ? h('div', { class: 'fact' }, h('dt', {}, 'Task'), h('dd', { class: 'mono small' }, truncate(e.taskId, 24), copyButton(e.taskId, 'Copy the task id'))) : null),

      e.excerpt ? h('section', { class: 'mod-section' }, h('h3', {}, e.source === 'report' ? 'What they said' : 'What was submitted'), h('blockquote', { class: 'quote' }, e.excerpt)) : null,

      scores.length ? h('section', { class: 'mod-section' }, h('h3', {}, 'What the checker saw'), scoreBars) : null,
      !scores.length && labels.length && e.source === 'report' ? h('p', { class: 'muted small' }, `Reported as: ${labels.map(categoryLabel).join(', ')}.`) : null,

      e.assetId ? h('section', { class: 'mod-section' }, h('h3', {}, e.assetKind === 'video' ? 'The video' : 'The image'),
        h('p', { class: 'muted small' }, e.assetStatus === 'blocked' ? 'This file is blocked: its owner cannot see it.' : e.assetStatus === 'clear' ? 'This file was let through and its owner can see it.' : 'This file has not been checked yet.'), stage) : null,

      open
        ? form
        : callout({
          tone: e.status === 'dismissed' ? 'success' : 'danger', iconName: e.status === 'dismissed' ? 'check' : 'flag',
          title: `${e.status === 'dismissed' ? 'Dismissed' : 'Confirmed'}${e.reviewedBy ? ` by ${e.reviewedBy}` : ''} ${e.reviewedAt ? relativeTime(e.reviewedAt) : ''}`.trim(),
          body: e.reviewNote || 'No note was left.',
        }))
    detail.scrollTop = 0
  }

  /**
   * After a decision on the Open tab: reload (the decided item leaves the list), then
   * go to whichever item now sits where it was — the next one — or back to the list
   * when the queue is empty. On other tabs the item stays and shows its outcome.
   */
  async function advance(decidedId) {
    const p = params()
    const at = Math.max(0, events.findIndex(e => e.id === decidedId))
    await loadList()
    if (p.status !== 'open') { loadDetail(); return }
    const target = events[Math.min(at, events.length - 1)]
    if (target) select(target.id)
    else navigate(buildRoute('moderation', { query: route.query }))
  }

  // ── Keyboard: j / k to move through the list ───────────────────────────────
  const onKey = event => {
    if (event.target.closest?.('input, textarea, select, dialog') || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key !== 'j' && event.key !== 'k') return
    const at = events.findIndex(e => e.id === route.id)
    const next = events[event.key === 'j' ? Math.min(events.length - 1, at + 1) : Math.max(0, at - 1)]
    if (next && next.id !== route.id) { event.preventDefault(); select(next.id) }
  }
  document.addEventListener('keydown', onKey)

  // ── Following the address ──────────────────────────────────────────────────
  async function sync(next) {
    const before = listKey()
    route = next
    if (first || listKey() !== before) {
      const listLoaded = loadList()
      first = false
      await listLoaded
    }
    first = false
    loadDetail()
  }

  api.get('/api/admin/config', null, {}).then(c => { thresholds = c.moderation.thresholds; paintScores?.() }).catch(() => {})
  sync(route)
  return { update: sync, destroy() { listAbort.abort(); detailAbort.abort(); document.removeEventListener('keydown', onKey) } }
}

/** One category's score as a bar, with the review and refuse lines marked on it. */
function scoreRow(category, score, thresholds) {
  const marks = thresholdMarks(thresholds, category)
  const pct = Math.max(0, Math.min(100, score * 100))
  const tone = marks.block !== null && score >= marks.block ? 'danger' : marks.review !== null && score >= marks.review ? 'warning' : 'neutral'
  return h('div', { class: 'score-row' },
    h('span', { class: 'score-label' }, categoryLabel(category)),
    h('div', { class: ['score-track'], role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 1, 'aria-valuenow': score, 'aria-label': categoryLabel(category) },
      h('span', { class: ['score-fill', `score-${tone}`], style: { width: `${pct}%` } }),
      marks.review !== null ? h('span', { class: 'score-mark score-mark-review', style: { left: `${marks.review * 100}%` }, title: `Held for review at ${marks.review}` }) : null,
      marks.block !== null ? h('span', { class: 'score-mark score-mark-block', style: { left: `${marks.block * 100}%` }, title: `Refused at ${marks.block}` }) : null),
    h('span', { class: 'score-value' }, formatNumber(Math.round(score * 100) / 100)))
}

