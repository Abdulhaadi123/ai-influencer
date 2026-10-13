// Where the admin panel (admin-panel/) and this server have to agree.
//
// Each side tests itself: the panel in admin-panel/test, the server in test/integration/admin.test.js.
// These two cover the seams between them, so they need both folders — and say they were skipped,
// rather than fail on a path, in a checkout that has only backend/.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { adminUiDir, adminUiAvailable } from '../../api/admin/ui.js'
import { CATEGORIES } from '../../api/_lib/moderation/policy.js'

const skip = adminUiAvailable() ? false : 'admin-panel/ is not checked out'
const panelFile = rel => join(adminUiDir(), rel)

test('the panel has words for every moderation category the server can send', { skip }, async () => {
  const { CATEGORY_LABELS, categoryLabel } = await import(pathToFileURL(panelFile('lib/format.js')).href)
  for (const category of CATEGORIES) {
    assert.ok(category in CATEGORY_LABELS, `${category} has no label in the panel`)
    assert.notEqual(categoryLabel(category), category, `${category} would reach a screen as a raw code`)
  }
  assert.ok(Object.isFrozen(CATEGORY_LABELS))
})

test('the price form applies the same rules as the server', { skip }, async () => {
  // The rules are written twice — in the panel's form and in api/admin/prices.js. This keeps them from drifting.
  const { upsert } = await import('../../api/admin/prices.js')
  assert.equal(typeof upsert, 'function')
  const server = readFileSync(new URL('../../api/admin/prices.js', import.meta.url), 'utf8')
  const form = readFileSync(panelFile('views/prices.js'), 'utf8')
  for (const [name, text] of [['the server', server], ['the form', form]]) {
    assert.ok(text.includes('/^[A-Za-z0-9][\\w.\\-/:]{0,199}$/'), `the model-id pattern in ${name}`)
    assert.ok(text.includes('1_000_000'), `the price ceiling in ${name}`)
  }
})
