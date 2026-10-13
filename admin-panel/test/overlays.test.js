// Toasts, dialogs, the side drawer and the row menu: the things that sit on top of
// the page, and have to leave it exactly as they found it.

import test, { beforeEach, mock } from 'node:test'
import assert from './assert.js'

import { installDom, reset, click, press, settle, text, all, submit, dom } from './helpers.js'

installDom()
const C = await import('../lib/components.js')
const { h } = await import('../lib/dom.js')

beforeEach(reset)

const dialogOpen = () => document.querySelector('dialog')

// ── Toasts ───────────────────────────────────────────────────────────────────

test('a toast appears in one polite live region, however many there are', () => {
  C.toast({ kind: 'success', message: 'One' })
  C.toast({ kind: 'info', message: 'Two' })
  const regions = document.querySelectorAll('.toasts')
  assert.equal(regions.length, 1)
  assert.equal(regions[0].getAttribute('aria-live'), 'polite')
  assert.equal(regions[0].getAttribute('role'), 'region')
  assert.equal(regions[0].querySelectorAll('.toast').length, 2)
})

test('toast kinds, titles, and the roles screen readers hear', () => {
  const ok = C.toast({ kind: 'success', title: 'Saved', message: 'It worked' })
  const bad = C.toast({ kind: 'error', message: 'It failed' })
  assert.ok(ok.classList.contains('toast-success'))
  assert.equal(ok.getAttribute('role'), 'status')
  assert.equal(text(ok.querySelector('strong')), 'Saved')
  assert.equal(bad.getAttribute('role'), 'alert')
  assert.equal(bad.querySelector('strong'), null)
})

test('a toast can be dismissed, and goes by itself — errors later than the rest', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const ok = C.toast({ kind: 'success', message: 'x' })
    const bad = C.toast({ kind: 'error', message: 'y' })
    const manual = C.toast({ kind: 'info', message: 'z' })
    click(manual.querySelector('button'))
    assert.equal(manual.isConnected, false)

    mock.timers.tick(4499)
    assert.equal(ok.isConnected, true)
    mock.timers.tick(1)
    assert.equal(ok.isConnected, false)
    assert.equal(bad.isConnected, true, 'an error is given longer')
    mock.timers.tick(3500)
    assert.equal(bad.isConnected, false)
    assert.equal(C.toast({ kind: 'info', message: 'custom', timeout: 100 }).isConnected, true)
    mock.timers.tick(100)
    assert.equal(document.querySelectorAll('.toast').length, 0)
  } finally { mock.timers.reset() }
})

test('toast text from data is text', () => {
  const t = C.toast({ kind: 'info', message: '<img src=x onerror=1>' })
  assert.equal(t.querySelectorAll('img').length, 0)
})

test('notify: success, error (an Error or anything else) and info', () => {
  C.notify.success('Done', 'Title')
  C.notify.error(new Error('Boom'))
  C.notify.error('plain string', 'Custom title')
  C.notify.info('FYI')
  const toasts = all(document, '.toast')
  assert.equal(toasts.length, 4)
  assert.match(text(toasts[1]), /That did not work/)
  assert.match(text(toasts[1]), /Boom/)
  assert.match(text(toasts[2]), /Custom title/)
  assert.match(text(toasts[2]), /plain string/)
})

test('the toast region is recreated if the page was wiped under it', () => {
  C.toast({ kind: 'info', message: 'a' })
  reset()
  C.toast({ kind: 'info', message: 'b' })
  assert.equal(document.querySelectorAll('.toasts').length, 1)
  assert.equal(document.querySelectorAll('.toast').length, 1)
})

// ── Dialog ───────────────────────────────────────────────────────────────────

test('a dialog shows its title, description and content, is modal, and is named by its title', async () => {
  const pending = C.openDialog({ title: 'Suspend?', description: 'Signed out everywhere.', content: h('p', {}, 'Extra'), confirmLabel: 'Suspend', tone: 'danger' })
  const d = dialogOpen()
  assert.equal(d.open, true)
  assert.equal(d.getAttribute('aria-labelledby'), d.querySelector('h2').id)
  assert.equal(text(d.querySelector('h2')), 'Suspend?')
  assert.match(text(d), /Signed out everywhere/)
  assert.match(text(d), /Extra/)
  const confirm = d.querySelector('button[type=submit]')
  assert.equal(text(confirm), 'Suspend')
  assert.ok(confirm.classList.contains('btn-danger-solid'))
  click(d.querySelector('button[type=button]'))
  assert.equal(await pending, null)
})

