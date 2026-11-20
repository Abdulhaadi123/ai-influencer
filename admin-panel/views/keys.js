/*
 * API keys: the KIE keys the server takes in turn for every new generation.
 *
 * KIE limits how much one account may start at once, so the studio's ceiling is one account's. Keys from more
 * KIE accounts raise it: each new generation goes to the next key in turn (backend/api/_lib/kieKeys.js), a key
 * KIE refuses is left alone for a while and the request moves on to the next, and a generation that is already
 * running is always followed with the key that started it.
 *
 * A key is typed here once. The server seals it and never shows it again; all this page ever holds is its last
 * four characters, to tell two keys apart.
 */

import { h, mount } from '../lib/dom.js'
import {
  badge, button, callout, card, confirmDialog, dataTable, emptyState, field, loadInto, notify, openDialog, pageHeader, skeletonRows, switchControl,
} from '../lib/components.js'
import { formatDate, formatNumber, plural, relativeTime } from '../lib/format.js'

// The same limits as the server (backend/api/admin/kieKeys.js); it checks everything again itself.
export const LABEL_MAX = 60
export const KEY_MIN = 16
export const KEY_MAX = 256
export const HOOK_MIN = 8
const VISIBLE = /^[\x21-\x7e]+$/

/** What the page shows for each state the server reports a key in. */
export const STATES = Object.freeze({
  active: { label: 'In rotation', tone: 'success' },
  cooling: { label: 'Waiting', tone: 'warning' },
  paused: { label: 'Paused', tone: 'neutral' },
  unreadable: { label: 'Can’t be read', tone: 'danger' },
  missing: { label: 'Not set', tone: 'neutral' },
})

/** Why KIE last refused a key. */
export const PROBLEMS = Object.freeze({
  rate_limited: 'KIE said to slow down',
  no_credits: 'Out of credits',
  rejected: 'KIE did not accept the key',
  unreadable: 'Sealed under a different vault secret',
})

/**
 * Check the add-a-key form. Mirrors what the server will accept, so a mistake is explained next to its field.
 *
 * @returns {{ok: boolean, errors: Record<string, string>, value: {label: string, key: string, webhookSecret?: string}}}
 */
export function validateKeyForm({ label, key, webhookSecret }) {
  const errors = {}
  const cleanLabel = String(label ?? '').trim()
  if (!cleanLabel) errors.label = 'Give the key a name, so you can tell it from the others.'
  else if (cleanLabel.length > LABEL_MAX) errors.label = `The name must be at most ${LABEL_MAX} characters.`

  const cleanKey = String(key ?? '').trim()
  if (!cleanKey) errors.key = 'Paste the API key.'
  else if (!VISIBLE.test(cleanKey)) errors.key = 'A key has no spaces or line breaks. Copy it again from KIE.'
  else if (cleanKey.length < KEY_MIN || cleanKey.length > KEY_MAX) errors.key = `A key is ${KEY_MIN} to ${KEY_MAX} characters long.`

  const cleanHook = String(webhookSecret ?? '').trim()
  if (cleanHook && !VISIBLE.test(cleanHook)) errors.webhookSecret = 'The webhook key has no spaces or line breaks.'
  else if (cleanHook && (cleanHook.length < HOOK_MIN || cleanHook.length > KEY_MAX)) errors.webhookSecret = `The webhook key is ${HOOK_MIN} to ${KEY_MAX} characters long.`

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: { label: cleanLabel, key: cleanKey, ...(cleanHook ? { webhookSecret: cleanHook } : {}) },
  }
}

/** One line on why a key is waiting, or was, or null when KIE has not refused it. */
export function problemLine(key, now = Date.now()) {
  if (!key.problem) return null
  const why = PROBLEMS[key.problem] || 'KIE refused it'
  return key.cooldownUntil
    ? `${why}. Asked again ${relativeTime(key.cooldownUntil, { now })}.`
    : `${why}, ${relativeTime(key.problemAt, { now })}.`
}

