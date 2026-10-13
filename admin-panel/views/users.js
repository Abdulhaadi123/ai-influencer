/*
 * Accounts: find a person, see how they are doing, act on them.
 *
 * A row opens a side panel (the address becomes #/users/<id>, so it can be shared
 * and Back closes it) with what a moderator needs before deciding anything: their
 * strikes, their devices, their recent jobs and flags, and every action available.
 *
 * What may be done to whom is decided in ONE place, userActions(), which is also
 * what the server enforces — the buttons are disabled with the reason, never hidden
 * and never trusted: the server refuses the same things.
 */

import { h, mount } from '../lib/dom.js'
import { buildRoute, intParam, oneOf, withQuery } from '../lib/router.js'
import {
  avatar, badge, button, callout, confirmDialog, copyButton, dataTable, debounce, emptyState, errorState, loadInto,
  menuButton, meter, notify, openDialog, openDrawer, pageHeader, pager, searchBox, segmented, skeletonRows, field,
} from '../lib/components.js'
import {
  actionLabel, categoryLabel, formatBytes, formatDate, formatNumber, plural, relativeTime, sourceLabel, stateLabel, truncate,
} from '../lib/format.js'

const SORTS = ['created', 'email', 'jobs', 'credits', 'flags', 'storage']
const PAGE_SIZES = [25, 50, 100]
const REASON_MAX = 300

/**
 * What an admin may do to an account, and why not when they may not.
 *
 * @param {{id: string, role: string, status: string}} user  the account
 * @param {{id: string}} me  the signed-in admin
 */
const NOTE_MAX = 300

/** What a ledger row's kind is called on screen. */
export function creditKind(kind) {
  return ({
    purchase: 'Bought a pack', grant: 'Credits given', adjust: 'Correction', spend: 'Used for a generation',
    refund: 'Given back', clawback: 'Taken back (refunded purchase)',
  })[kind] ?? kind
}

export function userActions(user, me) {
  const self = user.id === me.id
  const isAdmin = user.role === 'admin'
  const suspended = user.status === 'suspended'
  const own = 'You cannot do this to your own account.'
  const admin = 'Remove their admin role first.'
  return {
    self,
    canSuspend: !self && !isAdmin && !suspended,
    canRestore: suspended,
    canPromote: !self && !isAdmin,
    canDemote: !self && isAdmin,
    canDelete: !self && !isAdmin,
    why: {
      suspend: self ? own : isAdmin ? admin : null,
      role: self ? own : null,
      delete: self ? own : isAdmin ? admin : null,
    },
  }
}

/** The row's status badges. */
function statusBadges(user) {
  return h('div', { class: 'badges' },
    user.status === 'suspended' ? badge('Suspended', 'danger', { dot: true }) : badge('Active', 'success', { dot: true }),
    user.role === 'admin' ? badge('Admin', 'accent') : null,
    !user.emailConfirmed ? badge('Unverified', 'warning', { title: 'The email address has not been confirmed.' }) : null)
}

