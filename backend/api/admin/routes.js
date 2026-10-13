/**
 * The admin panel's routes, in one place so server/index.js stays a list of
 * features rather than of every admin endpoint.
 *
 * `/admin` is the page; `/api/admin/*` is what it calls. Every `/api/admin`
 * handler is an adminRoute (api/_lib/admin.js): signed in, and an administrator
 * according to the database on this request.
 */

import * as overview from './overview.js'
import * as users from './users.js'
import * as jobs from './jobs.js'
import * as moderation from './moderation.js'
import * as prices from './prices.js'
import * as billing from './billing.js'
import { serveAdminUi, ADMIN_UI_PATHS } from './ui.js'

export function registerAdminRoutes(app) {
  app.get(ADMIN_UI_PATHS, serveAdminUi)

  app.get('/api/admin/stats', overview.stats)
  app.get('/api/admin/usage', overview.usage)
  app.get('/api/admin/audit', overview.auditLog)
  app.get('/api/admin/config', overview.config)

  app.get('/api/admin/users', users.list)
  app.get('/api/admin/users/detail', users.detail)
  app.post('/api/admin/users/suspend', users.suspend)
  app.post('/api/admin/users/unsuspend', users.unsuspend)
  app.post('/api/admin/users/set-role', users.setRole)
  app.post('/api/admin/users/delete', users.remove)

  app.get('/api/admin/jobs', jobs.list)

  app.get('/api/admin/moderation', moderation.list)
  app.get('/api/admin/moderation/item', moderation.item)
  app.get('/api/admin/moderation/media', moderation.media)
  app.post('/api/admin/moderation/resolve', moderation.resolve)

  app.get('/api/admin/prices', prices.list)
  app.post('/api/admin/prices/upsert', prices.upsert)
  app.post('/api/admin/prices/delete', prices.remove)

  app.get('/api/admin/billing/ledger', billing.ledger)
  app.post('/api/admin/billing/grant', billing.grant)
}