/** How many keys take turns now. A key that is waiting still counts: it is tried again when nothing else is free. */
export function inRotation(keys) {
  return keys.filter(k => k.state === 'active' || k.state === 'cooling').length
}

/** A paragraph of the "how it works" card: what, then the rule. */
const rule = (name, text) => h('p', {}, h('strong', {}, `${name}. `), text)

function howItWorks() {
  return card({
    title: 'How the keys are used',
    body: h('div', { class: 'stack-sm' },
      rule('Taking turns', 'Each new generation goes to the key that was used longest ago, so the work is shared evenly.'),
      rule('When KIE says no', 'If KIE refuses a key (it is rate limited, out of credits, or not accepted) the request moves on to the next key at once. That key waits at the back of the line, for seconds or minutes depending on why.'),
      rule('Running generations', 'A generation is always followed with the key that started it. So a key with generations running can be paused, but not removed until they have finished.'),
      rule('KIE accounts', 'KIE’s limits belong to the account, not to the key. Keys made in the same account share one limit; keys from different accounts each bring their own.'),
      rule('Webhook key', 'Each KIE account has its own Webhook HMAC key (kie.ai/settings). With it stored, results from that key arrive the moment they finish. Without it they come through the worker, within a minute or so.')),
  })
}

export function renderKeys(ctx) {
  const { api, container, signal, notify: say = notify } = ctx
  const body = h('div', { class: 'stack' })
  let keys = []
  let vaultReady = true

  const addButton = button({ label: 'Add a key', iconName: 'plus', tone: 'primary', onClick: () => add() })
  mount(container,
    pageHeader({
      title: 'API keys', subtitle: 'The KIE keys the server takes in turn for new generations, so one account’s limits stop being the studio’s.',
      actions: [addButton],
    }),
    body)

  function table() {
    return dataTable({
      label: 'KIE API keys', rows: keys, rowKey: k => k.id,
      columns: [
        { key: 'name', label: 'Key', render: k => h('div', {},
          h('div', { class: 'cell-main' }, k.label, k.source === 'env' ? badge('Server’s own', 'accent', { title: 'Set as KIE_API_KEY in the server’s .env' }) : null),
          h('div', { class: 'cell-sub mono' }, k.hint || 'KIE_API_KEY is not set')) },
        { key: 'state', label: 'Status', render: k => h('div', {},
          h('div', { class: 'switch-cell' },
            switchControl({ checked: k.enabled, label: `${k.enabled ? 'Pause' : 'Resume'} ${k.label}`, disabled: k.state === 'missing', onChange: next => toggle(k, next) }),
            badge(STATES[k.state]?.label ?? k.state, STATES[k.state]?.tone ?? 'neutral', { dot: true })),
          problemLine(k) ? h('div', { class: 'cell-note' }, problemLine(k)) : null) },
        { key: 'used', label: 'Used', align: 'right', render: k => h('div', {},
          h('div', { class: 'cell-main' }, formatNumber(k.uses)),
          h('div', { class: 'cell-sub' }, k.lastUsedAt ? relativeTime(k.lastUsedAt) : 'never', k.running ? ` · ${formatNumber(k.running)} running` : '')) },
        { key: 'balance', label: 'Credits left', align: 'right', hideBelow: 'md', render: k => (k.balance === null
          ? h('span', { class: 'muted', title: 'Press Check to ask KIE' }, '—')
          : h('div', {}, h('div', { class: 'cell-main' }, formatNumber(k.balance)), h('div', { class: 'cell-sub', title: formatDate(k.balanceAt) }, `checked ${relativeTime(k.balanceAt)}`))) },
        { key: 'callbacks', label: 'Instant results', hideBelow: 'lg', render: k => badge(k.callbacks ? 'On' : 'Off', k.callbacks ? 'success' : 'neutral',
          { title: k.callbacks ? 'KIE tells the server the moment a generation finishes' : 'Results come through the worker, within a minute or so' }) },
        { key: 'actions', label: '', align: 'right', className: 'col-actions', render: k => h('div', { class: 'row-buttons' },
          button({ label: 'Check', small: true, disabled: k.state === 'missing' || k.state === 'unreadable', onClick: () => check(k) }),
          button({ label: 'Edit', small: true, onClick: () => edit(k) }),
          k.source === 'panel' ? button({ label: 'Remove', small: true, tone: 'danger', onClick: () => remove(k) }) : null) },
      ],
    })
  }

  function load() {
    return loadInto(body, {
      signal,
      skeleton: () => skeletonRows(5, 3),
      load: () => api.get('/api/admin/kie-keys', null, { signal }),
      render: data => {
        keys = data.keys
        vaultReady = data.vault?.configured !== false
        addButton.disabled = !vaultReady
        const taking = inRotation(keys)
        mount(body,
          !vaultReady
            ? callout({
              tone: 'warning', title: 'Keys can’t be added yet',
              body: 'Keys are stored sealed, with a secret that lives only on the server. Set KEY_VAULT_SECRET (32 or more random characters) in the server’s .env, then restart the api and worker. Keys already stored cannot be read until it is set.',
            })
            : null,
          taking === 0
            ? callout({ tone: 'danger', title: 'No key is in rotation', body: 'New generations are refused until a key is switched on. Generations already running are still followed.' })
            : taking === 1
              ? callout({ tone: 'info', title: 'One key is taking all the turns', body: 'Add a key from another KIE account to share the load.' })
              : null,
          card({
            flush: true, title: 'Keys', subtitle: `${plural(keys.length, 'key')}, ${taking} taking turns`,
            body: keys.length ? table() : emptyState({ iconName: 'key', title: 'No keys', body: 'Add a key to start.' }),
          }),
          howItWorks())
      },
    })
  }

  /** The switch. Pausing the last key that takes turns refuses every new generation, so that one asks first. */
  async function toggle(key, next) {
    if (!next && inRotation(keys) === 1 && (key.state === 'active' || key.state === 'cooling')) {
      const yes = await confirmDialog({
        title: `Pause ${key.label}?`, tone: 'danger', confirmLabel: 'Pause it',
        description: 'It is the only key taking turns. With it paused, every new generation is refused until a key is switched on. Generations already running are still followed.',
      })
      if (!yes) throw new Error('cancelled')
    }
    try {
      await api.post('/api/admin/kie-keys/update', { id: key.id, enabled: next })
      say.success(`${key.label} is ${next ? 'taking turns again' : 'paused'}.`)
      load()
    } catch (e) { say.error(e, 'Could not change the key'); throw e }
  }

  /** Ask KIE whether the key works and what is left on it. */
  async function check(key) {
    try {
      const { result, key: fresh } = await api.post('/api/admin/kie-keys/check', { id: key.id })
      if (result === 'rejected') say.error(new Error('KIE does not accept this key.'), `${key.label}`)
      else say.success(fresh.balance === null ? `${key.label}: KIE accepts it.` : `${key.label}: KIE accepts it, ${formatNumber(fresh.balance)} credits left.`)
      load()
    } catch (e) { say.error(e, 'Could not check the key') }
  }

  async function add() {
    const label = h('input', { class: 'control', type: 'text', maxlength: LABEL_MAX, placeholder: 'e.g. KIE account 2', autocomplete: 'off' })
    const key = h('input', { class: 'control mono', type: 'password', placeholder: 'Paste the API key', autocomplete: 'off', spellcheck: 'false' })
    const hook = h('input', { class: 'control mono', type: 'password', placeholder: 'Optional', autocomplete: 'off', spellcheck: 'false' })
    const verify = h('input', { type: 'checkbox', checked: true })
    const errors = { label: h('div', { class: 'field-error' }), key: h('div', { class: 'field-error' }), webhookSecret: h('div', { class: 'field-error' }) }

    const done = await openDialog({
      title: 'Add a KIE key', confirmLabel: 'Add key',
      description: 'The key is sealed on the server and never shown again.',
      content: h('div', {},
        field({ label: 'Name', hint: 'Only for you: which KIE account it belongs to.', control: label }), errors.label,
        field({ label: 'API key', control: key }), errors.key,
        field({ label: 'Webhook key', hint: 'Optional. That account’s Webhook HMAC key from kie.ai/settings. With it, results arrive the moment they finish.', control: hook }), errors.webhookSecret,
        h('label', { class: 'check' }, verify, h('span', {}, h('strong', {}, 'Check the key with KIE first'), h('span', { class: 'muted small block' }, 'Catches a key that was copied wrong. Untick only if KIE cannot be reached.')))),
      onConfirm: async () => {
        const result = validateKeyForm({ label: label.value, key: key.value, webhookSecret: hook.value })
        for (const [name, node] of Object.entries(errors)) node.textContent = result.errors[name] || ''
        if (!result.ok) throw new Error('Fix the highlighted fields.')
        return api.post('/api/admin/kie-keys/add', { ...result.value, verify: verify.checked })
      },
    })
    if (done) { say.success(`Added ${done.key.label}.`); load() }
  }

  async function edit(key) {
    const label = h('input', { class: 'control', type: 'text', maxlength: LABEL_MAX, value: key.label, autocomplete: 'off' })
    const hook = h('input', { class: 'control mono', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: key.callbacks ? 'Leave empty to keep the stored one' : 'Optional' })
    const clear = h('input', { type: 'checkbox' })
    const own = key.source === 'env'

    const done = await openDialog({
      title: `Edit ${key.label}`, confirmLabel: 'Save',
      content: h('div', {},
        field({ label: 'Name', control: label }),
        own
          ? h('p', { class: 'muted small' }, 'The server’s own key and its webhook key are set in the server’s .env (KIE_API_KEY, KIE_WEBHOOK_SECRET).')
          : h('div', {},
            field({ label: 'Webhook key', hint: 'That account’s Webhook HMAC key from kie.ai/settings.', control: hook }),
            key.callbacks ? h('label', { class: 'check' }, clear, h('span', {}, 'Remove the stored webhook key')) : null)),
      onConfirm: async () => {
        const name = label.value.trim()
        if (!name) throw new Error('Give the key a name.')
        if (name.length > LABEL_MAX) throw new Error(`The name must be at most ${LABEL_MAX} characters.`)
        const changes = {}
        if (name !== key.label) changes.label = name
        const typed = hook.value.trim()
        if (!own && typed) {
          const result = validateKeyForm({ label: name, key: 'x'.repeat(KEY_MIN), webhookSecret: typed })
          if (result.errors.webhookSecret) throw new Error(result.errors.webhookSecret)
          changes.webhookSecret = typed
        } else if (!own && clear.checked) changes.webhookSecret = null
        if (!Object.keys(changes).length) return { unchanged: true }
        return api.post('/api/admin/kie-keys/update', { id: key.id, ...changes })
      },
    })
    if (done && !done.unchanged) { say.success(`Saved ${done.key.label}.`); load() }
  }

  async function remove(key) {
    const yes = await confirmDialog({
      title: `Remove ${key.label}?`, tone: 'danger', confirmLabel: 'Remove key',
      description: 'The key is deleted from the server. New generations stop using it at once. To use it again it has to be added again.',
    })
    if (!yes) return
    try {
      await api.post('/api/admin/kie-keys/delete', { id: key.id })
      say.success(`Removed ${key.label}.`)
      load()
    } catch (e) { say.error(e, 'Could not remove the key') }
  }

  load()
  return { destroy() {} }
}
