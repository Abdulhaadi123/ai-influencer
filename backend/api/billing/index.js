/**
 * ─────────────────────────────────────────────────────────────────────────────
 * What the app is told about credits.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * GET /api/billing/me → { balance, enforced, prices, packs }
 *
 *   balance   the account's credits now
 *   enforced  whether the server is stopping requests for lack of credits yet
 *             (false while it is only watching — see _lib/billing.js)
 *   prices    what each model costs, for showing a price before someone generates
 *   packs     which store products give how many credits
 *
 * Only the caller's own balance is ever read, from the session — never from the request.
 */

import { userRoute, noStore } from '../_lib/http.js'
import { balanceOf, billingEnforced, catalog } from '../_lib/billing.js'

export const me = userRoute(async (_req, res, user) => {
  const [balance, { prices, packs }] = await Promise.all([balanceOf(user.id), catalog()])
  noStore(res)
  res.json({ balance, enforced: billingEnforced(), prices, packs })
}, { tag: '[billing/me]', message: 'Unable to load your credits. Please try again.' })