test('confirming resolves true by default, or with whatever onConfirm returns', async () => {
  const plain = C.openDialog({ title: 'x' })
  submit(dialogOpen().querySelector('form'))
  assert.equal(await plain, true)
  assert.equal(dialogOpen(), null, 'the dialog is removed from the page')

  const withValue = C.openDialog({ title: 'x', onConfirm: async () => ({ saved: 1 }) })
  submit(dialogOpen().querySelector('form'))
  assert.deepEqual(await withValue, { saved: 1 })

  const nothing = C.openDialog({ title: 'x', onConfirm: () => undefined })
  submit(dialogOpen().querySelector('form'))
  assert.equal(await nothing, true, 'an action that returns nothing still counts as done')
})

test('cancel, Escape and a click on the backdrop all cancel — a click inside does not', async () => {
  let p = C.openDialog({ title: 'x' })
  click(dialogOpen().querySelector('button[type=button]'))
  assert.equal(await p, null)

  p = C.openDialog({ title: 'x' })
  const esc = new window.Event('cancel', { cancelable: true })
  dialogOpen().dispatchEvent(esc)
  assert.equal(esc.defaultPrevented, true, 'the browser is not left to close it itself')
  assert.equal(await p, null)

  p = C.openDialog({ title: 'x' })
  const inner = dialogOpen().querySelector('h2')
  inner.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
  assert.ok(dialogOpen(), 'a press inside the dialog keeps it open')
  dialogOpen().dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
  assert.equal(await p, null)
})

test('a failing action keeps the dialog open, says why inside it, and lets the person try again', async () => {
  let attempts = 0
  const input = h('input', { value: 'typed text' })
  const p = C.openDialog({ title: 'x', content: input, onConfirm: async () => { attempts++; if (attempts === 1) throw new Error('The reason is required.'); return 'ok' } })
  const d = dialogOpen()
  submit(d.querySelector('form'))
  await settle()
  assert.ok(dialogOpen(), 'still open')
  assert.equal(text(d.querySelector('.form-error')), 'The reason is required.')
  assert.equal(d.querySelector('button[type=submit]').disabled, false, 'the buttons are back')
  assert.equal(d.querySelector('button[type=button]').disabled, false)
  assert.equal(input.value, 'typed text', 'what was typed is not lost')

  submit(d.querySelector('form'))
  assert.equal(await p, 'ok')
  assert.equal(attempts, 2)
})

test('an error with no message still says something', async () => {
  const p = C.openDialog({ title: 'x', onConfirm: async () => { throw new Error('') } })
  submit(dialogOpen().querySelector('form'))
  await settle()
  assert.equal(text(dialogOpen().querySelector('.form-error')), 'That did not work.')
  click(dialogOpen().querySelector('button[type=button]'))
  await p
})

test('while saving: the buttons are off, a second submit does nothing, and Escape or the backdrop cannot interrupt', async () => {
  let release
  let runs = 0
  const p = C.openDialog({ title: 'x', onConfirm: () => { runs++; return new Promise(r => { release = r }) } })
  const d = dialogOpen()
  submit(d.querySelector('form'))
  assert.equal(d.querySelector('button[type=submit]').disabled, true)
  assert.equal(d.querySelector('button[type=button]').disabled, true)

  submit(d.querySelector('form'))
  assert.equal(runs, 1, 'no double submit')
  d.dispatchEvent(new window.Event('cancel', { cancelable: true }))
  d.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
  assert.ok(dialogOpen(), 'a save in flight is left to finish')

  release('done')
  assert.equal(await p, 'done')
})

