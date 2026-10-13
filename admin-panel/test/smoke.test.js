// What the fake browser can and cannot do — so the real tests rest on facts, not assumptions.
import test from 'node:test'
import assert from './assert.js'

import { installDom, dom, click, submit, type } from './helpers.js'

const { document } = installDom()

test('dialog.showModal and close exist and toggle `open`', () => {
  const d = document.createElement('dialog')
  document.body.append(d)
  assert.equal(typeof d.showModal, 'function')
  d.showModal()
  assert.equal(d.open, true)
  d.close()
  assert.equal(d.open, false)
})

test('a submit event reaches a form handler and can be cancelled', () => {
  const form = document.createElement('form')
  let seen = null
  form.addEventListener('submit', e => { e.preventDefault(); seen = e.defaultPrevented })
  document.body.append(form)
  submit(form)
  assert.equal(seen, true)
})

test('clicking a submit button submits its form', () => {
  const form = document.createElement('form')
  const button = document.createElement('button')
  button.type = 'submit'
  form.append(button)
  let submitted = false
  form.addEventListener('submit', e => { e.preventDefault(); submitted = true })
  document.body.append(form)
  click(button)
  assert.equal(submitted, true)
})

test('closest, matchMedia, focus, scrollTo and getBoundingClientRect are available', () => {
  const a = document.createElement('div'); const b = document.createElement('button')
  a.className = 'x'; a.append(b); document.body.append(a)
  assert.equal(b.closest('.x'), a)
  assert.equal(typeof dom().matchMedia, 'function')
  assert.equal(typeof dom().matchMedia('(min-width: 1px)').matches, 'boolean')
  b.focus()
  assert.equal(document.activeElement, b)
  assert.equal(typeof dom().scrollTo, 'function')
  assert.equal(typeof b.getBoundingClientRect().width, 'number')
})

test('input events and values behave', () => {
  const input = document.createElement('input')
  let got = null
  input.addEventListener('input', () => { got = input.value })
  type(input, 'hello')
  assert.equal(got, 'hello')
})

test('custom properties and style assignment work', () => {
  const d = document.createElement('div')
  d.style.setProperty('--x', '4px')
  d.style.width = '40%'
  assert.equal(d.style.getPropertyValue('--x'), '4px')
  assert.equal(d.style.width, '40%')
})

test('svg elements can be created in the SVG namespace', () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  s.setAttribute('viewBox', '0 0 1 1')
  assert.equal(s.namespaceURI, 'http://www.w3.org/2000/svg')
})

test('the clipboard stand-in is reachable', async () => {
  await navigator.clipboard.writeText('x')
  assert.deepEqual(navigator.clipboard.written, ['x'])
})
