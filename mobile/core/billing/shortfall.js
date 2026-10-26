/**
 * ─────────────────────────────────────────────────────────────────────────────
 * "You do not have enough credits" — what it says, as plain data.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * No React and no native modules, so the rules are checked on their own (shortfall.test.js).
 * Two screens say it: the dialog the whole app shares (src/hooks/useBilling.js) and the cost
 * note above a Generate button (src/components/CostNote.js). Both take their numbers from here,
 * so they cannot disagree about how many credits are missing.
 */

import { formatCredits } from './packs.js'

const isCount = n => typeof n === 'number' && Number.isFinite(n)

/** "1 credit", "46 credits", "1,616 credits". */
export function creditsWord(n) {
  return `${formatCredits(n)} ${n === 1 ? 'credit' : 'credits'}`
}

/**
 * How far a balance is from a price.
 *
 * @param {{balance: number|null, price: number|null}} amounts
 * @returns {{need: number, have: number, short: number} | null}  null when either number is not known
 */
export function creditShortfall({ balance, price }) {
  if (!isCount(balance) || !isCount(price) || price <= 0) return null
  const have = Math.max(balance, 0)   // an account that owes credits has none, not a negative number
  return { need: price, have, short: Math.max(price - have, 0) }
}

/**
 * The dialog for a refused generation: a title, one line of advice, and the three numbers.
 *
 * @param {{balance: number|null, price: number|null}} amounts
 * @returns {{title: string, message: string, facts: Array<{label: string, value: string, emphasis?: boolean}>}}
 */
export function outOfCreditsDialog(amounts) {
  const s = creditShortfall(amounts)
  if (!s) {
    return {
      title: 'Not enough credits',
      message: 'You do not have enough credits for this. Get a credit pack to continue.',
      facts: [],
    }
  }
  return {
    title: 'Not enough credits',
    message: 'Get a credit pack to continue. Credits never expire.',
    facts: [
      { label: 'This needs', value: creditsWord(s.need) },
      { label: 'You have', value: creditsWord(s.have) },
      { label: 'You are short by', value: creditsWord(s.short), emphasis: true },
    ],
  }
}