test('focus goes to the first field (or the confirm button) and comes back afterwards', async () => {
  const opener = h('button', {}, 'open')
  document.body.append(opener)
  opener.focus()

  const withField = C.openDialog({ title: 'x', content: h('div', {}, h('input', { id: 'first' })) })
  assert.equal(document.activeElement.id, 'first')
  click(dialogOpen().querySelector('button[type=button]'))
  await withField
  assert.equal(document.activeElement, opener, 'focus returns to what opened it')

  const noField = C.openDialog({ title: 'x' })
  assert.equal(document.activeElement.type, 'submit')
  click(dialogOpen().querySelector('button[type=button]'))
  await noField
})

test('hideCancel leaves only the confirm button; labels are customisable', async () => {
  const p = C.openDialog({ title: 'x', hideCancel: true, confirmLabel: 'OK' })
  assert.equal(dialogOpen().querySelectorAll('button[type=button]').length, 0)
  assert.equal(text(dialogOpen().querySelector('button[type=submit]')), 'OK')
  submit(dialogOpen().querySelector('form'))
  await p
  const q = C.openDialog({ title: 'x', cancelLabel: 'Not now' })
  assert.equal(text(dialogOpen().querySelector('button[type=button]')), 'Not now')
  click(dialogOpen().querySelector('button[type=button]'))
  await q
})

test('dialog text from data is text', async () => {
  const p = C.openDialog({ title: '<img src=x onerror=1>', description: '<b>bold</b>' })
  assert.equal(dialogOpen().querySelectorAll('img, b').length, 0)
  click(dialogOpen().querySelector('button[type=button]'))
  await p
})

test('confirmDialog is a plain yes or no', async () => {
  let p = C.confirmDialog({ title: 'Sure?', description: 'd', confirmLabel: 'Yes' })
  submit(dialogOpen().querySelector('form'))
  assert.equal(await p, true)
  p = C.confirmDialog({ title: 'Sure?', tone: 'danger' })
  click(dialogOpen().querySelector('button[type=button]'))
  assert.equal(await p, false)
})

// ── Drawer ───────────────────────────────────────────────────────────────────

test('a drawer is a modal region with a title, a close button, and the page behind it locked', () => {
  const drawer = C.openDrawer({ title: 'user@test.example', subtitle: 'User One', content: [h('p', {}, 'body')] })
  const panel = document.querySelector('.drawer')
  assert.equal(panel.getAttribute('role'), 'dialog')
  assert.equal(panel.getAttribute('aria-modal'), 'true')
  assert.equal(panel.getAttribute('aria-label'), 'user@test.example')
  assert.equal(text(panel.querySelector('.drawer-title')), 'user@test.example')
  assert.equal(text(panel.querySelector('.drawer-subtitle')), 'User One')
  assert.equal(text(panel.querySelector('.drawer-body')), 'body')
  assert.ok(document.body.classList.contains('no-scroll'))
  assert.equal(document.activeElement, panel, 'focus moves in')
  drawer.close()
})

test('close: the X, the backdrop, and Escape — and each releases the page and tells the owner', () => {
  for (const how of ['button', 'overlay', 'escape']) {
    reset()
    let closed = 0
    const opener = h('button', {}, 'open')
    document.body.append(opener)
    opener.focus()
    C.openDrawer({ title: 't', onClose: () => { closed++ } })
    if (how === 'button') click(document.querySelector('.drawer [aria-label=Close]'))
    if (how === 'overlay') click(document.querySelector('.drawer-overlay'))
    if (how === 'escape') press(document.body, 'Escape')
    assert.equal(document.querySelector('.drawer'), null, how)
    assert.equal(document.body.classList.contains('no-scroll'), false, how)
    assert.equal(closed, 1, how)
    assert.equal(document.activeElement, opener, `${how}: focus returns`)
  }
})

test('closing twice, or silently, does not call onClose again', () => {
  let closed = 0
  const d = C.openDrawer({ title: 't', onClose: () => { closed++ } })
  d.close(); d.close()
  assert.equal(closed, 1)
  let silent = 0
  const s = C.openDrawer({ title: 't', onClose: () => { silent++ } })
  s.close({ silent: true })
  assert.equal(silent, 0, 'a close the owner asked for does not call the owner back')
  assert.equal(document.querySelector('.drawer'), null)
})

