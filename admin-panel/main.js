/*
 * The admin panel: sign in, then a shell (sidebar, top bar) around one view at a time.
 *
 * Each view is given a container and a context and may return a controller:
 *
 *   update(route)   called instead of re-rendering when only the address's details
 *                   change (a filter, a page, an open record), so a list does not
 *                   flash and a search box keeps its focus;
 *   destroy()       called when the view is left.
 *
 * Everything that must outlive a view — the session, the toasts, the sidebar's
 * count of items waiting — lives here.
 */

import { createApi } from './lib/api.js'
import { PANEL_NAME } from './lib/brand.js'
import { h, mount } from './lib/dom.js'
import { icon } from './lib/icons.js'
import { buildRoute, parseRoute } from './lib/router.js'
import { avatar, badge, errorState, notify } from './lib/components.js'
import { formatNumber } from './lib/format.js'

import { renderLogin } from './views/login.js'
import { renderOverview } from './views/overview.js'
import { renderUsers } from './views/users.js'
import { renderJobs } from './views/jobs.js'
import { renderModeration } from './views/moderation.js'
import { renderPrices } from './views/prices.js'
import { renderAudit } from './views/audit.js'
import { renderSettings } from './views/settings.js'

/** The pages, in the order of the sidebar; `group` heads a run of them (the first page has none). */
export const VIEW_DEFS = [
  { id: 'overview', label: 'Overview', icon: 'overview', render: renderOverview },
  { id: 'users', label: 'Accounts', icon: 'users', render: renderUsers, group: 'Manage' },
  { id: 'jobs', label: 'Jobs', icon: 'jobs', render: renderJobs, group: 'Manage' },
  { id: 'moderation', label: 'Moderation', icon: 'moderation', render: renderModeration, badge: true, group: 'Manage' },
  { id: 'prices', label: 'Prices', icon: 'prices', render: renderPrices, group: 'Platform' },
  { id: 'audit', label: 'Audit log', icon: 'audit', render: renderAudit, group: 'Platform' },
  { id: 'settings', label: 'Settings', icon: 'settings', render: renderSettings, group: 'Platform' },
]

const POLL_MS = 60_000

/**
 * Start the panel.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.root
 * @param {ReturnType<typeof createApi>} [opts.api]  injectable for tests
 * @param {Window} [opts.win]
 */
