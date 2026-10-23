/*
 * Pricing: what each model costs a person, and whether it may be used at all.
 *
 * Whether the price is charged yet depends on billing being switched on — the page
 * says which it is. The switch is different: turning a model off is live, at once, for
 * every new request, so turning it off asks first.
 *
 * A model that real jobs have used but that nobody priced is listed separately,
 * with a button to price it, so nothing is served for free by being forgotten.
 */

import { h, mount } from '../lib/dom.js'
import {
  badge, button, callout, card, confirmDialog, copyButton, dataTable, emptyState, field, loadInto, notify, openDialog, pageHeader, skeletonRows, switchControl,
} from '../lib/components.js'
import { UNIT_LABELS, formatDate, formatNumber, modelName, plural, relativeTime } from '../lib/format.js'

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
      title: 'Pricing', subtitle: 'What each model costs a person, in credits — and whether it may be used at all.',
      actions: [button({ label: 'Add a price', iconName: 'plus', tone: 'primary', onClick: () => edit({}) })],
    }),
    body)

  let units = UNITS
  // Whether prices are charged, which decides what a missing price means: with charging on the server refuses a
  // model that has none (and the app does not offer it); with charging off it is free. null = could not be read.
  let enforced = null

  function load() {
    return loadInto(body, {
      signal,
      skeleton: () => skeletonRows(5, 4),
      load: () => Promise.all([
        api.get('/api/admin/prices', null, { signal }),
        // Whether these prices are being charged is the first thing to know about them; if it cannot be read, say less.
        api.get('/api/admin/config', null, { signal }).then(c => c.billing?.enforced ?? null).catch(e => { if (e?.name === 'AbortError') throw e; return null }),
      ]),
      render: ([data, isEnforced]) => {
        units = data.units
        enforced = isEnforced
        mount(body,
          enforced === true
            ? callout({
              tone: 'success', title: 'Charging is on — these prices are charged now',
              body: 'Every generation takes its price in credits. A model with no price here is refused and the app does not offer it (a free model needs a price of 0). The Allowed switch is live as well: a model switched off is refused straight away.',
            })
            : enforced === false
              ? callout({
                tone: 'info', title: 'Charging is off — prices are recorded, nobody is charged yet',
                body: 'Set them while charging is off, then turn it on with BILLING_ENFORCED=true. Until then a model with no price is free to use; once charging is on it is refused. The Allowed switch is different: it is live, and a model switched off is refused straight away.',
              })
              : callout({
                tone: 'info', title: 'Prices apply once charging is switched on',
                body: 'The Allowed switch is different: it is live. A model switched off is refused straight away for every new generation.',
              }),
          card({
            flush: true, title: 'Models and prices', subtitle: plural(data.prices.length, 'model'),
            body: data.prices.length
              ? dataTable({
                label: 'Model prices', rows: data.prices, rowKey: p => p.model,
                columns: [
                  { key: 'model', label: 'Model', render: p => h('div', {}, h('div', { class: 'cell-main' }, p.label || modelName(p.model)), h('div', { class: 'cell-sub mono' }, p.model, copyButton(p.model, 'Copy the model id'))) },
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
              : emptyState({ iconName: 'prices', title: 'No prices yet', body: enforced === true ? 'Add one to start pricing models. A model with no price cannot be used while charging is on.' : 'Add one to start pricing models. Until then every model is allowed and unpriced.', action: button({ label: 'Add a price', iconName: 'plus', tone: 'primary', onClick: () => edit({}) }) }),
          }),
          data.unpriced.length
            ? card({
              title: 'In use, but not priced', subtitle: enforced === true ? 'People have generated with these models, but no price is set, so they are refused now. Set a price to turn them back on.' : 'People have generated with these models and no price is set, so they cost nothing.', flush: true,
              body: dataTable({
                label: 'Unpriced models', rows: data.unpriced, rowKey: m => m.model,
                columns: [
                  { key: 'model', label: 'Model', render: m => h('div', {}, h('div', { class: 'cell-main' }, modelName(m.model)), h('div', { class: 'cell-sub mono' }, m.model)) },
                  { key: 'jobs', label: 'Generations', align: 'right', render: m => formatNumber(m.jobs) },
                  { key: 'credits', label: 'KIE cost so far', align: 'right', render: m => formatNumber(m.kieCredits) },
                  { key: 'actions', label: '', align: 'right', render: m => button({ label: 'Set a price', small: true, tone: 'primary', onClick: () => edit({ model: m.model, enabled: true, kind: m.kind }) }) },
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
    // The unit starts where it can be known: the one already saved, or per image for a model that makes images. A video
    // model can be priced per video or per second, which is the admin's call — so it starts on "Choose…", not on a guess.
    const startUnit = price.unit || (price.kind === 'image' ? 'per_image' : '')
    const unit = h('select', { class: 'control', value: startUnit },
      startUnit ? null : h('option', { value: '', selected: true }, 'Choose…'),
      units.map(u => h('option', { value: u, selected: u === startUnit }, `per ${UNIT_LABELS[u] || u}`)))
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
      description: enforced === true
        ? 'Charging is on, so a model with no price is refused and the app stops offering it. To pause it and keep the price, switch it off instead.'
        : 'The model stays allowed — it simply has no price. To refuse it, keep the price and switch it off instead.',
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
