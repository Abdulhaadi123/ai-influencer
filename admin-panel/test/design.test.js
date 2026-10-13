// The design system, held to numbers: text a person can read, colours that exist, and
// the rules that keep it light and roomy. These read the stylesheet itself, so a token
// changed to something faint — or a colour used that was never defined — fails here
// rather than in front of an administrator.

import test from 'node:test'
import assert from './assert.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app.css'), 'utf8')

// ── Reading the tokens ──────────────────────────────────────────────────────

const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css)[1]
const tokens = Object.fromEntries([...rootBlock.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]))

const hex = name => {
  const v = tokens[name]
  assert.match(v, /^#[0-9a-f]{6}$/i, `--${name} is a plain colour`)
  return [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16))
}
const luminance = rgb => {
  const [r, g, b] = rgb.map(c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(hex(a)), luminance(hex(b))].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// ── Contrast ────────────────────────────────────────────────────────────────

test('body text, secondary text and muted text are readable (4.5:1) on every surface they sit on', () => {
  for (const text of ['text', 'text-2', 'muted']) {
    for (const surface of ['surface', 'bg', 'surface-2', 'surface-3']) {
      assert.ok(contrast(text, surface) >= 4.5, `--${text} on --${surface} is ${contrast(text, surface).toFixed(2)}:1`)
    }
  }
})

test('the accent, and white on the accent, are readable; links and active items sit on white or their own tint', () => {
  assert.ok(contrast('accent', 'surface') >= 4.5, `accent on white ${contrast('accent', 'surface').toFixed(2)}`)
  assert.ok(contrast('accent', 'accent-soft') >= 4.5, `accent on its tint ${contrast('accent', 'accent-soft').toFixed(2)}`)
  assert.ok(contrast('on-accent', 'accent') >= 4.5, `white on accent ${contrast('on-accent', 'accent').toFixed(2)}`)
  assert.ok(contrast('accent-hover', 'surface') >= 4.5)
  assert.ok(contrast('on-accent', 'accent-hover') >= 4.5)
})

test('each status colour is readable on its own tint, and white is readable on the solid red', () => {
  for (const tone of ['success', 'warning', 'danger', 'info']) {
    assert.ok(contrast(tone, `${tone}-soft`) >= 4.5, `${tone} on its tint ${contrast(tone, `${tone}-soft`).toFixed(2)}`)
    assert.ok(contrast(tone, 'surface') >= 4.5, `${tone} on white ${contrast(tone, 'surface').toFixed(2)}`)
  }
  assert.ok(contrast('danger-solid', 'surface') >= 3, 'the solid red is visible as a badge or bar')
  assert.ok(contrast('on-accent', 'danger-solid') >= 4.5, `white on the red button ${contrast('on-accent', 'danger-solid').toFixed(2)}`)
  assert.ok(contrast('on-accent', 'danger-solid-hover') >= 4.5)
})

test('a faint colour is never used for text a person has to read, nor for the icons that name a control', () => {
  // --subtle is a decoration colour (borders on hover, bars). Where it carries meaning it must be 3:1 or better.
  const subtleOnWhite = contrast('subtle', 'surface')
  assert.ok(subtleOnWhite < 3.1, 'this test assumes --subtle is the faint one')
  const textRules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, , body]) => /(^|[;\s])color:\s*var\(--subtle\)/.test(body))
    .map(([, selector]) => selector.trim().replace(/\s+/g, ' '))
  const allowed = [/:disabled/, /::placeholder/, /\.search \.icon/]
  const offenders = textRules.filter(selector => !allowed.some(a => a.test(selector)))
  assert.deepEqual(offenders, [], 'these colour text or icons with the faint colour')
  assert.ok(!/::placeholder\s*\{[^}]*var\(--subtle\)/.test(css), 'placeholder text uses the readable muted colour')
})

// ── Every colour used exists, and nothing is hard-coded twice ───────────────

test('every var(--token) the stylesheet uses is defined', () => {
  const used = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/g)].map(m => m[1]))
  const local = new Set([...css.matchAll(/(?:^|[\s;{])--([a-z0-9-]+):/g)].map(m => m[1]))   // --hue and --chart-height are set per element
  const set = new Set(['chart-height'])   // set on the chart element itself, through the CSS object model
  const undefinedTokens = [...used].filter(name => !(name in tokens) && !local.has(name) && !set.has(name))
  assert.deepEqual(undefinedTokens, [])
})