export function start({ root, api: injected = null, win = window }) {
  let current = null          // { id, abort, controller }
  let poll = null
  let shell = null            // { content, nav, badge, ... } once signed in

  const api = injected ?? createApi({ onSessionEnded: message => showLogin(message) })

  // ── Navigation ─────────────────────────────────────────────────────────────
  function navigate(hash, { force = false } = {}) {
    if (win.location.hash === hash) { if (force) renderRoute(); return }
    win.location.hash = hash
  }

  function leaveView() {
    current?.abort.abort()
    current?.controller?.destroy?.()
    current = null
  }

  /** Dialogs, drawers and toasts belong to the view they were opened from. */
  function clearOverlays() {
    for (const node of win.document.querySelectorAll('dialog, .drawer-root, .menu')) node.remove()
    win.document.body.classList.remove('no-scroll')
  }

  function renderRoute() {
    if (!shell || !api.isSignedIn()) return
    const route = parseRoute(win.location.hash)
    const def = VIEW_DEFS.find(v => v.id === route.view)
    paintNav(route)
    win.document.title = `${def.label} · ${PANEL_NAME} Admin`
    closeNav()

    // The same view, only the details changed: let it adjust itself.
    if (current && current.id === route.view && typeof current.controller?.update === 'function') {
      current.controller.update(route)
      return
    }

    leaveView()
    clearOverlays()
    const abort = new AbortController()
    const container = h('div', { class: 'view' })
    mount(shell.content, container)
    current = { id: route.view, abort, controller: null }
    const mine = current

    const ctx = { api, container, route, navigate, signal: abort.signal, me: api.user, refreshShell, notify }
    try {
      const result = def.render(ctx)
      if (result && typeof result.then === 'function') {
        result.then(c => {
          if (current === mine) mine.controller = c ?? null
          else c?.destroy?.()
        }).catch(e => mount(container, errorState({ message: e.message, onRetry: () => navigate(win.location.hash, { force: true }) })))
      } else {
        mine.controller = result ?? null
      }
    } catch (e) {
      mount(container, errorState({ message: e.message, onRetry: () => navigate(win.location.hash, { force: true }) }))
    }
    // Keyboard and screen-reader users start at the top of the new view.
    shell.content.focus({ preventScroll: true })
    win.scrollTo?.(0, 0)
  }

  // ── The shell ──────────────────────────────────────────────────────────────
  function paintNav(route) {
    for (const link of shell.nav.querySelectorAll('a.nav-link')) {
      if (link.dataset.view === route.view) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
    shell.crumb.textContent = VIEW_DEFS.find(v => v.id === route.view).label
  }

  function setBadge(count) {
    if (!shell) return
    shell.badge.textContent = count > 99 ? '99+' : formatNumber(count)
    shell.badge.hidden = !count
    shell.badge.setAttribute('aria-label', `${count} waiting`)
  }

  /** Re-count what is waiting (moderation), for the sidebar. Never throws. */
  async function refreshShell() {
    if (!api.isSignedIn()) return null
    try {
      const stats = await api.get('/api/admin/stats')
      setBadge(stats.moderation.open)
      return stats
    } catch { return null }
  }

  const closeNav = () => shell?.frame.classList.remove('nav-open')

  function buildShell(stats) {
    const me = api.user
    const badgeNode = h('span', { class: 'nav-badge', hidden: true })
    const navItems = []
    let group = null
    for (const def of VIEW_DEFS) {
      if (def.group && def.group !== group) navItems.push(h('div', { class: 'nav-label', 'aria-hidden': 'true' }, def.group))
      group = def.group ?? null
      navItems.push(h('a', { class: 'nav-link', href: buildRoute(def.id), 'data-view': def.id },
        icon(def.icon, { size: 20 }), h('span', {}, def.label), def.badge ? badgeNode : null))
    }
    const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, navItems)

    const crumb = h('span', { class: 'crumb' }, '')
    const content = h('main', { class: 'content', id: 'content', tabindex: '-1' })

    const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Navigation' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('brand', { size: 20 })), h('span', { class: 'brand-name' }, PANEL_NAME), h('span', { class: 'brand-tag' }, 'Admin')),
      nav,
      h('div', { class: 'sidebar-foot' },
        h('div', { class: 'me' }, avatar(me.email, 40), h('div', { class: 'me-text' }, h('div', { class: 'me-email', title: me.email }, me.email), badge('Administrator', 'accent'))),
        h('button', { class: 'btn btn-secondary btn-block', type: 'button', onclick: async () => { await api.logout(); showLogin() } }, icon('log-out', { size: 16 }), h('span', {}, 'Sign out'))))

    const frame = h('div', { class: 'app-shell' },
      sidebar,
      h('div', { class: 'sidebar-scrim', onclick: () => closeNav() }),
      h('div', { class: 'main' },
        h('header', { class: 'topbar' },
          h('button', { class: 'icon-btn nav-toggle', type: 'button', 'aria-label': 'Open the menu', 'aria-controls': 'sidebar', onclick: () => frame.classList.toggle('nav-open') }, icon('menu', { size: 20 })),
          crumb),
        content))
    frame.addEventListener('keydown', e => { if (e.key === 'Escape') closeNav() })

    mount(root, frame)
    shell = { frame, content, nav, badge: badgeNode, crumb }
    if (stats) setBadge(stats.moderation.open)
  }

  function showShell(stats) {
    buildShell(stats)
    win.addEventListener('hashchange', renderRoute)
    clearInterval(poll)
    poll = setInterval(() => { if (!win.document.hidden) refreshShell() }, POLL_MS)
    renderRoute()
  }

  function showLogin(notice = null) {
    leaveView()
    clearOverlays()
    clearInterval(poll)
    win.removeEventListener('hashchange', renderRoute)
    shell = null
    win.document.title = `Sign in · ${PANEL_NAME} Admin`
    renderLogin({ container: root, api, notice, onSignedIn: ({ stats }) => showShell(stats) })
  }

  showLogin()
  return { navigate, refreshShell, api }
}

// Started by the page itself; imported (without starting) by the tests.
if (typeof document !== 'undefined' && document.getElementById('app') && !globalThis.__ADMIN_TEST__) {
  start({ root: document.getElementById('app') })
}