test('after closing, Escape no longer does anything (the key listener is removed)', () => {
  const d = C.openDrawer({ title: 't' })
  d.close()
  const event = press(document.body, 'Escape')
  assert.equal(event.defaultPrevented, false)
})

test('Escape closes a drawer but not while a dialog is open on top of it (that Escape is the dialog\'s)', async () => {
  let closed = 0
  C.openDrawer({ title: 't', onClose: () => { closed++ } })
  const p = C.openDialog({ title: 'x' })
  press(document.body, 'Escape')
  assert.equal(closed, 0)
  assert.ok(document.querySelector('.drawer'))
  click(dialogOpen().querySelector('button[type=button]'))
  await p
  press(document.body, 'Escape')
  assert.equal(closed, 1)
})

test('setTitle and setContent update the open drawer', () => {
  const d = C.openDrawer({ title: 'Loading', subtitle: 'wait', content: [h('i', {}, 'spinner')] })
  d.setTitle('mia@test.example', 'Mia')
  d.setContent(h('p', {}, 'one'), [h('p', {}, 'two')], null)
  const panel = document.querySelector('.drawer')
  assert.equal(text(panel.querySelector('.drawer-title')), 'mia@test.example')
  assert.equal(text(panel.querySelector('.drawer-subtitle')), 'Mia')
  assert.equal(panel.getAttribute('aria-label'), 'mia@test.example')
  assert.equal(text(panel.querySelector('.drawer-body')), 'onetwo')
  d.setTitle('only a title')
  assert.equal(text(panel.querySelector('.drawer-subtitle')), '')
  d.close()
})

test('Tab stays inside the drawer: from the last control it wraps to the first, and Shift+Tab the other way', () => {
  const d = C.openDrawer({ title: 't', content: [h('button', { id: 'a' }, 'a'), h('button', { id: 'b' }, 'b')] })
  const close = document.querySelector('.drawer [aria-label=Close]')
  const b = document.getElementById('b')
  b.focus()
  const forward = press(document.body, 'Tab')
  assert.equal(forward.defaultPrevented, true)
  assert.equal(document.activeElement, close, 'wrapped to the first control')

  close.focus()
  const back = press(document.body, 'Tab', { shiftKey: true })
  assert.equal(back.defaultPrevented, true)
  assert.equal(document.activeElement, b, 'wrapped to the last')

  document.getElementById('a').focus()
  assert.equal(press(document.body, 'Tab').defaultPrevented, false, 'in the middle, Tab moves normally')
  d.close()
})

test('a drawer with nothing to focus keeps focus on itself rather than losing it', () => {
  const d = C.openDrawer({ title: 't' })
  document.querySelector('.drawer [aria-label=Close]').remove()
  const tab = press(document.body, 'Tab')
  assert.equal(tab.defaultPrevented, true)
  d.close()
})

// ── Menu ─────────────────────────────────────────────────────────────────────

const menuOf = items => {
  const row = h('div', {}, C.menuButton({ label: 'Actions for mia', items }))
  document.body.append(row)
  return { button: row.querySelector('button'), row }
}
const openMenu = () => document.querySelector('.menu')

test('a menu button opens a menu of items, in the page rather than the table, and says it is expanded', () => {
  const { button } = menuOf([{ label: 'View', onSelect() {} }, { separator: true }, { label: 'Delete', tone: 'danger', onSelect() {} }])
  assert.equal(button.getAttribute('aria-haspopup'), 'menu')
  assert.equal(button.getAttribute('aria-expanded'), 'false')
  assert.equal(openMenu(), null)
  click(button)
  const menu = openMenu()
  assert.equal(menu.parentNode, document.body)
  assert.equal(menu.getAttribute('role'), 'menu')
  assert.equal(button.getAttribute('aria-expanded'), 'true')
  assert.equal(all(menu, '[role=menuitem]').length, 2)
  assert.equal(menu.querySelectorAll('[role=separator]').length, 1)
  assert.ok(menu.querySelector('.menu-item-danger'))
  assert.equal(document.activeElement, menu.querySelector('[role=menuitem]'), 'the first item has focus')
})

