/*
 * Prices: what each model costs a user, and whether it may be used at all.
 *
 * The price is recorded now and applied when billing is switched on — the page
 * says so. The switch is different: turning a model off is live, at once, for every
 * new request, so turning it off asks first.
 *
 * A model that real jobs have used but that nobody priced is listed separately,
 * with a button to price it, so nothing is served for free by being forgotten.
 */

import { h, mount } from '../lib/dom.js'
import {
  badge, button, callout, card, confirmDialog, copyButton, dataTable, emptyState, field, loadInto, notify, openDialog, pageHeader, skeletonRows, switchControl,
} from '../lib/components.js'
import { UNIT_LABELS, formatDate, formatNumber, plural, relativeTime } from '../lib/format.js'

export const UNITS = ['per_second', 'per_video', 'per_image']
const MODEL_ID = /^[A-Za-z0-9][\w.\-/:]{0,199}$/
const MAX_CREDITS = 1_000_000

/**
 * Check the price form. Mirrors what the server will accept (api/admin/prices.js),
 * so a mistake is explained next to the field, not as a refusal afterwards — the
 * server still checks everything itself.
 *
 * @returns {{ok: boolean, errors: Record<string, string>, value: object}}
 */
export function validatePriceForm({ model, unit, credits, enabled, label, note }) {
  const errors = {}
  const cleanModel = String(model ?? '').trim()
  if (!cleanModel) errors.model = 'Enter the model id.'
  else if (!MODEL_ID.test(cleanModel)) errors.model = 'A model id has letters, numbers and . - _ / : only, like kling-3.0/video.'

  if (!UNITS.includes(unit)) errors.unit = 'Choose what the price is per.'

  const raw = String(credits ?? '').trim()
  const n = Number(raw)
  if (raw === '') errors.credits = 'Enter a price. Use 0 only if the model is meant to be free.'
  else if (!Number.isFinite(n) || n < 0) errors.credits = 'The price must be a number, zero or more.'
  else if (n > MAX_CREDITS) errors.credits = `The price cannot be more than ${formatNumber(MAX_CREDITS)}.`

  const cleanLabel = String(label ?? '').trim()
  if (cleanLabel.length > 120) errors.label = 'The label must be at most 120 characters.'
  const cleanNote = String(note ?? '').trim()
  if (cleanNote.length > 300) errors.note = 'The note must be at most 300 characters.'

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: {
      model: cleanModel, unit, credits: n, enabled: Boolean(enabled),
      ...(cleanLabel ? { label: cleanLabel } : {}), ...(cleanNote ? { note: cleanNote } : {}),
    },
  }
}

