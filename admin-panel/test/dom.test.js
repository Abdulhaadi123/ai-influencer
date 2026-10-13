// The DOM helper: building elements from data without ever interpreting it as markup.

import test, { beforeEach } from 'node:test'
import assert from './assert.js'

import { installDom, reset } from './helpers.js'

const { document } = installDom()
const { h, svg, mount, clear, uid } = await import('../lib/dom.js')

beforeEach(reset)

test('h builds an element with class, text, children and attributes', () => {
  const el = h('div', { class: 'a b', id: 'x', 'data-k': 'v', title: 't' }, 'one', h('span', {}, 'two'), 3)
  assert.equal(el.tagName, 'DIV')
  assert.equal(el.className, 'a b')
  assert.equal(el.id, 'x')
  assert.equal(el.getAttribute('data-k'), 'v')
  assert.equal(el.textContent, 'onetwo3')
  assert.equal(el.children.length, 1)
})

test('class takes an array and drops what is falsy', () => {
  assert.equal(h('i', { class: ['a', false, null, undefined, '', 'b', 0] }).className, 'a b')
  assert.equal(h('i', { class: [] }).getAttribute('class'), '')
  assert.equal(h('i', { class: false }).hasAttribute('class'), false)
})

test('children: nested arrays are flattened; null, undefined and booleans are skipped; 0 is kept', () => {
  const el = h('p', {}, [['a', [null, 'b']], undefined, false, true, 0, [[['c']]]])
  assert.equal(el.textContent, 'ab0c')
})

test('props that are null, undefined or false are simply not set', () => {
  const el = h('input', { title: undefined, name: null, hidden: false, 'aria-label': false })
  assert.equal(el.hasAttribute('title'), false)
  assert.equal(el.hasAttribute('name'), false)
  assert.equal(el.hidden, false)
  assert.equal(el.hasAttribute('aria-label'), false)
})

test('booleans: true is a bare attribute, or a property for the ones that are properties', () => {
  assert.equal(h('div', { 'data-on': true }).getAttribute('data-on'), '')
  assert.equal(h('button', { disabled: true }).disabled, true)
  assert.equal(h('input', { type: 'checkbox', checked: true }).checked, true)
  assert.equal(h('div', { hidden: true }).hidden, true)
})

test('event handlers are attached by name, case-insensitively', () => {
  let n = 0
  const el = h('button', { onclick: () => { n++ }, onKeyDown: () => { n += 10 } })
  el.dispatchEvent(new window.MouseEvent('click'))
  el.dispatchEvent(new window.KeyboardEvent('keydown'))
  assert.equal(n, 11)
})

test('an on… prop that is not a function is refused — a string would become inline code', () => {
  assert.throws(() => h('div', { onclick: 'alert(1)' }), TypeError)
  assert.throws(() => h('div', { onerror: 5 }), TypeError)
  assert.throws(() => h('img', { onload: {} }), TypeError)
})

test('a script URL in a link attribute is refused, in any spelling', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '  javascript:alert(1)', '\n\tjavascript:alert(1)', 'vbscript:x', 'data:text/html,<script>x</script>']) {
    assert.throws(() => h('a', { href: bad }), TypeError, bad)
    assert.throws(() => h('img', { src: bad }), TypeError, bad)
  }
  assert.equal(h('a', { href: '#/users' }).getAttribute('href'), '#/users')
  assert.equal(h('a', { href: 'https://example.com/a?b=javascript:1' }).getAttribute('href'), 'https://example.com/a?b=javascript:1')
  assert.equal(h('a', { title: 'javascript:alert(1)' }).getAttribute('title'), 'javascript:alert(1)', 'only link attributes are checked')
})

test('text from data is text: markup in it is shown, never built', () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script><b>bold</b>'
  const viaChild = h('div', {}, hostile)
  const viaText = h('div', { text: hostile })
  for (const el of [viaChild, viaText]) {
    assert.equal(el.textContent, hostile)
    assert.equal(el.querySelectorAll('*').length, 0, 'no element was created from the text')
    assert.equal(el.innerHTML.includes('<img'), false, 'it is escaped in the markup too')
  }
})

test('attribute values from data cannot break out of the attribute', () => {
  const el = h('div', { title: '"><script>alert(1)</script>', 'aria-label': "'><img src=x onerror=alert(1)>" })
  assert.equal(el.getAttribute('title'), '"><script>alert(1)</script>')
  assert.equal(el.querySelectorAll('*').length, 0)
  // Serialised and parsed again — what a browser would do with it — no element appears either.
  const holder = document.createElement('div')
  holder.innerHTML = el.outerHTML
  assert.equal(holder.querySelectorAll('script, img').length, 0)
  assert.equal(holder.firstChild.getAttribute('title'), '"><script>alert(1)</script>')
})

test('style is an object through the object model; a string is refused (that would be a style attribute)', () => {
  const el = h('div', { style: { width: '40%', '--chart-height': '168px' } })
  assert.equal(el.style.width, '40%')
  assert.equal(el.style.getPropertyValue('--chart-height'), '168px')
  assert.equal(el.getAttribute('style') === null || el.getAttribute('style').includes('width'), true)
  assert.throws(() => h('div', { style: 'color:red' }), TypeError)
})

test('value is applied after the children, so a select takes its value', () => {
  const select = h('select', { value: 'b' }, h('option', { value: 'a' }, 'A'), h('option', { value: 'b' }, 'B'))
  assert.equal(select.value, 'b')
  const input = h('input', { value: 'hello' })
  assert.equal(input.value, 'hello')
})

test('an object that looks like a node is appended; any other object is shown as text, not as markup', () => {
  const child = h('b', {}, 'x')
  assert.equal(h('div', {}, child).firstChild, child)
  assert.equal(h('div', {}, { toString: () => '<i>no</i>' }).querySelectorAll('i').length, 0)
})

test('svg builds in the SVG namespace, with children and attributes', () => {
  const node = svg('svg', { viewBox: '0 0 10 10', width: 10, class: 'c', skip: null }, svg('path', { d: 'M0 0' }))
  assert.equal(node.namespaceURI, 'http://www.w3.org/2000/svg')
  assert.equal(node.getAttribute('viewBox'), '0 0 10 10')
  assert.equal(node.getAttribute('width'), '10')
  assert.equal(node.hasAttribute('skip'), false)
  assert.equal(node.firstChild.tagName.toLowerCase(), 'path')
})

test('mount replaces what was there and ignores empty entries; clear empties', () => {
  const root = h('div', {}, h('p', {}, 'old'))
  mount(root, h('a', {}), null, undefined, false, [h('b', {}), [h('i', {})]])
  assert.deepEqual([...root.children].map(c => c.tagName), ['A', 'B', 'I'])
  mount(root)
  assert.equal(root.children.length, 0)
  mount(root, h('p', {}))
  clear(root)
  assert.equal(root.childNodes.length, 0)
})

test('uid is unique and prefixed', () => {
  const ids = new Set(Array.from({ length: 50 }, () => uid('field')))
  assert.equal(ids.size, 50)
  assert.ok([...ids].every(id => id.startsWith('field-')))
  assert.ok(uid().startsWith('id-'))
})