test('every token is used somewhere (no dead colours)', () => {
  const body = css.replace(rootBlock, '')
  const unused = Object.keys(tokens).filter(name => !new RegExp(`var\\(--${name}\\b`).test(body) && !new RegExp(`var\\(--${name}\\b`).test(rootBlock))
  assert.deepEqual(unused, [])
})

test('colours are written as tokens: outside :root only white, black, shadows and the logo tile are literal', () => {
  const body = css.replace(rootBlock, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const literals = [...body.matchAll(/(#[0-9a-fA-F]{3,8}\b)/g)].map(m => m[1].toLowerCase())
  const avatarHues = new Set(['#4f46e5', '#0284c7', '#059669', '#d97706', '#db2777', '#7c3aed'])
  const stray = literals.filter(c => !['#fff', '#ffffff', '#000'].includes(c) && !avatarHues.has(c))
  assert.deepEqual(stray, [])
})

// ── One light theme ─────────────────────────────────────────────────────────

test('there is no dark mode, however the browser is set', () => {
  assert.ok(!/prefers-color-scheme/.test(css))
  assert.ok(!/data-theme/.test(css))
  assert.ok(!/color-scheme:\s*dark/.test(css))
  assert.equal(tokens['bg'], '#f8fafc')
  assert.equal(tokens['surface'], '#ffffff')
  assert.ok(luminance(hex('bg')) > 0.9 && luminance(hex('surface')) > 0.99, 'the page and every card are near-white')
  assert.ok(luminance(hex('text')) < 0.05, 'text is near-black')
})

// ── Roomy, not cramped ──────────────────────────────────────────────────────

test('the base type is 15px, controls are 40px tall, and table cells have room', () => {
  assert.match(css, /body\s*\{[^}]*font:\s*15px\/1\.55/)
  assert.match(css, /\.control\s*\{[^}]*height:\s*40px/)
  assert.match(css, /\.btn\s*\{[^}]*height:\s*40px/)
  assert.match(css, /\.icon-btn\s*\{[^}]*width:\s*40px;\s*height:\s*40px/)
  assert.match(css, /\.table td\s*\{[^}]*padding:\s*18px 20px/)
  assert.match(css, /\.nav-link\s*\{[^}]*height:\s*44px/)
  assert.match(css, /--page-pad:\s*48px/)
})

test('no text anywhere is set smaller than 11px, and small print is at least 12px', () => {
  const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map(m => Number(m[1]))
  assert.ok(Math.min(...sizes) >= 11, `smallest is ${Math.min(...sizes)}px`)
  const small = [...css.matchAll(/([^{}]+)\{[^}]*font-size:\s*(1[01](?:\.\d+)?)px/g)].map(m => m[1].trim())
  assert.ok(small.every(s => /nav-label|brand-tag/.test(s)), `only labels in capitals are under 12px: ${small.join(' | ')}`)
})

test('the interface moves with the person: a visible focus ring, and no animation when asked for none', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*box-shadow:\s*var\(--focus\)/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
  assert.ok(contrast('accent', 'surface') >= 3, 'the focus ring (accent) shows against white')
})

test('on a phone: the menu slides in, the sidebar casts no shadow while shut, and nothing is wider than the screen', () => {
  const phone = /@media \(max-width: 900px\) \{([\s\S]*?)\n\}\n/.exec(css)[1]
  assert.match(phone, /\.sidebar\s*\{[^}]*position:\s*fixed[^}]*translateX\(-104%\)/)
  assert.ok(!/^\s*\.sidebar\s*\{[^}]*box-shadow:/m.test(phone), 'the shut sidebar has no shadow to bleed onto the page')
  assert.match(phone, /\.nav-open \.sidebar\s*\{[^}]*box-shadow/)
  assert.match(css, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/)
})

test('the five figures on the overview never leave a lone card on a row', () => {
  assert.match(css, /\.grid-kpi\s*\{[^}]*repeat\(6, minmax\(0, 1fr\)\)/)
  assert.match(css, /\.grid-kpi > :nth-child\(n \+ 4\)\s*\{\s*grid-column:\s*span 3/, 'three across, then two wider')
  assert.match(css, /min-width: 1760px[\s\S]*repeat\(5, minmax\(0, 1fr\)\)/, 'all five on a very wide screen')
  assert.match(css, /\.grid-kpi > :last-child:nth-child\(odd\)\s*\{\s*grid-column:\s*1 \/ -1/, 'on a phone the odd one out spans the row')
})
