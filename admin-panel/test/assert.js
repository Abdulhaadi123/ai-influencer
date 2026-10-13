/**
 * `node:assert/strict`, made safe for the DOM.
 *
 * When `assert.equal(a, b)` fails it prints both values in full, and a DOM node
 * drags in its whole document, window and every listener: the report takes minutes
 * and the run looks hung. A failing test must say what failed, so when either side
 * is a node, compare by identity and report the two as short descriptions.
 */

import assert from 'node:assert/strict'

const isNode = value => value !== null && typeof value === 'object' && typeof value.nodeType === 'number'

function describe(value) {
  if (value === null || value === undefined) return String(value)
  if (!isNode(value)) return typeof value === 'string' ? JSON.stringify(value) : String(value)
  const tag = (value.localName || value.nodeName || 'node').toLowerCase()
  const id = value.id ? `#${value.id}` : ''
  const cls = typeof value.className === 'string' && value.className.trim() ? `.${value.className.trim().split(/\s+/).join('.')}` : ''
  const words = (value.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
  return `<${tag}${id}${cls}>${words ? ` "${words}"` : ''}`
}

function identity(name, wantSame) {
  return (actual, expected, message) => {
    if (!isNode(actual) && !isNode(expected)) return assert[name](actual, expected, message)
    if ((actual === expected) === wantSame) return undefined
    throw new assert.AssertionError({ message: message ?? `${wantSame ? 'expected' : 'did not expect'} ${describe(expected)}${wantSame ? `, got ${describe(actual)}` : ''}` })
  }
}

const safe = Object.assign((...args) => assert(...args), assert, {
  equal: identity('equal', true),
  strictEqual: identity('strictEqual', true),
  notEqual: identity('notEqual', false),
  notStrictEqual: identity('notStrictEqual', false),
})

export default safe
