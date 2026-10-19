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
  assert.equal(tokens['bg'], '#f6f6fb')
  assert.equal(tokens['surface'], '#ffffff')
  assert.ok(luminance(hex('bg')) > 0.9 && luminance(hex('surface')) > 0.99, 'the page and every card are near-white')
  assert.ok(luminance(hex('text')) < 0.05, 'text is near-black')
})

// ── Compact, and readable ───────────────────────────────────────────────────

test('the base type is 14px, controls are 36px tall, and a table row fits a laptop without wrapping', () => {
  assert.match(css, /body\s*\{[^}]*font:\s*14px\/1\.5/)
  assert.match(css, /\.control\s*\{[^}]*height:\s*36px/)
  assert.match(css, /\.btn\s*\{[^}]*height:\s*36px/)
  assert.match(css, /\.table td\s*\{[^}]*padding:\s*11px 14px/)
  assert.match(css, /\.nav-link\s*\{[^}]*height:\s*38px/)
  assert.match(css, /--page-pad:\s*32px/)
  assert.match(css, /--sidebar-w:\s*236px/)
})

test('column titles are in sentence case: small capitals are harder to read', () => {
  const header = /\.table th\s*\{([^}]*)\}/.exec(css)[1]
  assert.ok(!/text-transform:\s*uppercase/.test(header), 'a table heading is not shouted')
  assert.match(header, /font-size:\s*12\.5px/)
})

// ── One typeface, served with the panel ─────────────────────────────────────

test("the typeface is Inter, loaded from the panel's own folder — and the file, with its licence, is there", () => {
  assert.match(css, /@font-face\s*\{[^}]*font-family:\s*'Inter Variable'[^}]*url\('fonts\/inter-latin\.woff2'\)\s*format\('woff2'\)/)
  assert.match(css, /font-weight:\s*100 900/, 'a variable font: every weight from the one file')
  assert.match(css, /--font:\s*'Inter Variable'/)
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../fonts')
  const woff2 = readFileSync(join(dir, 'inter-latin.woff2'))
  assert.equal(woff2.subarray(0, 4).toString('latin1'), 'wOF2', 'a real WOFF2 file')
  assert.ok(woff2.length > 20_000 && woff2.length < 200_000, 'the latin subset, not the whole family')
  assert.match(readFileSync(join(dir, 'OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE/, 'the licence travels with the font')
})

// ── The frame: the app's navy, readable ─────────────────────────────────────

test("the sidebar is the app's navy, and what sits on it is readable", () => {
  assert.equal(tokens['navy'], '#080353')
  assert.ok(contrast('on-navy', 'navy') >= 7, 'white on the navy')
  for (const surface of ['navy', 'navy-hover', 'navy-active']) {
    assert.ok(contrast('on-navy-muted', surface) >= 4.5, `the quieter sidebar text on --${surface} is ${contrast('on-navy-muted', surface).toFixed(2)}:1`)
    assert.ok(contrast('on-navy', surface) >= 4.5)
  }
  assert.equal(tokens['accent'], '#5b49b2', "the violet of the app's buttons")
})

test('no text anywhere is set smaller than 11px, and small print is at least 12px', () => {
  const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map(m => Number(m[1]))
  assert.ok(Math.min(...sizes) >= 11, `smallest is ${Math.min(...sizes)}px`)
  const small = [...css.matchAll(/([^{}]+)\{[^}]*font-size:\s*(1[01](?:\.\d+)?)px/g)].map(m => m[1].trim())
  assert.deepEqual(small, [], `nothing is under 12px: ${small.join(' | ')}`)
})

test('the interface moves with the person: a visible focus ring, and no animation when asked for none', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*box-shadow:\s*var\(--focus\)/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
  assert.ok(contrast('accent', 'surface') >= 3, 'the focus ring (accent) shows against white')
})

test('on a small laptop or a phone: the menu slides in, the sidebar casts no shadow while shut, and nothing is wider than the screen', () => {
  const small = /@media \(max-width: 1024px\) \{([\s\S]*?)\n\}\n/.exec(css)[1]
  assert.match(small, /\.sidebar\s*\{[^}]*position:\s*fixed[^}]*translateX\(-104%\)/)
  assert.ok(!/^\s*\.sidebar\s*\{[^}]*box-shadow:/m.test(small), 'the shut sidebar has no shadow to bleed onto the page')
  assert.match(small, /\.nav-open \.sidebar\s*\{[^}]*box-shadow/)
  assert.match(css, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/)
})

test('the figures sit four across, then two, then one — never a lone card on a row', () => {
  assert.match(css, /\.grid-kpi\s*\{[^}]*repeat\(4, minmax\(0, 1fr\)\)/)
  assert.match(css, /@media \(max-width: 1180px\)[\s\S]*\.grid-kpi\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(css, /@media \(max-width: 460px\)[\s\S]*\.grid-kpi\s*\{[^}]*grid-template-columns:\s*1fr/)
})

test('something marked hidden stays hidden, however a later rule styles it (the moderation extras are shown only on Confirm)', () => {
  assert.match(css, /\.hidden\s*\{[^}]*display:\s*none\s*!important/)
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/)
})
