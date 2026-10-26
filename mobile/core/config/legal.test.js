import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LEGAL_PAGES, SITE_BASE, legalUrl } from './legal.js'

test('every page is an https address on the site, with the trailing slash the site is built with', () => {
  assert.ok(SITE_BASE.startsWith('https://'))
  assert.ok(!SITE_BASE.endsWith('/'), 'a base with a slash would give //privacy/')
  for (const page of LEGAL_PAGES) {
    const url = new URL(legalUrl(page.id))
    assert.equal(url.protocol, 'https:')
    assert.equal(url.origin, SITE_BASE)
    assert.ok(url.pathname.endsWith('/'), `${page.id}: the site writes /privacy/ not /privacy`)
    assert.equal(url.search + url.hash, '', 'no tracking or fragment')
  }
})

test('the routes are the ones the website has (influenza-site/src/app/<page>/page.tsx)', () => {
  const paths = Object.fromEntries(LEGAL_PAGES.map(p => [p.id, p.path]))
  assert.deepEqual(paths, {
    privacy: '/privacy/',
    terms: '/terms/',
    support: '/support/',
    deleteAccount: '/delete-account/',
  })
})

test('ids and labels are unique and every page has a label to show', () => {
  assert.equal(new Set(LEGAL_PAGES.map(p => p.id)).size, LEGAL_PAGES.length)
  assert.equal(new Set(LEGAL_PAGES.map(p => p.label)).size, LEGAL_PAGES.length)
  for (const p of LEGAL_PAGES) assert.ok(p.label.trim())
})

test('an unknown page throws instead of building a address that opens nothing', () => {
  assert.throws(() => legalUrl('privacyy'), /No legal page/)
  assert.throws(() => legalUrl(undefined), /No legal page/)
})