test('selecting an item runs it and closes the menu', () => {
  const chosen = []
  const { button } = menuOf([{ label: 'View', onSelect: () => chosen.push('view') }, { label: 'Delete', onSelect: () => chosen.push('delete') }])
  click(button)
  click(all(openMenu(), '[role=menuitem]')[1])
  assert.deepEqual(chosen, ['delete'])
  assert.equal(openMenu(), null)
  assert.equal(button.getAttribute('aria-expanded'), 'false')
})

test('a disabled item cannot be chosen, and says why', () => {
  const chosen = []
  const { button } = menuOf([{ label: 'Delete', disabled: true, title: 'You cannot do this to your own account.', onSelect: () => chosen.push(1) }, { label: 'View', onSelect() {} }])
  click(button)
  const item = openMenu().querySelector('[role=menuitem]')
  assert.equal(item.disabled, true)
  assert.equal(item.title, 'You cannot do this to your own account.')
  click(item)
  assert.deepEqual(chosen, [])
  assert.equal(document.activeElement, openMenu().querySelectorAll('[role=menuitem]')[1], 'focus starts on the first usable item')
})

test('it closes on an outside click and on Escape (returning focus to the button), and toggles on the button', () => {
  const { button } = menuOf([{ label: 'A', onSelect() {} }])
  click(button)
  click(document.body)
  assert.equal(openMenu(), null)

  click(button)
  press(document.activeElement, 'Escape')
  assert.equal(openMenu(), null)
  assert.equal(document.activeElement, button)

  click(button)
  click(button)
  assert.equal(openMenu(), null, 'clicking the button again closes it')
})

test('a click inside the menu does not close it by itself; arrow keys move between items and wrap', () => {
  const { button } = menuOf([{ label: 'A', onSelect() {} }, { label: 'B', disabled: true }, { label: 'C', onSelect() {} }])
  click(button)
  const [a, , c] = all(openMenu(), '[role=menuitem]')
  click(openMenu())
  assert.ok(openMenu())

  assert.equal(document.activeElement, a)
  press(a, 'ArrowDown')
  assert.equal(document.activeElement, c, 'the disabled item is skipped')
  press(c, 'ArrowDown')
  assert.equal(document.activeElement, a, 'wraps')
  press(a, 'ArrowUp')
  assert.equal(document.activeElement, c, 'wraps backwards')
})

test('the button\'s click does not reach the row it is in, and closing removes the document listeners', () => {
  let rowClicks = 0
  const row = h('div', { onclick: () => { rowClicks++ } }, C.menuButton({ label: 'x', items: [{ label: 'A', onSelect() {} }] }))
  document.body.append(row)
  click(row.querySelector('button'))
  assert.equal(rowClicks, 0)
  assert.equal(row.querySelector('button').hasAttribute('data-no-row'), true)
  click(document.body)
  const event = press(document.body, 'Escape')
  assert.equal(event.defaultPrevented, false, 'no stray handler is left on the document')
})

test('only one menu is ever on the page when the same button is used repeatedly', () => {
  const { button } = menuOf([{ label: 'A', onSelect() {} }])
  for (let i = 0; i < 5; i++) { click(button); click(button) }
  assert.equal(document.querySelectorAll('.menu').length, 0)
  click(button)
  assert.equal(document.querySelectorAll('.menu').length, 1)
})

test('the menu is placed from the button\'s position, above it when there is no room below', () => {
  const { button } = menuOf([{ label: 'A', onSelect() {} }, { label: 'B', onSelect() {} }])
  button.getBoundingClientRect = () => ({ top: 100, bottom: 130, left: 900, right: 934, width: 34, height: 30 })
  click(button)
  const menu = openMenu()
  assert.equal(menu.style.top, '134px')
  assert.equal(menu.style.right, `${dom().innerWidth - 934}px`)
  click(button)

  button.getBoundingClientRect = () => ({ top: 760, bottom: 790, left: 900, right: 934, width: 34, height: 30 })
  Object.defineProperty(dom(), 'innerHeight', { value: 800, configurable: true })
  click(button)
  assert.ok(parseFloat(openMenu().style.top) < 760, 'opens upward near the bottom of the screen')
})
