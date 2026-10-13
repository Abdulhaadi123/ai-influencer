/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Fit a video prompt into a model's character limit.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `buildVideoPrompt` writes a long structured brief — FORMAT, SUBJECT, WARDROBE,
 * MOOD, STYLE, LOGIC RULE… and, last, ACTION with what the person typed. Even with
 * nothing typed it is ~1,200 characters. Most models take thousands, but Wan 2.5
 * takes 800, and KIE refuses a longer prompt outright ("prompt exceeds maximum
 * length of 800 characters"), so that model could never be used.
 *
 * Cutting the end off is the wrong way to shorten it: the end is the ACTION, the
 * person's own words. So the fixed boilerplate goes first, least important
 * first, and only if that is not enough does the action itself lose its tail:
 *
 *   1. COLOR LOGIC, DELIVERY, WARDROBE, MOOD, STYLE — dropped, in that order,
 *      stopping as soon as it fits;
 *   2. LOGIC RULE — shortened to one line, then dropped;
 *   3. a long ENVIRONMENT is shortened, then the action (everything after the
 *      `---` line: ACTION, or one block per shot) is cut at a word, with an
 *      ellipsis;
 *   4. anything else (a prompt not built by buildVideoPrompt) — cut at the limit.
 *
 * FORMAT, SUBJECT and ENVIRONMENT are never dropped: they say who, how long and
 * where. A prompt already within the limit is returned untouched.
 */

const DROP_ORDER = ['COLOR LOGIC', 'DELIVERY', 'WARDROBE', 'MOOD', 'STYLE']
const COMPACT_RULE = 'LOGIC RULE: Same face throughout, one continuous take, no cuts. No music, captions or text overlays.'

/** A long setting is cut to this much; the action must keep at least MIN_ACTION_CHARS. */
const ENVIRONMENT_MAX = 200
const MIN_ACTION_CHARS = 80

const labelOf = block => /^([A-Z][A-Z ]*):/.exec(block)?.[1] ?? null

/** Cut at a word boundary so that, with the ellipsis, the result is at most `max` characters. */
function cutAtWord(text, max) {
  if (text.length <= max) return text
  const room = Math.max(0, max - 1)
  const head = text.slice(0, room)
  const atWord = head.replace(/\s+\S*$/, '')
  return `${(atWord.length >= room * 0.6 ? atWord : head).trimEnd()}…`
}

/**
 * @param {string} prompt
 * @param {number} limit  characters the model accepts
 * @returns {string} the prompt, at most `limit` characters
 */
export function fitPrompt(prompt, limit) {
  if (typeof prompt !== 'string' || !(limit > 0) || prompt.length <= limit) return prompt

  let blocks = prompt.split(/\n{2,}/)
  const text = () => blocks.join('\n\n')
  const without = label => { blocks = blocks.filter(b => labelOf(b) !== label) }

  for (const label of DROP_ORDER) {
    if (text().length <= limit) return text()
    without(label)
  }
  if (text().length <= limit) return text()

  if (blocks.some(b => labelOf(b) === 'LOGIC RULE')) {
    blocks = blocks.map(b => (labelOf(b) === 'LOGIC RULE' ? COMPACT_RULE : b))
    if (text().length <= limit) return text()
    without('LOGIC RULE')
    if (text().length <= limit) return text()
  }

  // What is left is the brief's spine and the action: everything after the `---`
  // line (one ACTION block, or one block per shot). A long setting is shortened
  // first, then the action loses its tail.
  const rule = blocks.findIndex(b => b.trim() === '---')
  const spine = (rule >= 0 ? blocks.slice(0, rule + 1) : blocks.slice(0, -1))
    .map(b => (labelOf(b) === 'ENVIRONMENT' ? cutAtWord(b, ENVIRONMENT_MAX) : b))
  const action = (rule >= 0 ? blocks.slice(rule + 1) : blocks.slice(-1)).join('\n\n')
  const room = limit - (spine.length ? spine.join('\n\n').length + 2 : 0)
  if (action && room >= MIN_ACTION_CHARS) return [...spine, cutAtWord(action, room)].join('\n\n')

  // Not a prompt this function knows the shape of (or the spine alone is too long).
  return cutAtWord(prompt, limit)
}