export function renderPrices(ctx) {
  const { api, container, signal, notify: say = notify } = ctx
  const body = h('div', { class: 'stack' })

  mount(container,
    pageHeader({
      title: 'Prices', subtitle: 'What each model costs a user, in credits — and whether it may be used.',
      actions: [button({ label: 'Add a price', iconName: 'plus', tone: 'primary', onClick: () => edit({}) })],
    }),
    body)

  let units = UNITS

  function load() {
    return loadInto(body, {
      signal,
      skeleton: () => skeletonRows(5, 4),
      load: () => api.get('/api/admin/prices', null, { signal }),
      render: data => {
        units = data.units
        mount(body,
          callout({
            tone: 'info', title: 'Prices are recorded now and applied when billing is switched on',
            body: 'The on/off switch is different: it is live. A model switched off is refused straight away for every new generation.',
          }),
          card({
            flush: true, title: 'Priced models', subtitle: plural(data.prices.length, 'model'),
            body: data.prices.length
              ? dataTable({
                label: 'Model prices', rows: data.prices, rowKey: p => p.model,
                columns: [
                  { key: 'model', label: 'Model', render: p => h('div', {}, h('div', { class: 'mono small' }, p.model, copyButton(p.model, 'Copy the model id')), p.label ? h('div', { class: 'muted small' }, p.label) : null) },
                  { key: 'price', label: 'Price', align: 'right', render: p => h('span', {}, h('strong', {}, formatNumber(p.credits)), h('span', { class: 'muted' }, ` credits / ${UNIT_LABELS[p.unit] || p.unit}`)) },
                  { key: 'enabled', label: 'Allowed', render: p => h('div', { class: 'switch-cell' },
                    switchControl({ checked: p.enabled, label: `${p.enabled ? 'Disable' : 'Enable'} ${p.model}`, onChange: next => toggle(p, next) }),
                    badge(p.enabled ? 'On' : 'Off', p.enabled ? 'success' : 'danger')) },
                  { key: 'note', label: 'Note', hideBelow: 'md', render: p => (p.note ? h('span', { class: 'muted small' }, p.note) : h('span', { class: 'muted' }, '—')) },
                  { key: 'updated', label: 'Updated', hideBelow: 'sm', render: p => h('div', { class: 'small' }, h('span', { title: formatDate(p.updatedAt) }, relativeTime(p.updatedAt)), p.updatedBy ? h('div', { class: 'muted' }, p.updatedBy) : null) },
                  { key: 'actions', label: '', align: 'right', className: 'col-actions', render: p => h('div', { class: 'row-buttons' },
                    button({ label: 'Edit', small: true, onClick: () => edit(p) }),
                    button({ label: 'Delete', small: true, tone: 'danger', onClick: () => remove(p) })) },
                ],
              })
              : emptyState({ iconName: 'prices', title: 'No prices yet', body: 'Add one to start pricing models. Until then every model is allowed and unpriced.', action: button({ label: 'Add a price', iconName: 'plus', tone: 'primary', onClick: () => edit({}) }) }),
          }),
          data.unpriced.length
            ? card({
              title: 'In use, but not priced', subtitle: 'Real jobs have run on these models and no price is set.', flush: true,
              body: dataTable({
                label: 'Unpriced models', rows: data.unpriced, rowKey: m => m.model,
                columns: [
                  { key: 'model', label: 'Model', render: m => h('span', { class: 'mono small' }, m.model) },
                  { key: 'jobs', label: 'Jobs', align: 'right', render: m => formatNumber(m.jobs) },
                  { key: 'credits', label: 'KIE credits so far', align: 'right', render: m => formatNumber(m.kieCredits) },
                  { key: 'actions', label: '', align: 'right', render: m => button({ label: 'Set a price', small: true, tone: 'primary', onClick: () => edit({ model: m.model, enabled: true }) }) },
                ],
              }),
            })
            : null)
      },
    })
  }

  /** The switch: turning a model OFF asks, because it takes effect at once. */
  async function toggle(price, next) {
    if (!next) {
      const yes = await confirmDialog({
        title: `Switch off ${price.model}?`, tone: 'danger', confirmLabel: 'Switch off',
        description: 'New generations with this model are refused immediately. Jobs already running are not affected.',
      })
      if (!yes) throw new Error('cancelled')
    }
    try {
      await api.post('/api/admin/prices/upsert', {
        model: price.model, unit: price.unit, credits: price.credits, enabled: next,
        ...(price.label ? { label: price.label } : {}), ...(price.note ? { note: price.note } : {}),
      })
      say.success(`${price.model} is ${next ? 'on' : 'off'}.`)
      load()
    } catch (e) { say.error(e, 'Could not change the model'); throw e }
  }

  async function edit(price) {
    const isNew = !price.updatedAt
    const model = h('input', { class: 'control mono', type: 'text', value: price.model || '', readonly: Boolean(price.model), spellcheck: 'false', autocomplete: 'off', placeholder: 'kling-3.0/video' })
    const label = h('input', { class: 'control', type: 'text', value: price.label || '', placeholder: 'A name people recognise' })
    const unit = h('select', { class: 'control', value: price.unit || 'per_video' }, units.map(u => h('option', { value: u, selected: u === (price.unit || 'per_video') }, `per ${UNIT_LABELS[u] || u}`)))
    const credits = h('input', { class: 'control', type: 'number', min: 0, step: '0.001', inputmode: 'decimal', value: price.credits ?? '', placeholder: 'e.g. 20' })
    const enabled = h('input', { type: 'checkbox', checked: price.enabled !== false })
    const note = h('input', { class: 'control', type: 'text', value: price.note || '', placeholder: 'Why this price' })
    const errors = { model: h('div', { class: 'field-error' }), unit: h('div', { class: 'field-error' }), credits: h('div', { class: 'field-error' }), label: h('div', { class: 'field-error' }), note: h('div', { class: 'field-error' }) }

    const done = await openDialog({
      title: isNew ? (price.model ? `Set a price for ${price.model}` : 'Add a price') : `Edit ${price.model}`,
      confirmLabel: 'Save price',
      content: h('div', {},
        field({ label: 'Model id', control: model }), errors.model,
        field({ label: 'Label', hint: 'Optional.', control: label }), errors.label,
        h('div', { class: 'field-row' }, h('div', {}, field({ label: 'Price in credits', control: credits }), errors.credits), h('div', {}, field({ label: 'Per', control: unit }), errors.unit)),
        h('label', { class: 'check' }, enabled, h('span', {}, h('strong', {}, 'Allowed'), h('span', { class: 'muted small block' }, 'Untick to refuse this model immediately.'))),
        field({ label: 'Note', hint: 'Optional.', control: note }), errors.note),
      onConfirm: async () => {
        const result = validatePriceForm({ model: model.value, unit: unit.value, credits: credits.value, enabled: enabled.checked, label: label.value, note: note.value })
        for (const [name, node] of Object.entries(errors)) node.textContent = result.errors[name] || ''
        if (!result.ok) throw new Error('Fix the highlighted fields.')
        return api.post('/api/admin/prices/upsert', result.value)
      },
    })
    if (done) { say.success(`Saved the price for ${done.price.model}.`); load() }
  }

  async function remove(price) {
    const yes = await confirmDialog({
      title: `Delete the price for ${price.model}?`, tone: 'danger', confirmLabel: 'Delete price',
      description: 'The model stays allowed — it simply has no price. To refuse it, keep the price and switch it off instead.',
    })
    if (!yes) return
    try {
      await api.post('/api/admin/prices/delete', { model: price.model })
      say.success(`Deleted the price for ${price.model}.`)
      load()
    } catch (e) { say.error(e, 'Could not delete the price') }
  }

  load()
  return { destroy() {} }
}
