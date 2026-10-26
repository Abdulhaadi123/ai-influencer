/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Price the models from what KIE charges us — the costing document, applied.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Charging one of our credits for each KIE credit loses money (api/_lib/markup.js says why), so every
 * price in `model_prices` is worked out from KIE's own price: KIE credits × the multiplier for the profit
 * margin wanted, rounded up to whole credits. From the backend folder, on the server:
 *
 *   docker compose exec -T api node db/reprice.js                 # show what would change; change nothing
 *   docker compose exec -T api node db/reprice.js --apply         # write it
 *   docker compose exec -T api node db/reprice.js --margin 40     # a different profit margin (default 30)
 *   docker compose exec -T api node db/reprice.js --commission 15 # a different store commission (default 20)
 *
 * What it does and does not touch:
 *
 *   • It works from KIE's price (KIE_COST in markup.js), never from the price a row holds now, so running
 *     it twice changes nothing the second time — a row cannot be marked up twice.
 *   • Only models listed in KIE_COST are repriced. Any other row, and a row whose unit differs from KIE's,
 *     is left as it is and named in the output. A listed model with no row is named too: it stays
 *     unavailable until someone adds a row in the admin panel (or gives this a reason to).
 *   • Prices change at once: the server reads the table on every request, so there is nothing to restart.
 *   • Balances are not touched. Credits already held simply buy less, as they would after any price rise.
 *   • The change is written to the audit log as the doing of the server console, with every old and new price.
 *
 * To go back, put the old prices in the admin panel's Pricing page: every old price is in this command's
 * output (the "now" column) and in the audit log entry it writes.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { transaction, many, closeDb } from '../api/_lib/db.js'
import { audit } from '../api/_lib/admin.js'
import {
  KIE_COST, KIE_USD_PER_CREDIT, WORST_USD_PER_CREDIT, DEFAULT_MARGIN, DEFAULT_COMMISSION,
  userCredits, marginOf, priceMultiplier, breakEvenMultiplier,
} from '../api/_lib/markup.js'

/** Something the person running this can put right; its message is for them. */
export class RepriceError extends Error {}

/** A percentage typed as `30`, `30%` or `12.5` → a share (0.3). */
export function shareFromPercent(text, name, max) {
  const raw = String(text ?? '').trim().replace(/%$/, '')
  const n = raw === '' ? NaN : Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > max * 100) {
    throw new RepriceError(`${name} must be a percentage from 0 to ${max * 100}, for example ${name === 'margin' ? 30 : 20}.`)
  }
  return n / 100
}

/**
 * What would change, from the rows as they are. Reads only.
 *
 * @param {{margin?: number, commission?: number}} opts  shares: 0.3 is 30%
 * @param {Array<{model: string, unit: string, credits: string|number}>} rows  the rows of `model_prices`
 */
export function plan({ margin = DEFAULT_MARGIN, commission = DEFAULT_COMMISSION } = {}, rows) {
  const held = new Map(rows.map(r => [r.model, r]))
  const listed = new Set(KIE_COST.map(c => c.model))

  const changes = []
  const same = []
  const skipped = []
  const missing = []
  for (const cost of KIE_COST) {
    const row = held.get(cost.model)
    if (!row) { missing.push(cost.model); continue }
    if (row.unit !== cost.unit) {
      skipped.push({ model: cost.model, reason: `its unit is ${row.unit}, and KIE bills it ${cost.unit}` })
      continue
    }
    const from = Number(row.credits)
    const to = userCredits(cost.kieCredits, { margin, commission })
    const entry = {
      model: cost.model, unit: cost.unit, kieCredits: cost.kieCredits, from, to,
      marginNow: marginOf(cost.kieCredits, from, { commission }),
      marginNew: marginOf(cost.kieCredits, to, { commission }),
    }
    ;(from === to ? same : changes).push(entry)
  }
  const others = rows.filter(r => !listed.has(r.model)).map(r => ({ model: r.model, unit: r.unit, credits: Number(r.credits) }))
  return { margin, commission, changes, same, skipped, missing, others }
}

/**
 * Work out the new prices and, when `apply` is true, write them — in one transaction that holds the rows
 * while it reads them, so a price an administrator changes at the same moment is neither lost nor mixed in.
 *
 * @returns {Promise<ReturnType<typeof plan> & {applied: boolean}>}
 */
export async function reprice({ margin = DEFAULT_MARGIN, commission = DEFAULT_COMMISSION, apply = false } = {}) {
  priceMultiplier({ margin, commission })   // refuses a margin or commission that makes no sense, before any query

  if (!apply) {
    return { ...plan({ margin, commission }, await many('select model, unit, credits from model_prices')), applied: false }
  }
  return transaction(async client => {
    const { rows } = await client.query('select model, unit, credits from model_prices for update')
    const result = plan({ margin, commission }, rows)
    for (const c of result.changes) {
      // updated_by cleared: the panel shows who last edited a price, and it was not the person it names now.
      await client.query('update model_prices set credits = $2, updated_by = null where model = $1', [c.model, c.to])
    }
    if (result.changes.length) {
      await audit(
        { id: null, email: 'the server console' }, 'price.console-reprice',
        {
          targetType: 'model_prices', targetId: `${result.changes.length} prices`,
          details: {
            margin, commission, by: 'the server console',
            prices: Object.fromEntries(result.changes.map(c => [c.model, { kieCredits: c.kieCredits, from: c.from, to: c.to }])),
          },
        },
        client,
      )
    }
    return { ...result, applied: true }
  })
}

