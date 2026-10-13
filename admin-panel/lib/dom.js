/*
 * Building DOM from data, safely.
 *
 * Every piece of text the panel shows — an email, a prompt, a model name, an error
 * from the server — goes into the page through `textContent` or a text node. There
 * is no function here that takes HTML, and nothing in the panel uses one. A prompt
 * that contains `<img onerror=…>` is therefore shown as those characters and does
 * nothing, which is what the page's Content-Security-Policy backs up.
 *
 * Nothing in this module touches `document` until a function is called, so the
 * modules that only need it for tests can be imported without a browser.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Attributes that take a URL, and the one scheme that would run code from it. */
const LINK_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'xlink:href'])
const SCRIPT_URL = /^[\s\u0000-\u001f]*(javascript:|vbscript:|data:text\/html)/i

/** Properties are set as properties (not attributes), so they track what the user does. */
const PROPERTIES = new Set(['value', 'checked', 'selected', 'disabled', 'indeterminate', 'open', 'hidden'])

function applyProps(node, props) {
  let value
  for (const [key, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue

    if (key === 'class') node.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v))
    else if (key === 'text') node.textContent = String(v)
    // `style` is an object assigned through the CSS object model. The page's policy
    // forbids a style ATTRIBUTE, which is what setAttribute('style', …) would make.
    else if (key === 'style') {
      if (typeof v !== 'object') throw new TypeError('style must be an object, not a string.')
      for (const [name, styleValue] of Object.entries(v)) {
        // A custom property (--x) can only be set this way, not by assignment.
        if (name.startsWith('--')) node.style.setProperty(name, String(styleValue))
        else node.style[name] = styleValue
      }
    } else if (key === 'value') value = v   // after the children: a <select>'s options must exist first
    else if (PROPERTIES.has(key)) node[key] = v
    else if (key.startsWith('on')) {
      // A string here would become an inline handler attribute — code in the markup.
      if (typeof v !== 'function') throw new TypeError(`${key} must be a function, not ${typeof v}.`)
      node.addEventListener(key.slice(2).toLowerCase(), v)
    } else {
      if (LINK_ATTRIBUTES.has(key) && SCRIPT_URL.test(String(v))) throw new TypeError(`${key} may not be a script URL.`)
      node.setAttribute(key, v === true ? '' : String(v))
    }
  }
  return value
}

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false || child === true) continue
    node.append(typeof child === 'object' && 'nodeType' in child ? child : document.createTextNode(String(child)))
  }
}

/**
 * h('div', { class: 'card', onclick: fn }, 'text', childNode, [more, children])
 *
 * `class` takes a string or an array (falsy entries dropped); `on…` props are event
 * listeners; `style` is an object; booleans are properties or bare attributes.
 */
export function h(tag, props, ...children) {
  const node = document.createElement(tag)
  const value = applyProps(node, props)
  appendChildren(node, children)
  if (value !== undefined) node.value = value
  return node
}

/** An SVG element. Attributes only (SVG has no text in this panel but titles). */
export function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue
    node.setAttribute(key, String(v))
  }
  appendChildren(node, children)
  return node
}

/** Replace everything inside `root`. */
export function mount(root, ...nodes) {
  root.replaceChildren(...nodes.flat(Infinity).filter(n => n !== null && n !== undefined && n !== false))
  return root
}

export const clear = root => root.replaceChildren()

let counter = 0
/** A unique id for wiring a label to a control. */
export const uid = (prefix = 'id') => `${prefix}-${++counter}`
