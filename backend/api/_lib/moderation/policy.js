/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Moderation policy — scores in, a decision out.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The classifier (openai.js) says how likely each harm category is, from 0 to 1.
 * What to DO about a score is this app's decision, not the classifier's, and it
 * lives here, in one place, with no I/O so it can be tested exhaustively.
 *
 * Three outcomes:
 *
 *   block    refuse. The request is not sent, the file is not used.
 *   review   allow, but record it so a person looks. This is the band where the
 *            classifier is unsure — a swimsuit photo, a fight scene in a script.
 *   allow    nothing to do.
 *
 * The defaults are a starting point, not a verdict: OpenAI says outright that
 * its scores are signals to build a policy on, and that they are recalibrated as
 * the model is upgraded. Watch the review queue for a week and tune with
 * MODERATION_THRESHOLDS (see parseThresholdOverrides).
 *
 * ── The one rule that cannot be tuned away ───────────────────────────────────
 *
 * Sexual content involving a minor is always refused. Its threshold may be made
 * stricter but never looser than HARD_RULE_CEILING, and it cannot be switched
 * off — a typo in an environment variable must not be able to do that.
 */

/** Every category the classifier reports, in a fixed order. */
export const CATEGORIES = Object.freeze([
  'sexual',
  'sexual/minors',
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'illicit',
  'illicit/violent',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'violence',
  'violence/graphic',
])

export const HARD_RULE = 'sexual/minors'

/** The loosest the hard rule may ever be set. */
export const HARD_RULE_CEILING = 0.5

/** Frozen all the way down: rule objects are shared between every parsed rule set. */
function deepFreeze(rules) {
  for (const rule of Object.values(rules)) Object.freeze(rule)
  return Object.freeze(rules)
}

/**
 * Thresholds per category. `block` refuses at or above it; `review` holds the
 * item for a person at or above it. A category with neither is only acted on
 * when the classifier itself flags it (which is `review`).
 *
 * Reasoning, briefly:
 *   sexual/minors     any real signal. Text only — see the note in README.
 *   sexual            refuse the clearly explicit; hold the borderline, because
 *                     fashion and fitness are this app's main niches.
 *   violence          a thriller scene is not a violation; graphic gore is.
 *   self-harm         instructions and intent are refused; depictions reviewed.
 *   hate / threats    refused when clear; plain harassment is only reviewed.
 */
export const DEFAULT_RULES = deepFreeze({
  'sexual':                 { block: 0.85, review: 0.50 },
  'sexual/minors':          { block: 0.10 },
  'harassment':             { review: 0.80 },
  'harassment/threatening': { block: 0.85, review: 0.60 },
  'hate':                   { block: 0.90, review: 0.60 },
  'hate/threatening':       { block: 0.70 },
  'illicit':                { review: 0.80 },
  'illicit/violent':        { block: 0.85, review: 0.60 },
  'self-harm':              { review: 0.60 },
  'self-harm/intent':       { block: 0.80, review: 0.50 },
  'self-harm/instructions': { block: 0.60 },
  'violence':               { review: 0.80 },
  'violence/graphic':       { block: 0.85, review: 0.60 },
})

const round = n => Math.round(n * 1000) / 1000

/**
 * Parse MODERATION_THRESHOLDS: a JSON object of per-category overrides merged
 * over DEFAULT_RULES.
 *
 *   {"sexual": {"block": 0.9}}                  looser block, review unchanged
 *   {"violence": {"review": null}}              no longer held for review
 *   {"harassment": false}                       ignore the category entirely
 *
 * Throws with a message saying exactly what is wrong. Callers at startup let it
 * surface; callers on a request path log it and use the defaults (config.js).
 *
 * @param {string|undefined} raw
 * @returns {Record<string, {block?: number, review?: number}|false>}
 */