const pct = share => (Number.isFinite(share) ? `${Math.round(share * 100)}%` : 'a loss')

/** The table, as lines of text. */
export function describe(result) {
  const { margin, commission, changes, same, skipped, missing, others } = result
  const lines = []
  lines.push(
    `Profit margin ${pct(margin)}, store commission ${pct(commission)}, worst-case pack $${WORST_USD_PER_CREDIT} a credit (KIE: $${KIE_USD_PER_CREDIT}).`,
    `One KIE credit is charged as ${priceMultiplier({ margin, commission }).toFixed(3)} of ours (break even ${breakEvenMultiplier({ commission }).toFixed(3)}), rounded up to whole credits.`,
    '',
  )
  const all = [...changes, ...same].sort((a, b) => a.model.localeCompare(b.model))
  if (all.length) {
    const w = Math.max(5, ...all.map(c => c.model.length))
    // Column widths from the numbers themselves: a price like 13.334 is wider than 18.
    const n = Math.max(3, ...all.flatMap(c => [c.kieCredits, c.from, c.to].map(v => String(v).length)))
    lines.push(`${'model'.padEnd(w)}  ${'unit'.padEnd(10)}  ${'KIE'.padStart(n)}  ${'now'.padStart(n)}  ${'new'.padStart(n)}  profit now → new`)
    for (const c of all) {
      lines.push(
        `${c.model.padEnd(w)}  ${c.unit.padEnd(10)}  ${String(c.kieCredits).padStart(n)}  ${String(c.from).padStart(n)}  ${String(c.to).padStart(n)}  ${pct(c.marginNow).padStart(6)} → ${pct(c.marginNew)}` +
        (c.from === c.to ? '   (already this price)' : ''),
      )
    }
  }
  const image = all.find(c => c.unit === 'per_image')
  if (image) {
    lines.push('', `The 5,000-credit pack then buys about ${Math.floor(5000 / image.to)} images (${Math.floor(5000 / image.from)} before).`)
  }
  for (const s of skipped) lines.push(`Left alone: ${s.model} — ${s.reason}.`)
  if (missing.length) lines.push(`No price row, so unavailable until one is added in the admin panel: ${missing.join(', ')}.`)
  if (others.length) lines.push(`Not worked out here, left as they are: ${others.map(o => `${o.model} (${o.credits})`).join(', ')}.`)
  return lines
}

const USAGE = `Usage: node db/reprice.js [--margin 30] [--commission 20] [--apply]

  --margin      the share of revenue to keep, in percent (default ${DEFAULT_MARGIN * 100})
  --commission  the store's share of each sale, in percent (default ${DEFAULT_COMMISSION * 100})
  --apply       write the prices. Without it nothing is changed: it only shows what would be.
`

/** The command's arguments → options. Unknown ones are refused: a typo must not silently mean "the default". */
export function parseArgs(argv) {
  const opts = { apply: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') opts.apply = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--margin' || arg === '--commission') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new RepriceError(`${arg} needs a percentage after it.\n\n${USAGE}`)
      if (arg === '--margin') opts.margin = shareFromPercent(value, 'margin', 0.9)
      else opts.commission = shareFromPercent(value, 'commission', 0.6)
    } else {
      const eq = /^--(margin|commission)=(.*)$/.exec(arg)
      if (!eq) throw new RepriceError(`I do not know "${arg}".\n\n${USAGE}`)
      if (eq[1] === 'margin') opts.margin = shareFromPercent(eq[2], 'margin', 0.9)
      else opts.commission = shareFromPercent(eq[2], 'commission', 0.6)
    }
  }
  return opts
}

/** The command. Returns the exit code: 0 done (or shown), 1 something to put right, 2 something broke. */
export async function main({ argv = process.argv.slice(2), out = console.log, err = console.error } = {}) {
  try {
    const opts = parseArgs(argv)
    if (opts.help) { out(USAGE); return 0 }
    const result = await reprice(opts)
    for (const line of describe(result)) out(line)
    out('')
    if (result.applied) {
      out(result.changes.length
        ? `Done: ${result.changes.length} price${result.changes.length === 1 ? '' : 's'} changed, live now. Running it again changes nothing.`
        : 'Nothing to change: every price is already at this margin.')
    } else {
      out(result.changes.length
        ? 'This was only a preview — nothing was changed. Add --apply to write these prices.'
        : 'Nothing would change: every price is already at this margin.')
    }
    return 0
  } catch (e) {
    if (e instanceof RepriceError || e instanceof RangeError) { err(e.message); return 1 }
    err(`Could not finish: ${e?.message ?? e}`)
    return 2
  }
}

// `node db/reprice.js`
const entry = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : ''
if (entry && entry === fileURLToPath(import.meta.url).toLowerCase()) {
  main()
    .then(async code => { await closeDb(); process.exit(code) })
    .catch(e => { console.error(e?.message ?? e); process.exit(2) })
}
