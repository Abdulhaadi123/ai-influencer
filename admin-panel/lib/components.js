/*
 * The panel's building blocks: badges, buttons, dialogs, a side drawer, menus,
 * tables, pagers, charts, and the empty / loading / error states every list needs.
 *
 * Nothing here knows about users or jobs. Views assemble these, so a table looks
 * and behaves the same on every page, and a dialog traps focus and closes on Escape
 * the same way wherever it is opened.
 */

import { h, mount, uid } from './dom.js'
import { icon } from './icons.js'
import { formatNumber, initials, niceMax } from './format.js'

// ── Small pieces ─────────────────────────────────────────────────────────────

/** @param {'neutral'|'success'|'warning'|'danger'|'info'|'accent'} tone */
export function badge(text, tone = 'neutral', { dot = false, title = null } = {}) {
  return h('span', { class: ['badge', `badge-${tone}`], title }, dot ? h('span', { class: 'badge-dot', 'aria-hidden': 'true' }) : null, text)
}

/** A round monogram, tinted by a stable hash of the text so a person keeps their colour. */
export function avatar(value, size = 32) {
  let hash = 0
  for (const ch of String(value ?? '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0
  return h('span', { class: ['avatar', `avatar-${hash % 6}`], style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px` }, 'aria-hidden': 'true' }, initials(value))
}

/** A button. `tone`: primary | secondary | danger | ghost. */
export function button({ label, iconName = null, tone = 'secondary', onClick, type = 'button', disabled = false, title = null, small = false, ariaLabel = null }) {
  return h('button', {
    class: ['btn', `btn-${tone}`, small && 'btn-sm'], type, disabled, title, 'aria-label': ariaLabel, onclick: onClick,
  }, iconName ? icon(iconName, { size: small ? 16 : 18 }) : null, label ? h('span', {}, label) : null)
}

export function iconButton({ iconName, label, onClick, title = null }) {
  return h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: title ?? label, onclick: onClick }, icon(iconName, { size: 20 }))
}

/** A labelled form control with its hint and error wired up for screen readers. */
export function field({ label, hint = null, control, id = null }) {
  const controlId = id || control.id || uid('field')
  control.id = controlId
  const describedBy = []
  const hintNode = hint ? h('div', { class: 'field-hint', id: `${controlId}-hint` }, hint) : null
  if (hintNode) describedBy.push(hintNode.id)
  if (describedBy.length) control.setAttribute('aria-describedby', describedBy.join(' '))
  return h('div', { class: 'field' }, h('label', { class: 'field-label', for: controlId }, label), control, hintNode)
}

/** An on/off switch. Calls `onChange(next)` and waits; shows busy until it settles; reverts on failure. */
export function switchControl({ checked, onChange, label, disabled = false }) {
  let on = Boolean(checked)
  const node = h('button', { class: ['switch', on && 'switch-on'], type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': label, title: label, disabled },
    h('span', { class: 'switch-thumb' }))
  const paint = () => { node.classList.toggle('switch-on', on); node.setAttribute('aria-checked', String(on)) }
  node.addEventListener('click', async () => {
    const next = !on
    node.disabled = true
    try {
      await onChange(next)
      on = next
    } catch { /* the caller reports it; the switch stays where it was */ } finally {
      node.disabled = false
      paint()
    }
  })
  return node
}

/** A thin bar showing `value` of `max`. */
export function meter({ value, max, tone = 'accent', label = null }) {
  const ratio = max > 0 ? Number(value) / max : 0
  // A value that is not a number is "none", not "NaN%" (which is not a width at all).
  const pct = Number.isFinite(ratio) ? Math.max(0, Math.min(100, ratio * 100)) : 0
  return h('div', { class: ['meter', `meter-${tone}`], role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': Number(value) || 0, 'aria-label': label },
    h('span', { class: 'meter-fill', style: { width: `${pct}%` } }))
}

export function copyButton(text, label = 'Copy') {
  return h('button', {
    class: 'icon-btn icon-btn-sm', type: 'button', 'aria-label': label, title: label,
    onclick: async event => {
      event.stopPropagation()
      try {
        await navigator.clipboard.writeText(String(text))
        toast({ kind: 'success', message: 'Copied to the clipboard.' })
      } catch {
        toast({ kind: 'error', message: 'Could not copy. Select the text and copy it by hand.' })
      }
    },
  }, icon('copy', { size: 14 }))
}

// ── Cards and page furniture ─────────────────────────────────────────────────

export function pageHeader({ title, subtitle = null, actions = [] }) {
  return h('header', { class: 'page-header' },
    h('div', {}, h('h1', { class: 'page-title' }, title), subtitle ? h('p', { class: 'page-subtitle' }, subtitle) : null),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null)
}

export function card({ title = null, subtitle = null, actions = null, body, flush = false, className = '' }) {
  return h('section', { class: ['card', flush && 'card-flush', className] },
    title || actions ? h('header', { class: 'card-header' },
      h('div', {}, title ? h('h2', { class: 'card-title' }, title) : null, subtitle ? h('p', { class: 'card-subtitle' }, subtitle) : null),
      actions) : null,
    h('div', { class: 'card-body' }, body))
}

/**
 * A small "i" that explains a word: what a figure counts, what a column means. The words are the
 * tooltip and the accessible name, so they are read by everyone and never only by hovering.
 */
export function infoTip(text) {
  return h('span', { class: 'tip', title: text, role: 'img', 'aria-label': text, tabindex: 0 }, icon('info', { size: 14 }))
}

/**
 * A figure with its label. `href` makes the whole tile a link. `tip` says what the figure counts;
 * `unit` is the small word after the number ("credits").
 */
export function kpi({ label, value, hint = null, tone = null, iconName = null, href = null, title = null, tip = null, unit = null }) {
  const body = [
    h('div', { class: 'kpi-top' },
      h('span', { class: 'kpi-label' }, label, tip ? infoTip(tip) : null),
      iconName ? h('span', { class: ['kpi-icon', tone && `kpi-icon-${tone}`] }, icon(iconName, { size: 16 })) : null),
    h('div', { class: 'kpi-value' }, value, unit ? [' ', h('span', { class: 'kpi-unit' }, unit)] : null),
    hint ? h('div', { class: 'kpi-hint' }, hint) : null,
  ]
  return href
    ? h('a', { class: ['kpi', 'kpi-link'], href, title }, body)
    : h('div', { class: 'kpi', title }, body)
}

/** An inline notice. `action` is a node (a link or button) or null. */
export function callout({ tone = 'info', iconName = null, title, body = null, action = null }) {
  return h('div', { class: ['callout', `callout-${tone}`], role: tone === 'danger' || tone === 'warning' ? 'alert' : 'status' },
    icon(iconName || (tone === 'success' ? 'check' : tone === 'info' ? 'info' : 'alert'), { size: 18 }),
    h('div', { class: 'callout-text' }, h('strong', {}, title), body ? h('div', {}, body) : null),
    action)
}

export function emptyState({ iconName = 'search', title, body = null, action = null }) {
  return h('div', { class: 'empty' },
    h('span', { class: 'empty-icon' }, icon(iconName, { size: 22 })),
    h('h3', { class: 'empty-title' }, title),
    body ? h('p', { class: 'empty-body' }, body) : null,
    action)
}

export function errorState({ message, onRetry = null }) {
  return h('div', { class: 'empty empty-error', role: 'alert' },
    h('span', { class: 'empty-icon' }, icon('alert', { size: 22 })),
    h('h3', { class: 'empty-title' }, 'Something went wrong'),
    h('p', { class: 'empty-body' }, message || 'This could not be loaded.'),
    onRetry ? button({ label: 'Try again', iconName: 'refresh', onClick: onRetry }) : null)
}

/** Grey placeholder rows while a table loads. */
export function skeletonRows(columns = 5, rows = 6) {
  return h('div', { class: 'skeleton-table', 'aria-busy': 'true', 'aria-label': 'Loading' },
    Array.from({ length: rows }, () => h('div', { class: 'skeleton-row' },
      Array.from({ length: columns }, (_, i) => h('span', { class: ['skeleton', i === 0 && 'skeleton-wide'] })))))
}

export function skeletonCards(count = 4) {
  return h('div', { class: 'grid grid-kpi', 'aria-busy': 'true', 'aria-label': 'Loading' },
    Array.from({ length: count }, () => h('div', { class: 'kpi' }, h('span', { class: 'skeleton skeleton-short' }), h('span', { class: 'skeleton skeleton-tall' }))))
}

/**
 * Show a skeleton, load, render; on failure show the error with a retry that runs
 * the whole thing again. A load that was cancelled (the person navigated on) is
 * simply dropped — it neither renders nor reports.
 */
export async function loadInto(container, { load, render, signal = null, skeleton = () => skeletonRows() }) {
  mount(container, skeleton())
  try {
    const data = await load()
    if (signal?.aborted) return
    render(data)
  } catch (e) {
    if (e?.name === 'AbortError' || signal?.aborted) return
    mount(container, errorState({ message: e?.message, onRetry: () => loadInto(container, { load, render, signal, skeleton }) }))
  }
}

export function debounce(fn, ms) {
  let timer = null
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
  wrapped.cancel = () => clearTimeout(timer)
  return wrapped
}

// ── Controls that choose ─────────────────────────────────────────────────────

/** A row of exclusive choices. */
export function segmented({ options, value, onChange, label }) {
  const node = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label },
    options.map(option => h('button', {
      class: ['segment', option.value === value && 'segment-on'], type: 'button', role: 'radio', 'aria-checked': String(option.value === value),
      onclick: () => { if (option.value !== value) onChange(option.value) },
    }, option.label, option.count !== undefined ? h('span', { class: 'segment-count' }, formatNumber(option.count)) : null)))
  return node
}

/** Underlined tabs with counts. */
export function tabs({ items, value, onChange, label }) {
  return h('div', { class: 'tabs', role: 'tablist', 'aria-label': label },
    items.map(item => h('button', {
      class: ['tab', item.id === value && 'tab-on'], type: 'button', role: 'tab', 'aria-selected': String(item.id === value),
      onclick: () => { if (item.id !== value) onChange(item.id) },
    }, item.label, item.count !== undefined ? h('span', { class: ['tab-count', item.alert && 'tab-count-alert'] }, formatNumber(item.count)) : null)))
}

export function selectControl({ options, value, onChange, label, className = '' }) {
  return h('select', { class: ['control', className], 'aria-label': label, onchange: e => onChange(e.target.value), value: value ?? '' },
    options.map(o => h('option', { value: o.value, selected: o.value === (value ?? '') }, o.label)))
}

export function searchBox({ value = '', placeholder = 'Search', onInput, label = 'Search' }) {
  const input = h('input', { class: 'control search-input', type: 'search', placeholder, value, 'aria-label': label, autocomplete: 'off', spellcheck: 'false' })
  input.addEventListener('input', () => onInput(input.value))
  return h('div', { class: 'search' }, icon('search', { size: 16 }), input)
}

// ── Tables ───────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array<{key: string, label: string, render: (row) => any, sortKey?: string, defaultDir?: 'asc'|'desc', align?: 'right', hideBelow?: 'sm'|'md'|'lg', className?: string, tip?: string}>} opts.columns
 * @param {object[]} opts.rows
 * @param {(row) => string} [opts.rowKey]
 * @param {(row) => void} [opts.onRowClick]  makes rows focusable and clickable
 * @param {{key: string, dir: 'asc'|'desc'}} [opts.sort]
 * @param {(key: string, dir: 'asc'|'desc') => void} [opts.onSort]
 * @param {string} [opts.selectedKey]
 * @param {string} opts.label  the table's accessible name
 */
export function dataTable({ columns, rows, rowKey = r => r.id, onRowClick = null, sort = null, onSort = null, selectedKey = null, label }) {
  const head = h('tr', {}, columns.map(col => {
    const sortable = Boolean(col.sortKey && onSort)
    const active = sortable && sort?.key === col.sortKey
    const classes = [col.align === 'right' && 'num', col.hideBelow && `hide-${col.hideBelow}`, col.className]
    const tip = col.tip ? infoTip(col.tip) : null   // what the column means, for a word that is not obvious
    if (!sortable) return h('th', { scope: 'col', class: classes }, col.label, tip)
    return h('th', { scope: 'col', class: classes, 'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
      h('button', {
        class: ['th-sort', active && 'th-sort-on'], type: 'button',
        onclick: () => onSort(col.sortKey, active ? (sort.dir === 'desc' ? 'asc' : 'desc') : (col.defaultDir || 'desc')),
      }, col.label, active ? icon(sort.dir === 'asc' ? 'arrow-up' : 'arrow-down', { size: 12 }) : null), tip)
  }))

  const body = rows.map(row => {
    const key = rowKey(row)
    const tr = h('tr', {
      class: ['row', onRowClick && 'row-click', key === selectedKey && 'row-selected'], 'data-key': key, tabindex: onRowClick ? 0 : null,
      onclick: e => { if (onRowClick && !e.target.closest('a, button, input, select, textarea, label, [data-no-row]')) onRowClick(row) },
      onkeydown: e => { if (onRowClick && e.target === tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onRowClick(row) } },
    }, columns.map(col => h('td', { class: [col.align === 'right' && 'num', col.hideBelow && `hide-${col.hideBelow}`, col.className] }, col.render(row))))
    return tr
  })

  return h('div', { class: 'table-wrap' }, h('table', { class: 'table', 'aria-label': label }, h('thead', {}, head), h('tbody', {}, body)))
}

/** "1–25 of 132", previous/next, and a page size. */
export function pager({ page, pageSize, total, onChange, sizes = [25, 50, 100] }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return h('nav', { class: 'pager', 'aria-label': 'Pagination' },
    h('span', { class: 'pager-range' }, total === 0 ? 'No results' : `${formatNumber(from)}–${formatNumber(to)} of ${formatNumber(total)}`),
    h('span', { class: 'pager-spacer' }),
    sizes.length > 1 ? h('label', { class: 'pager-size' }, h('span', { class: 'muted' }, 'Rows'),
      h('select', { class: 'control control-sm', 'aria-label': 'Rows per page', onchange: e => onChange({ page: 1, pageSize: Number(e.target.value) }) },
        sizes.map(n => h('option', { value: n, selected: n === pageSize }, n)))) : null,
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous page', disabled: page <= 1, onclick: () => onChange({ page: page - 1, pageSize }) }, icon('chevron-left')),
    h('span', { class: 'pager-page' }, `Page ${formatNumber(page)} of ${formatNumber(pages)}`),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next page', disabled: page >= pages, onclick: () => onChange({ page: page + 1, pageSize }) }, icon('chevron-right')))
}

// ── Overlays ─────────────────────────────────────────────────────────────────

let toastRoot = null

function toastContainer() {
  if (!toastRoot || !toastRoot.isConnected) {
    toastRoot = h('div', { class: 'toasts', role: 'region', 'aria-label': 'Notifications', 'aria-live': 'polite' })
    document.body.append(toastRoot)
  }
  return toastRoot
}

/**
 * A short message that fades by itself. Errors stay longer, and every toast can be
 * dismissed. Returns the element.
 *
 * @param {{kind?: 'success'|'error'|'info', title?: string, message: string, timeout?: number}} opts
 */
export function toast({ kind = 'info', title = null, message, timeout = null }) {
  const node = h('div', { class: ['toast', `toast-${kind}`], role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'info', { size: 18 }),
    h('div', { class: 'toast-text' }, title ? h('strong', {}, title) : null, h('div', {}, message)),
    h('button', { class: 'icon-btn icon-btn-sm', type: 'button', 'aria-label': 'Dismiss', onclick: () => node.remove() }, icon('x', { size: 14 })))
  toastContainer().append(node)
  setTimeout(() => node.remove(), timeout ?? (kind === 'error' ? 8000 : 4500))
  return node
}

export const notify = {
  success: (message, title) => toast({ kind: 'success', message, title }),
  error: (error, title = 'That did not work') => toast({ kind: 'error', title, message: error?.message || String(error) }),
  info: message => toast({ kind: 'info', message }),
}

/**
 * A modal dialog. Resolves with what `onConfirm` returned (or `true`), or `null`
 * when cancelled. If `onConfirm` throws, its message is shown inside the dialog and
 * the dialog stays open, so a failed save never loses what was typed.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.description]
 * @param {Node} [opts.content]
 * @param {string} [opts.confirmLabel]
 * @param {string} [opts.cancelLabel]
 * @param {'primary'|'danger'} [opts.tone]
 * @param {() => Promise<any>|any} [opts.onConfirm]
 * @param {boolean} [opts.hideCancel]
 */
export function openDialog({ title, description = null, content = null, confirmLabel = 'Save', cancelLabel = 'Cancel', tone = 'primary', onConfirm = null, hideCancel = false }) {
  return new Promise(resolve => {
    const previous = document.activeElement
    const titleId = uid('dialog-title')
    let busy = false
    let done = false

    const error = h('div', { class: 'form-error', role: 'alert' })
    const confirm = h('button', { class: ['btn', tone === 'danger' ? 'btn-danger-solid' : 'btn-primary'], type: 'submit' }, confirmLabel)
    const cancel = hideCancel ? null : h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => finish(null) }, cancelLabel)

    const form = h('form', {
      class: 'dialog-form',
      onsubmit: async event => {
        event.preventDefault()
        if (busy) return
        busy = true
        confirm.disabled = true
        if (cancel) cancel.disabled = true
        error.textContent = ''
        try {
          const value = onConfirm ? await onConfirm() : true
          finish(value === undefined ? true : value)
        } catch (e) {
          error.textContent = e?.message || 'That did not work.'
          busy = false
          confirm.disabled = false
          if (cancel) cancel.disabled = false
        }
      },
    },
    h('h2', { class: 'dialog-title', id: titleId }, title),
    description ? h('p', { class: 'dialog-description' }, description) : null,
    content ? h('div', { class: 'dialog-content' }, content) : null,
    error,
    h('div', { class: 'dialog-actions' }, cancel, confirm))

    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': titleId }, form)

    function finish(value) {
      if (done) return
      done = true
      if (typeof dialog.close === 'function' && dialog.open) dialog.close()
      dialog.remove()
      if (previous && typeof previous.focus === 'function') previous.focus()
      resolve(value)
    }

    // Escape cancels — unless a save is in flight, which must be left to finish.
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) finish(null) })
    // A click on the backdrop lands on the <dialog> itself, not on anything inside it.
    dialog.addEventListener('mousedown', event => { if (event.target === dialog && !busy) finish(null) })

    document.body.append(dialog)
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')

    const first = dialog.querySelector('input:not([type=hidden]), textarea, select')
    ;(first || confirm).focus?.()
  })
}

/** A yes/no question. Resolves true or false. */
export async function confirmDialog({ title, description, confirmLabel = 'Confirm', tone = 'primary', content = null }) {
  return (await openDialog({ title, description, confirmLabel, tone, content })) === true
}

/**
 * A slide-in panel from the right, for looking at one record without leaving the
 * list. Escape and the backdrop close it; focus goes in, stays in, and returns.
 *
 * @returns {{el: HTMLElement, close: (opts?: {silent?: boolean}) => void, setContent: (...nodes) => void, setTitle: (title: string, subtitle?: string) => void}}
 */
export function openDrawer({ title, subtitle = null, content = [], onClose = null }) {
  const previous = document.activeElement
  let closed = false

  const titleNode = h('h2', { class: 'drawer-title' }, title)
  const subtitleNode = h('p', { class: 'drawer-subtitle' }, subtitle || '')
  const body = h('div', { class: 'drawer-body' }, content)
  const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
    h('header', { class: 'drawer-header' }, h('div', { class: 'drawer-heading' }, titleNode, subtitleNode),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('x'))),
    body)
  const root = h('div', { class: 'drawer-root' }, h('div', { class: 'drawer-overlay', onclick: () => close() }), panel)

  const onKey = event => {
    if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { event.stopPropagation(); close() }
    else if (event.key === 'Tab') trapFocus(event, panel)
  }

  function close({ silent = false } = {}) {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey, true)
    root.remove()
    document.body.classList.remove('no-scroll')
    if (previous && typeof previous.focus === 'function' && previous.isConnected) previous.focus()
    if (!silent) onClose?.()
  }

  document.body.append(root)
  document.body.classList.add('no-scroll')
  document.addEventListener('keydown', onKey, true)
  panel.focus()

  return {
    el: panel,
    close,
    setContent: (...nodes) => mount(body, ...nodes),
    setTitle: (next, nextSubtitle = '') => {
      titleNode.textContent = next
      subtitleNode.textContent = nextSubtitle
      panel.setAttribute('aria-label', next)
    },
  }
}

/** Keep Tab inside `container`. */
function trapFocus(event, container) {
  const focusable = [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
  if (!focusable.length) { event.preventDefault(); return }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}

/**
 * A "⋯" button that opens a menu of actions. The menu is attached to the page, not
 * to the table, so a scrolling table cannot clip it.
 *
 * @param {object} opts
 * @param {string} opts.label  accessible name
 * @param {Array<{label?: string, iconName?: string, tone?: 'danger', disabled?: boolean, title?: string, onSelect?: () => void, separator?: boolean}>} opts.items
 */
export function menuButton({ label = 'Actions', items }) {
  let menu = null

  const button = h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-no-row': '' }, icon('more'))

  function close() {
    if (!menu) return
    menu.remove()
    menu = null
    button.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', onOutside, true)
    document.removeEventListener('keydown', onKey, true)
  }
  const onOutside = event => { if (menu && !menu.contains(event.target) && !button.contains(event.target)) close() }
  const onKey = event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); button.focus() }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const options = [...menu.querySelectorAll('[role=menuitem]:not([disabled])')]
      const at = options.indexOf(document.activeElement)
      options[(at + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus()
    }
  }

  function open() {
    menu = h('div', { class: 'menu', role: 'menu', 'aria-label': label },
      items.map(item => item.separator
        ? h('div', { class: 'menu-separator', role: 'separator' })
        : h('button', {
          class: ['menu-item', item.tone === 'danger' && 'menu-item-danger'], type: 'button', role: 'menuitem', disabled: item.disabled, title: item.title,
          onclick: () => { close(); item.onSelect?.() },
        }, item.iconName ? icon(item.iconName, { size: 16 }) : null, item.label)))
    document.body.append(menu)

    // Under the button, right-aligned; above it when there is no room below.
    const rect = button.getBoundingClientRect()
    const height = menu.offsetHeight || items.length * 36
    const below = rect.bottom + 4 + height <= (window.innerHeight || 800)
    Object.assign(menu.style, {
      top: `${Math.max(8, below ? rect.bottom + 4 : rect.top - height - 4)}px`,
      right: `${Math.max(8, (window.innerWidth || 1200) - rect.right)}px`,
    })
    button.setAttribute('aria-expanded', 'true')
    document.addEventListener('click', onOutside, true)
    document.addEventListener('keydown', onKey, true)
    menu.querySelector('[role=menuitem]:not([disabled])')?.focus()
  }

  button.addEventListener('click', event => { event.stopPropagation(); menu ? close() : open() })
  return button
}

// ── Charts ───────────────────────────────────────────────────────────────────

/**
 * A bar chart with a value axis and a hover/tap title on every bar.
 *
 * @param {object} opts
 * @param {Array<{key: string, value: number, title: string}>} opts.data
 * @param {string} opts.label  what the chart shows, for screen readers
 * @param {(n: number) => string} [opts.format]
 */
export function barChart({ data, label, format = formatNumber, height = 200 }) {
  // A datum may carry a `value2` as well: two bars side by side per day (bought and spent).
  const paired = data.some(d => d.value2 !== undefined)
  const max = niceMax(Math.max(0, ...data.map(d => Number(d.value) || 0), ...data.map(d => Number(d.value2) || 0)))
  const slot = 10
  const width = Math.max(1, data.length) * slot
  const NS = 'http://www.w3.org/2000/svg'
  const el = (tag, attrs) => {
    const node = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
    return node
  }

  const chart = el('svg', { class: 'chart-svg', viewBox: `0 0 ${width} 100`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label })
  for (const y of [0, 50, 100]) chart.append(el('line', { x1: 0, x2: width, y1: y, y2: y, class: 'chart-grid', 'vector-effect': 'non-scaling-stroke' }))
  data.forEach((d, i) => {
    const value = Math.max(0, Number(d.value) || 0)
    const barHeight = value > 0 ? Math.max(1.5, (value / max) * 100) : 0
    const group = el('g', { class: 'chart-col' })
    const title = el('title', {})
    title.textContent = d.title
    group.append(title, el('rect', { x: i * slot, y: 0, width: slot, height: 100, class: 'chart-hit' }))
    if (paired) {
      const barWidth = (slot - 2.4) / 2
      if (barHeight) group.append(el('rect', { x: i * slot + 1.2, y: 100 - barHeight, width: barWidth, height: barHeight, rx: 0.8, class: 'chart-bar' }))
      const value2 = Math.max(0, Number(d.value2) || 0)
      const height2 = value2 > 0 ? Math.max(1.5, (value2 / max) * 100) : 0
      if (height2) group.append(el('rect', { x: i * slot + 1.2 + barWidth, y: 100 - height2, width: barWidth, height: height2, rx: 0.8, class: 'chart-bar-2' }))
    } else if (barHeight) {
      group.append(el('rect', { x: i * slot + 1.2, y: 100 - barHeight, width: slot - 2.4, height: barHeight, rx: 1, class: 'chart-bar' }))
    }
    chart.append(group)
  })

  return h('div', { class: 'chart', style: { '--chart-height': `${height}px` } },
    h('div', { class: 'chart-axis', 'aria-hidden': 'true' }, h('span', {}, format(max)), h('span', {}, format(max / 2)), h('span', {}, '0')),
    h('div', { class: 'chart-plot' }, chart, h('div', { class: 'chart-x muted', 'aria-hidden': 'true' }, h('span', {}, data[0]?.key ?? ''), h('span', {}, data[data.length - 1]?.key ?? ''))))
}

/** What the colours of a chart mean: `[{label, second?}]`, the second series drawn in the frame's navy. */
export function chartLegend(items) {
  return h('div', { class: 'chart-legend' }, items.map(item => h('span', { class: 'legend-item' },
    h('span', { class: ['legend-swatch', item.second && 'legend-swatch-2'], 'aria-hidden': 'true' }), item.label)))
}

/** Horizontal bars, one per item, scaled to the biggest. */
export function barList({ items, format = formatNumber, emptyText = 'Nothing yet.' }) {
  if (!items.length) return h('p', { class: 'muted' }, emptyText)
  const max = Math.max(...items.map(i => Number(i.value) || 0), 0)
  return h('ul', { class: 'barlist' }, items.map(item => h('li', { class: 'barlist-row', title: item.title || null },
    h('div', { class: 'barlist-head' }, h('span', { class: 'barlist-label' }, item.label), h('span', { class: 'barlist-value' }, format(item.value))),
    h('div', { class: 'barlist-track' }, h('span', { class: 'barlist-fill', style: { width: `${max > 0 ? Math.max(2, ((Number(item.value) || 0) / max) * 100) : 0}%` } })),
    item.sub ? h('div', { class: 'barlist-sub muted' }, item.sub) : null)))
}