export function parseThresholdOverrides(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ...DEFAULT_RULES }

  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new SyntaxError('MODERATION_THRESHOLDS is not valid JSON.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('MODERATION_THRESHOLDS must be a JSON object.')
  }

  const rules = { ...DEFAULT_RULES }
  for (const [category, override] of Object.entries(parsed)) {
    if (!CATEGORIES.includes(category)) {
      throw new RangeError(`MODERATION_THRESHOLDS: "${category}" is not a category. Known: ${CATEGORIES.join(', ')}.`)
    }

    if (override === false) {
      if (category === HARD_RULE) throw new RangeError(`MODERATION_THRESHOLDS: "${HARD_RULE}" cannot be ignored.`)
      rules[category] = false
      continue
    }
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
      throw new TypeError(`MODERATION_THRESHOLDS: "${category}" must be an object like {"block": 0.9} or false.`)
    }

    const next = { ...(DEFAULT_RULES[category] || {}) }
    for (const [level, value] of Object.entries(override)) {
      if (level !== 'block' && level !== 'review') {
        throw new RangeError(`MODERATION_THRESHOLDS: "${category}" has unknown key "${level}" (use "block" or "review").`)
      }
      if (value === null) { delete next[level]; continue }
      if (typeof value !== 'number' || !(value > 0 && value <= 1)) {
        throw new RangeError(`MODERATION_THRESHOLDS: "${category}.${level}" must be a number above 0 and at most 1.`)
      }
      next[level] = value
    }

    if (next.block !== undefined && next.review !== undefined && next.review > next.block) {
      throw new RangeError(`MODERATION_THRESHOLDS: "${category}" review (${next.review}) must not be above block (${next.block}).`)
    }
    if (category === HARD_RULE) {
      if (next.block === undefined) throw new RangeError(`MODERATION_THRESHOLDS: "${HARD_RULE}" must keep a block threshold.`)
      if (next.block > HARD_RULE_CEILING) {
        throw new RangeError(`MODERATION_THRESHOLDS: "${HARD_RULE}.block" may not be above ${HARD_RULE_CEILING}.`)
      }
    }
    rules[category] = next
  }
  return rules
}

/**
 * Fold several classifier results into one, keeping the worst of each category.
 * A video is judged by its frames: one bad frame is a bad video.
 *
 * @param {Array<{flagged?: boolean, categories?: object, category_scores?: object}>} results  the API's `results`
 * @returns {{flagged: boolean, categories: Record<string, boolean>, scores: Record<string, number>}}
 */
export function mergeResults(results) {
  const merged = { flagged: false, categories: {}, scores: {} }
  for (const category of CATEGORIES) { merged.categories[category] = false; merged.scores[category] = 0 }

  for (const result of results || []) {
    if (!result || typeof result !== 'object') continue
    if (result.flagged === true) merged.flagged = true
    for (const category of CATEGORIES) {
      if (result.categories?.[category] === true) merged.categories[category] = true
      const score = Number(result.category_scores?.[category])
      if (Number.isFinite(score) && score > merged.scores[category]) merged.scores[category] = score
    }
  }
  return merged
}

/**
 * Decide what to do with a merged result.
 *
 * @param {ReturnType<typeof mergeResults>} result
 * @param {Record<string, {block?: number, review?: number}|false>} [rules]
 * @returns {{action: 'allow'|'review'|'block', hits: Array<{category: string, score: number, level: 'block'|'review'}>, hardRule: boolean}}
 *   `hardRule` is true when the refusal is for the category that is never tuned
 *   away; callers escalate it (suspend) rather than just counting a strike.
 */
export function evaluate(result, rules = DEFAULT_RULES) {
  const hits = []
  let action = 'allow'
  let hardRule = false

  for (const category of CATEGORIES) {
    let rule = rules[category] === undefined ? DEFAULT_RULES[category] : rules[category]
    // The parser already refuses to switch the hard rule off. This makes the rule
    // hold for any rule set that reaches here by another road.
    if (category === HARD_RULE && (rule === false || rule.block === undefined)) rule = DEFAULT_RULES[category]
    if (rule === false) continue

    const score = Number(result.scores?.[category]) || 0
    const flagged = result.categories?.[category] === true

    let level = null
    if (rule.block !== undefined && score >= rule.block) level = 'block'
    else if (category === HARD_RULE && flagged) level = 'block'
    else if (rule.review !== undefined && score >= rule.review) level = 'review'
    else if (flagged) level = 'review'
    if (!level) continue

    hits.push({ category, score: round(score), level })
    if (level === 'block') { action = 'block'; if (category === HARD_RULE) hardRule = true }
    else if (action === 'allow') action = 'review'
  }

  return { action, hits, hardRule }
}

/** The scores worth keeping on an event: the categories that tripped, nothing else. */
export function scoresOf(decision) {
  return Object.fromEntries(decision.hits.map(h => [h.category, h.score]))
}