export function renderUsers(ctx) {
  const { api, container, navigate, notify: say = notify } = ctx
  let route = ctx.route
  const me = ctx.me

  let listAbort = new AbortController()
  let drawer = null
  let drawerFor = null
  let drawerAbort = null
  let first = true

  const params = () => ({
    q: route.query.q || '',
    status: oneOf(route.query.status, ['active', 'suspended'], ''),
    sort: oneOf(route.query.sort, SORTS, 'created'),
    dir: oneOf(route.query.dir, ['asc', 'desc'], 'desc'),
    page: intParam(route.query.page, 1),
    pageSize: oneOf(Number(route.query.pageSize), PAGE_SIZES, 25),
  })
  const listKey = () => JSON.stringify(params())
  const go = changes => navigate(withQuery({ ...route, id: null }, changes))

  // ── The toolbar: built once, so typing never loses focus to a re-render ────
  const search = searchBox({
    value: params().q, placeholder: 'Search by email or name', label: 'Search accounts',
    onInput: debounce(value => go({ q: value.trim(), page: null }), 300),
  })
  const statusFilter = h('div', { class: 'toolbar-item' })
  const results = h('div', { class: 'card card-flush' })
  const summary = h('span', { class: 'muted', 'aria-live': 'polite' })

  function paintStatusFilter() {
    mount(statusFilter, segmented({
      label: 'Status', value: params().status,
      options: [{ value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }],
      onChange: value => go({ status: value, page: null }),
    }))
  }

  mount(container,
    pageHeader({ title: 'Accounts', subtitle: 'Everyone who has signed up. Open a row for their activity and actions.' }),
    h('div', { class: 'toolbar' }, search, statusFilter, h('span', { class: 'toolbar-spacer' }), summary),
    results)

  // ── The list ───────────────────────────────────────────────────────────────
  function loadList() {
    listAbort.abort()
    listAbort = new AbortController()
    const p = params()
    paintStatusFilter()
    const input = search.querySelector('input')
    if (input && document.activeElement !== input && input.value !== p.q) input.value = p.q

    return loadInto(results, {
      signal: listAbort.signal,
      skeleton: () => skeletonRows(6, 7),
      load: () => api.get('/api/admin/users', p, { signal: listAbort.signal }),
      render: data => {
        summary.textContent = `${plural(data.total, 'account')}${p.q || p.status ? ' match' : ''}`
        if (!data.users.length) {
          const filtered = Boolean(p.q || p.status)
          mount(results, emptyState({
            iconName: filtered ? 'search' : 'users',
            title: filtered ? 'No accounts match' : 'No accounts yet',
            body: filtered ? 'Try a different search, or clear the filters.' : 'People appear here when they sign up.',
            action: filtered ? button({ label: 'Clear filters', onClick: () => go({ q: null, status: null, page: null }) }) : null,
          }))
          return
        }
        mount(results,
          dataTable({
            label: 'Accounts', rows: data.users, selectedKey: route.id, sort: { key: p.sort, dir: p.dir },
            onSort: (key, dir) => go({ sort: key === 'created' && dir === 'desc' ? null : key, dir: dir === 'desc' ? null : dir, page: null }),
            onRowClick: user => navigate(buildRoute('users', { id: user.id, query: route.query })),
            columns: [
              { key: 'account', label: 'Account', sortKey: 'email', defaultDir: 'asc', render: u => userCell(u, me) },
              { key: 'status', label: 'Status', render: statusBadges },
              { key: 'joined', label: 'Joined', sortKey: 'created', hideBelow: 'sm', render: u => h('time', { datetime: u.createdAt, title: formatDate(u.createdAt) }, relativeTime(u.createdAt)) },
              { key: 'jobs', label: 'Jobs', sortKey: 'jobs', align: 'right', hideBelow: 'sm', render: u => formatNumber(u.jobs) },
              { key: 'credits', label: 'KIE credits', sortKey: 'credits', align: 'right', hideBelow: 'lg', render: u => formatNumber(u.kieCredits) },
              { key: 'storage', label: 'Storage', sortKey: 'storage', align: 'right', hideBelow: 'lg', render: u => formatBytes(u.storageBytes) },
              { key: 'flags', label: 'Flags', sortKey: 'flags', align: 'right', render: u => (u.openEvents ? badge(String(u.openEvents), 'warning', { title: 'Open moderation items' }) : h('span', { class: 'muted' }, '—')) },
              { key: 'actions', label: '', align: 'right', className: 'col-actions', render: u => rowMenu(u) },
            ],
          }),
          pager({ page: data.page, pageSize: data.pageSize, total: data.total, sizes: PAGE_SIZES, onChange: ({ page, pageSize }) => go({ page: page === 1 ? null : page, pageSize: pageSize === 25 ? null : pageSize }) }))
      },
    })
  }

  function rowMenu(user) {
    const a = userActions(user, me)
    return menuButton({
      label: `Actions for ${user.email}`,
      items: [
        { label: 'View details', iconName: 'users', onSelect: () => navigate(buildRoute('users', { id: user.id, query: route.query })) },
        { separator: true },
        ...(a.canRestore
          ? [{ label: 'Restore account', iconName: 'user-check', onSelect: () => restore(user) }]
          : [{ label: 'Suspend…', iconName: 'user-x', disabled: !a.canSuspend, title: a.why.suspend, onSelect: () => suspend(user) }]),
        a.canDemote
          ? { label: 'Remove admin role…', iconName: 'shield', onSelect: () => changeRole(user, 'user') }
          : { label: 'Make administrator…', iconName: 'shield', disabled: !a.canPromote, title: a.why.role, onSelect: () => changeRole(user, 'admin') },
        { separator: true },
        { label: 'Delete account…', iconName: 'trash', tone: 'danger', disabled: !a.canDelete, title: a.why.delete, onSelect: () => remove(user) },
      ],
    })
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function afterChange() {
    ctx.refreshShell?.()
    await loadList()
    if (drawerFor) loadDrawer(drawerFor)
  }

  async function suspend(user) {
    const reason = h('textarea', { class: 'control', rows: 3, maxlength: REASON_MAX, required: true, placeholder: 'Why? This is recorded in the audit log.' })
    const counter = h('span', { class: 'muted' }, `0 / ${REASON_MAX}`)
    reason.addEventListener('input', () => { counter.textContent = `${reason.value.length} / ${REASON_MAX}` })
    const done = await openDialog({
      title: `Suspend ${user.email}?`, tone: 'danger', confirmLabel: 'Suspend account',
      description: 'They are signed out on every device straight away and cannot sign in until you restore them. Nothing is deleted.',
      content: h('div', {}, field({ label: 'Reason', control: reason }), h('div', { class: 'field-hint-right' }, counter)),
      onConfirm: async () => {
        const text = reason.value.trim()
        if (!text) throw new Error('Give a reason — it goes in the audit log.')
        if (text.length > REASON_MAX) throw new Error(`The reason must be at most ${REASON_MAX} characters.`)
        return api.post('/api/admin/users/suspend', { userId: user.id, reason: text })
      },
    })
    if (done) { say.success(`${user.email} was suspended and signed out everywhere.`); afterChange() }
  }

  async function restore(user) {
    const yes = await confirmDialog({ title: `Restore ${user.email}?`, description: 'They will be able to sign in again.', confirmLabel: 'Restore account' })
    if (!yes) return
    try {
      await api.post('/api/admin/users/unsuspend', { userId: user.id })
      say.success(`${user.email} can sign in again.`)
      afterChange()
    } catch (e) { say.error(e, 'Could not restore the account') }
  }

  /** Give an account credits (a positive number) or take some back (a negative one). */
  async function changeCredits(user, balance) {
    const amount = h('input', { class: 'control', type: 'number', step: 'any', inputmode: 'decimal', required: true, placeholder: 'e.g. 500, or -100 to take credits back' })
    const note = h('textarea', { class: 'control', rows: 2, maxlength: NOTE_MAX, required: true, placeholder: 'Why? This is recorded in the audit log.' })
    const done = await openDialog({
      title: `Add or remove credits for ${user.email}`, confirmLabel: 'Save credits',
      description: `They have ${formatNumber(balance)} credits now. A positive number gives credits, a negative one takes them back; the balance may go below zero.`,
      content: h('div', {}, field({ label: 'Credits', control: amount }), field({ label: 'Reason', control: note })),
      onConfirm: async () => {
        const credits = Number(amount.value)
        if (amount.value.trim() === '' || !Number.isFinite(credits) || credits === 0) throw new Error('Enter a number of credits other than 0.')
        const reason = note.value.trim()
        if (!reason) throw new Error('Give a reason — it goes in the audit log.')
        return api.post('/api/admin/billing/grant', { userId: user.id, credits, note: reason })
      },
    })
    if (done) { say.success(`${user.email} now has ${formatNumber(done.balance)} credits.`); afterChange() }
  }

  async function changeRole(user, role) {
    const promoting = role === 'admin'
    const yes = await confirmDialog({
      title: promoting ? `Make ${user.email} an administrator?` : `Remove admin from ${user.email}?`,
      description: promoting
        ? 'They will be able to see every account and flagged file, suspend and delete accounts, and change prices and settings. Everything they do is recorded.'
        : 'They become a regular user straight away and lose access to this panel.',
      confirmLabel: promoting ? 'Make administrator' : 'Remove admin role', tone: promoting ? 'primary' : 'danger',
    })
    if (!yes) return
    try {
      await api.post('/api/admin/users/set-role', { userId: user.id, role })
      say.success(promoting ? `${user.email} is now an administrator.` : `${user.email} is no longer an administrator.`)
      afterChange()
    } catch (e) { say.error(e, 'Could not change the role') }
  }

  async function remove(user) {
    const typed = h('input', { class: 'control', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: user.email })
    const done = await openDialog({
      title: `Delete ${user.email}?`, tone: 'danger', confirmLabel: 'Delete forever',
      description: 'This permanently deletes the account, every influencer, and every file stored for it. It cannot be undone.',
      content: field({ label: `Type ${user.email} to confirm`, control: typed }),
      onConfirm: async () => {
        if (typed.value.trim().toLowerCase() !== user.email.toLowerCase()) throw new Error('That is not the account’s email address.')
        return api.post('/api/admin/users/delete', { userId: user.id, confirmEmail: typed.value })
      },
    })
    if (done) {
      say.success(`${user.email} was deleted.`)
      if (drawerFor === user.id) closeDrawer({ navigateAway: true })
      afterChange()
    }
  }

  // ── The side panel ─────────────────────────────────────────────────────────
  function closeDrawer({ navigateAway = false } = {}) {
    drawerAbort?.abort()
    drawer?.close({ silent: true })
    drawer = null
    drawerFor = null
    if (navigateAway) navigate(buildRoute('users', { query: route.query }))
  }

  function openDrawerFor(id) {
    closeDrawer()
    drawerFor = id
    drawer = openDrawer({
      title: 'Account', subtitle: 'Loading…', content: [skeletonRows(2, 8)],
      onClose: () => { drawer = null; drawerFor = null; drawerAbort?.abort(); navigate(buildRoute('users', { query: route.query })) },
    })
    loadDrawer(id)
  }

  async function loadDrawer(id) {
    drawerAbort?.abort()
    drawerAbort = new AbortController()
    const { signal } = drawerAbort
    try {
      const detail = await api.get('/api/admin/users/detail', { userId: id }, { signal })
      if (drawerFor !== id || !drawer) return
      paintDrawer(detail)
    } catch (e) {
      if (e?.name === 'AbortError' || drawerFor !== id || !drawer) return
      drawer.setTitle('Account', '')
      drawer.setContent(e.status === 404
        ? emptyState({ iconName: 'users', title: 'That account no longer exists', body: 'It may have been deleted.', action: button({ label: 'Close', onClick: () => closeDrawer({ navigateAway: true }) }) })
        : errorState({ message: e.message, onRetry: () => loadDrawer(id) }))
    }
  }

  function paintDrawer(detail) {
    const { user } = detail
    const a = userActions(user, me)
    drawer.setTitle(user.email, user.displayName || 'No display name')

    const fact = (label, value) => h('div', { class: 'fact' }, h('dt', {}, label), h('dd', {}, value))
    const overLimit = detail.strikes.count >= detail.strikes.limit

    drawer.setContent(
      h('div', { class: 'stack' },
        h('div', { class: 'drawer-identity' }, avatar(user.email, 52), h('div', {}, statusBadges(user), h('div', { class: 'muted mono small' }, user.id, copyButton(user.id, 'Copy the account id')))),

        user.status === 'suspended'
          ? callout({ tone: 'danger', iconName: 'lock', title: `Suspended ${relativeTime(user.suspendedAt)}`, body: user.suspendedReason || 'No reason recorded.' })
          : null,

        h('dl', { class: 'facts' },
          fact('Joined', h('span', { title: formatDate(user.createdAt) }, relativeTime(user.createdAt))),
          fact('Last active', detail.devices.lastUsedAt ? relativeTime(detail.devices.lastUsedAt) : 'Never'),
          fact('Signed in on', plural(detail.devices.active, 'device')),
          fact('Influencers', formatNumber(detail.influencers)),
          fact('Jobs', formatNumber(user.jobs)),
          fact('KIE credits', formatNumber(user.kieCredits)),
          fact('Storage', formatBytes(user.storageBytes)),
          fact('Email', user.emailConfirmed ? 'Verified' : 'Not verified')),

        h('section', { class: 'drawer-section' },
          h('div', { class: 'section-head' }, h('h3', {}, 'Credits'),
            badge(`${formatNumber(detail.credits.balance)} credits`, detail.credits.balance < 0 ? 'danger' : detail.credits.balance > 0 ? 'success' : 'neutral')),
          detail.credits.enforced ? null : h('p', { class: 'muted small' }, 'Credits are not being charged yet: nobody is stopped for lacking them.'),
          detail.credits.recent.length
            ? h('ul', { class: 'mini-list' }, detail.credits.recent.map(c => h('li', { class: 'mini-row mini-row-flat' },
              h('div', { class: 'mini-main' }, h('span', { class: 'small' }, creditKind(c.kind)), h('span', { class: 'muted small' }, relativeTime(c.createdAt))),
              h('div', { class: 'badges' }, badge(`${c.delta > 0 ? '+' : ''}${formatNumber(c.delta)}`, c.delta > 0 ? 'success' : 'neutral')),
              c.note ? h('div', { class: 'muted small' }, truncate(c.note, 90), c.by ? ` · ${c.by}` : '') : null)))
            : h('p', { class: 'muted small' }, 'No credit activity yet.'),
          button({ label: 'Add or remove credits…', iconName: 'coins', onClick: () => changeCredits(user, detail.credits.balance) })),

        h('section', { class: 'drawer-section' },
          h('div', { class: 'section-head' }, h('h3', {}, 'Moderation strikes'), badge(`${detail.strikes.count} / ${detail.strikes.limit}`, overLimit ? 'danger' : detail.strikes.count ? 'warning' : 'success')),
          meter({ value: detail.strikes.count, max: detail.strikes.limit, tone: overLimit ? 'danger' : detail.strikes.count ? 'warning' : 'success', label: 'Strikes' }),
          h('p', { class: 'muted small' }, `Refused prompts and uploads in the last ${detail.strikes.windowDays} days. At ${detail.strikes.limit} the account is suspended automatically${user.role === 'admin' ? ' — except administrators, who never are' : ''}.`),
          h('div', { class: 'badges' }, badge(`${formatNumber(detail.assets.byStatus.clear)} clear`, 'success'), badge(`${formatNumber(detail.assets.byStatus.unchecked)} unchecked`, 'neutral'),
            badge(`${formatNumber(detail.assets.byStatus.blocked)} blocked`, detail.assets.byStatus.blocked ? 'danger' : 'neutral'))),

        h('section', { class: 'drawer-section' },
          h('div', { class: 'section-head' }, h('h3', {}, 'Recent flags'),
            h('a', { class: 'link small', href: buildRoute('moderation', { query: { userId: user.id, status: 'all' } }) }, 'View all')),
          detail.recentEvents.length
            ? h('ul', { class: 'mini-list' }, detail.recentEvents.map(e => h('li', {},
              h('a', { class: 'mini-row', href: buildRoute('moderation', { id: e.id, query: { status: 'all' } }) },
                h('div', { class: 'badges' }, badge(sourceLabel(e.source)), badge(actionLabel(e.action), e.action === 'blocked' ? 'danger' : 'warning'), e.status !== 'open' ? badge(e.status, 'neutral') : null),
                h('div', { class: 'muted small' }, e.categories.map(categoryLabel).join(', ') || '—', ' · ', relativeTime(e.createdAt)),
                e.excerpt ? h('div', { class: 'small quote-line' }, truncate(e.excerpt, 90)) : null))))
            : h('p', { class: 'muted small' }, 'Nothing has been flagged for this account.')),

        h('section', { class: 'drawer-section' },
          h('div', { class: 'section-head' }, h('h3', {}, 'Recent jobs'),
            h('a', { class: 'link small', href: buildRoute('jobs', { query: { userId: user.id } }) }, 'View all')),
          detail.recentJobs.length
            ? h('ul', { class: 'mini-list' }, detail.recentJobs.map(j => h('li', { class: 'mini-row mini-row-flat' },
              h('div', { class: 'mini-main' }, h('span', { class: 'mono small' }, j.model || '—'), h('span', { class: 'muted small' }, relativeTime(j.createdAt))),
              h('div', { class: 'badges' }, badge(stateLabel(j.state), j.state === 'success' ? 'success' : j.state === 'fail' ? 'danger' : 'info'),
                h('span', { class: 'muted small', title: j.kieCredits === null ? 'KIE did not report a charge' : '' }, j.kieCredits === null ? '— credits' : `${formatNumber(j.kieCredits)} credits`)),
              j.failMessage ? h('div', { class: 'small error-text' }, truncate(j.failMessage, 110)) : null)))
            : h('p', { class: 'muted small' }, 'No jobs yet.')),

        h('section', { class: 'drawer-section drawer-actions' },
          h('h3', {}, 'Actions'),
          h('div', { class: 'action-grid' },
            a.canRestore
              ? button({ label: 'Restore account', iconName: 'user-check', tone: 'primary', onClick: () => restore(user) })
              : button({ label: 'Suspend…', iconName: 'user-x', disabled: !a.canSuspend, title: a.why.suspend, onClick: () => suspend(user) }),
            a.canDemote
              ? button({ label: 'Remove admin role…', iconName: 'shield', onClick: () => changeRole(user, 'user') })
              : button({ label: 'Make administrator…', iconName: 'shield', disabled: !a.canPromote, title: a.why.role, onClick: () => changeRole(user, 'admin') })),
          h('div', { class: 'danger-zone' },
            h('div', {}, h('strong', {}, 'Delete account'), h('div', { class: 'muted small' }, 'Permanently removes the account and everything in it.')),
            button({ label: 'Delete…', iconName: 'trash', tone: 'danger', disabled: !a.canDelete, title: a.why.delete, onClick: () => remove(user) })))))
  }

  // ── Following the address ──────────────────────────────────────────────────
  function sync(next) {
    const before = listKey()
    route = next
    if (first || listKey() !== before) loadList()
    first = false
    if (route.id) { if (drawerFor !== route.id) openDrawerFor(route.id) }
    else if (drawer) closeDrawer()
    // The selected row follows the drawer.
    for (const tr of results.querySelectorAll('tr.row')) tr.classList.toggle('row-selected', tr.getAttribute('data-key') === route.id)
  }

  sync(route)
  return {
    update: sync,
    destroy() { listAbort.abort(); closeDrawer() },
  }
}

function userCell(user, me) {
  return h('div', { class: 'user-cell' },
    avatar(user.email, 42),
    h('div', { class: 'user-cell-text' },
      h('div', { class: 'user-cell-main' }, user.email, user.id === me.id ? badge('You', 'neutral') : null),
      h('div', { class: 'muted small' }, user.displayName || '—')))
}
