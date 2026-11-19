/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Director — the pure part of POST /api/director-prompt.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Director Mode turns an idea ("a 30 second ad for my tea cup, a girl in her kitchen drinking tea from it")
 * into the prompt Seedance 2.5 is given: which reference image is what, a summary, then the clip shot by shot
 * with timings, what is said and what is heard, a style line and a consistency line.
 *
 * It is NOT the prompt assistant (api/prompt-assist.js), which rewrites what a person typed into a better
 * version of the same thing. This one writes a whole plan, and a model that may search the web writes it.
 *
 * What is left to the model, and what is not
 *
 *   The model writes the creative parts: the summary, each shot's picture, speech and sound, the style.
 *   Everything that has to be exactly right is done here, in code, so a model that is "usually right" cannot
 *   break it:
 *     • which `@ImageN` is which — the lines that say so are written from the list the app sent, in the order
 *       the app will upload the pictures, never by the model;
 *     • the timings — shots are re-timed so they follow each other with no gap from 0 to the clip's length;
 *     • the layout, the speaker labels and the closing rules (no subtitles, no music).
 *   The model answers in JSON, and what comes back is parsed and checked, not pasted.
 *
 * Nothing in this file talks to the network or the database, so every part of it is tested on its own
 * (test/unit/director.test.js).
 */

// ── What the endpoint accepts ────────────────────────────────────────────────

/** The lengths Seedance 2.5 takes (mobile/core/config/videoModels.js). A request is moved to the nearest. */
export const SECONDS = Object.freeze([4, 5, 6, 8, 10, 12, 15, 20, 25, 30])
export const DEFAULT_SECONDS = 15

export const ASPECTS = Object.freeze(['9:16', '16:9', '1:1'])
export const DEFAULT_ASPECT = '9:16'

/** What a reference picture is. The app lists them in the order it uploads them; the tags follow that order. */
export const ROLES = Object.freeze(['product', 'character', 'character_extra', 'location'])

/**
 * What Seedance 2.5 takes: KIE's docs say reference_image_urls "Up to 30 images" (read 19 November 2026). It was nine
 * while the app offered at most three products, a character with her sheets and a place; the app now offers a model's
 * whole allowance, so this is the model's number. The video request is checked again by KIE itself.
 */
export const MAX_REFERENCES = 30

export const MAX_IDEA_CHARS = 2000
export const MAX_DESCRIPTION_CHARS = 800
export const MAX_NAME_CHARS = 60

/** A refusal of the request itself: the caller sent something that cannot be used. */
export class DirectorInputError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'DirectorInputError'
    this.status = status
    this.code = code
  }
}

/** The model's answer could not be used (not JSON, no shots). Worth asking again; not the caller's fault. */
export class DirectorOutputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DirectorOutputError'
  }
}

/**
 * One line of plain text: control characters and line breaks become spaces, runs of spaces one space.
 * Text that goes into the instructions' neighbours (a name, a language) must not be able to carry a new line
 * with a new instruction on it.
 */
function oneLine(value, max) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Text that may run over several lines (the idea): control characters other than a line break are dropped. */
function paragraphs(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const nearest = (n, allowed) => allowed.reduce((best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best), allowed[0])

/** Letters, spaces and a few marks: it is put into the director's instructions, so nothing else gets in. */
const LANGUAGE = /^\p{L}[\p{L}\p{M} .'()-]{1,39}$/u

/**
 * The request, checked and tidied.
 *
 * @param {any} body
 * @returns {{
 *   idea: string, seconds: number, aspect: string, language: string,
 *   character: {name: string, gender: 'Female'|'Male'|null, description: string},
 *   references: Array<{role: string, tag: string}>,
 * }}
 * @throws {DirectorInputError}
 */
export function cleanInput(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {}

  if (typeof input.idea !== 'string' || !input.idea.trim()) {
    throw new DirectorInputError(400, 'IDEA_REQUIRED', 'Tell the director what the video should show.')
  }
  const idea = paragraphs(input.idea)
  if (idea.length > MAX_IDEA_CHARS) {
    throw new DirectorInputError(413, 'TOO_LONG', `Keep the idea under ${MAX_IDEA_CHARS} characters.`)
  }
  if (idea.length < 3) throw new DirectorInputError(400, 'IDEA_REQUIRED', 'Tell the director what the video should show.')

  // A length is a number, or text that is one. (Number(null) and Number('') are 0, which would mean four seconds.)
  const wanted = typeof input.seconds === 'number' || (typeof input.seconds === 'string' && input.seconds.trim() !== '')
    ? Number(input.seconds)
    : NaN
  const seconds = Number.isFinite(wanted) ? nearest(wanted, SECONDS) : DEFAULT_SECONDS
  const aspect = typeof input.aspect === 'string' && ASPECTS.includes(input.aspect) ? input.aspect : DEFAULT_ASPECT
  const language = typeof input.language === 'string' && LANGUAGE.test(input.language.trim()) ? input.language.trim() : 'English'

  const who = input.character && typeof input.character === 'object' && !Array.isArray(input.character) ? input.character : {}
  const character = {
    name: oneLine(who.name, MAX_NAME_CHARS),
    gender: who.gender === 'Female' || who.gender === 'Male' ? who.gender : null,
    description: oneLine(who.description, MAX_DESCRIPTION_CHARS),
  }

  const listed = input.references
  if (listed !== undefined && !Array.isArray(listed)) {
    throw new DirectorInputError(400, 'BAD_REFERENCES', 'The list of pictures is not valid.')
  }
  if ((listed?.length ?? 0) > MAX_REFERENCES) {
    throw new DirectorInputError(400, 'BAD_REFERENCES', `At most ${MAX_REFERENCES} pictures can go with a video.`)
  }
  const references = (listed || []).map((entry, i) => {
    const role = entry && typeof entry === 'object' ? entry.role : null
    if (typeof role !== 'string' || !ROLES.includes(role)) {
      throw new DirectorInputError(400, 'BAD_REFERENCES', 'A picture in the list is not one of: product, character, character_extra, location.')
    }
    return { role, tag: `@Image${i + 1}` }
  })

  return { idea, seconds, aspect, language, character, references }
}

// ── What the model is told ───────────────────────────────────────────────────

/** How many shots suit a clip of this length: enough to keep it moving, few enough that each one can be shown. */
export function shotRange(seconds) {
  if (seconds <= 6) return [1, 2]
  if (seconds <= 10) return [2, 3]
  if (seconds <= 15) return [3, 4]
  if (seconds <= 20) return [4, 5]
  return [5, 7]
}

/** The director's standing instructions. `language` is checked text (see LANGUAGE), the only thing put into them. */
export function systemPrompt({ seconds, language }) {
  const [fewest, most] = shotRange(seconds)
  return [
    'You are the director of short UGC-style video ads. You write the shot-by-shot plan that a video model ' +
      '(ByteDance Seedance 2.5, reference images to video, with synchronized audio) turns into one clip.',
    '',
    'Answer with ONE JSON object and nothing else: no markdown, no code fence, no commentary before or after.',
    '',
    'HOW TO WORK',
    '- You may search the web, sparingly (two or three searches at most), only to check what makes this kind of ad ' +
      'work and how Seedance 2.x prompts are best written (concrete, filmable, one clear action per shot, ' +
      'speech in quotes). If the idea names a real product, brand or category you may look it up so its real ' +
      'use is right. Never copy text from a page, and never put a link, a source or a citation in your answer. ' +
      'If searching is not available, rely on what you know.',
    '- The plan is for an ordinary person filming on a phone: relatable, warm, believable. Not a polished commercial.',
    '',
    'THE JSON OBJECT',
    '{',
    '  "refusal": null,                       // null for every ordinary ad; one short sentence only if the idea clearly breaks the SAFETY rules (then nothing else is needed)',
    '  "product": "tea cup",                  // the advertised product in two or three words, or null if the idea has none',
    '  "summary": "...",                      // two sentences: who, where, what happens, how it feels',
    '  "shots": [',
    '    {',
    '      "label": "HOOK",                   // HOOK, PRODUCT REVEAL, USE, BENEFIT, LIFESTYLE or CTA',
    '      "start": 0, "end": 3,              // seconds',
    '      "visual": "...",                   // what the camera sees: framing, movement, the action, where the product is in the frame',
    '      "dialogue": "...",                 // what the character says in this shot, or null',
    '      "tone": "excited, casual",         // how it is said, two or three words, or null',
    '      "sfx": "..."                       // natural sounds heard in this shot',
    '    }',
    '  ],',
    '  "style": "...",                        // one or two sentences: phone footage, light, depth of field, skin, colour, handheld',
    '  "consistency": "..."                   // one sentence: what stays identical in every shot',
    '}',
    '',
    'RULES',
    `- The clip is ${seconds} seconds long. Use ${fewest === most ? fewest : `${fewest} to ${most}`} shots. They follow each other ` +
      `with no gap: the first starts at 0 and the last ends at ${seconds}.`,
    '- The first shot hooks within three seconds (speaking to the camera, or the product shown at once). The last shot ' +
      'is a friendly call to action. Do not invent prices, discounts or claims the person did not give.',
    `- Speech is in ${language}: natural spoken sentences, contractions, a strong first line. About two to three words ` +
      'per second of the shot, so a six second shot carries at most about fifteen words. At most two short lines per ' +
      'shot. A shot may have no speech at all. Never put speech or text on screen: no subtitles, captions or titles.',
    '- Sound is natural only: room tone, steps, pouring, taps, a page turning. No background music.',
    '- Pictures: one clear action per shot, what a camera can see, realistic skin and light. Keep the product in view ' +
      'in the shots where it matters. Never invent a logo, a brand name, text on the product, or an extra product.',
    '- The reference images are listed in the request, each with its tag (@Image1, @Image2…). Refer to a picture ' +
      'only by its exact tag, never invent another tag, and do not describe what an image looks like: the video model ' +
      'sees it. The character in every shot is the person in the character reference. If there is no character ' +
      'reference, describe the person from the description given and keep them identical in every shot. If there is no ' +
      'product reference, describe the product in words from the idea.',
    '- A "location" reference is the setting: use its place and light. Without one, choose a setting that fits the idea.',
    '',
    'SAFETY',
    '- Every person in the video is an adult (18 or older). A character with no age given is an adult in their twenties ' +
      'or thirties. "Girl", "boy", "lady" and "guy" in an idea are everyday words for a young adult: write them as an ' +
      'adult, and do not refuse because an age is missing.',
    '- Answer with {"refusal": "<one short sentence why>"} and nothing else ONLY if the idea clearly asks for: a child or ' +
      'teenager on screen, nudity or sexual content, violence or weapons, hateful or harassing content, or a named real ' +
      'person or celebrity. A product or a character that is merely attractive, athletic, fashionable or about beauty ' +
      'is an ordinary ad, not a reason to refuse.',
    '- Never make medical, health, weight-loss or income claims or promises, and never say a product treats or cures ' +
      'anything. If the idea contains one, leave the claim out and show the product being used instead: that is a ' +
      'rewrite, not a refusal.',
  ].join('\n')
}

/** What the person asked for, as the data the director works from. */
export function userMessage(input) {
  return JSON.stringify({
    idea: input.idea,
    seconds: input.seconds,
    aspect: input.aspect,
    language: input.language,
    character: {
      name: input.character.name || null,
      gender: input.character.gender,
      description: input.character.description || null,
    },
    references: input.references.map(r => ({ tag: r.tag, role: r.role })),
  })
}

// ── What comes back ──────────────────────────────────────────────────────────

/**
 * The text, and whether the web was searched, out of an OpenAI Responses API answer.
 *
 * `searched` is true only when the answer itself holds a web search call: asking for the tool is not the same as
 * the model using it, and the app says "researched online" only for the second.
 *
 * @returns {{text: string, refusal: string|null, searched: boolean, sources: number, incomplete: boolean}}
 */
export function extractOutput(json) {
  const items = Array.isArray(json?.output) ? json.output : []
  const parts = items
    .filter(item => item && item.type === 'message')
    .flatMap(item => (Array.isArray(item.content) ? item.content : []))

  const text = [
    ...parts.filter(p => p?.type === 'output_text' && typeof p.text === 'string').map(p => p.text),
    ...(typeof json?.output_text === 'string' && !parts.length ? [json.output_text] : []),
  ].join('\n').trim()

  const refusal = parts.find(p => p?.type === 'refusal' && typeof p.refusal === 'string')?.refusal ?? null

  const urls = new Set()
  for (const part of parts) {
    for (const note of Array.isArray(part?.annotations) ? part.annotations : []) {
      if (note?.type === 'url_citation' && typeof note.url === 'string') urls.add(note.url)
    }
  }

  return {
    text,
    refusal,
    searched: items.some(item => typeof item?.type === 'string' && item.type.startsWith('web_search')),
    sources: urls.size,
    incomplete: json?.status === 'incomplete',
  }
}

/**
 * The model's JSON, however it was wrapped: a code fence, a sentence before it, a stray comment after it.
 * @throws {DirectorOutputError}
 */
export function parseJsonObject(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) throw new DirectorOutputError('The answer holds no JSON object.')
  try {
    const parsed = JSON.parse(source.slice(start, end + 1))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new DirectorOutputError('The answer is not valid JSON.')
  }
}

const sentence = (value, max) => oneLine(typeof value === 'string' ? value : '', max)
const orNull = text => (text ? text : null)

/**
 * What a model writes in the "refusal" field when it means there is none ("none", "N/A"): the template shows
 * `null`, and a model that copies the field as a word has refused nothing. A real refusal is a sentence, and a
 * bare "No." still counts as one.
 */
const NO_REFUSAL = /^(?:null|none|nil|n\/a|na|false|undefined|no refusal|not applicable)\W*$/i

/**
 * The plan, checked: a refusal, or a summary and shots with a picture each.
 *
 * @returns {{refusal: string} | {plan: {
 *   product: string|null, summary: string, style: string, consistency: string,
 *   shots: Array<{label: string, start: number, end: number, visual: string, dialogue: string|null, tone: string|null, sfx: string|null}>
 * }}}
 * @throws {DirectorOutputError}
 */
export function readPlan(text, seconds) {
  const raw = parseJsonObject(text)

  const refusal = sentence(raw.refusal, 300)
  if (refusal && !NO_REFUSAL.test(refusal)) return { refusal }

  const shots = Array.isArray(raw.shots) ? raw.shots : []
  const kept = shots
    .filter(shot => shot && typeof shot === 'object' && sentence(shot.visual, 900))
    .slice(0, 10)
    .map(shot => ({
      label: sentence(shot.label, 28).toUpperCase() || 'SHOT',
      span: Math.max(0.5, Number(shot.end) - Number(shot.start)) || 1,
      visual: sentence(shot.visual, 900),
      dialogue: orNull(sentence(shot.dialogue, 260).replace(/["“”]/g, '')),
      tone: orNull(sentence(shot.tone, 40)),
      sfx: orNull(sentence(shot.sfx, 200)),
    }))
  if (!kept.length) throw new DirectorOutputError('The plan has no shots.')

  return {
    plan: {
      product: orNull(sentence(raw.product, 60)),
      summary: sentence(raw.summary, 600),
      style: sentence(raw.style, 500),
      consistency: sentence(raw.consistency, 400),
      shots: retime(kept, seconds),
    },
  }
}

/**
 * Give the shots whole-second timings that follow each other from 0 to `seconds` with nothing missing and
 * nothing overlapping, keeping the lengths the model chose in proportion. A model that wrote 0–3, 3–8, 9–30
 * (a hole at 8–9) or 0–20 for a 30 second clip gets a plan that fills it exactly.
 *
 * With more shots than seconds the last ones are dropped: a shot needs a second to be shown in.
 */
export function retime(shots, seconds) {
  const list = shots.slice(0, Math.max(1, Math.min(shots.length, seconds)))
  // A shot with no usable length counts as one second's worth, so no shot can take the whole clip or none of it.
  const weights = list.map(s => (Number.isFinite(s.span) && s.span > 0 ? s.span : 1))
  const total = weights.reduce((sum, w) => sum + w, 0)

  // Whole seconds, at least one each, in proportion; what is left over goes to the biggest remainders.
  const ideal = weights.map(w => (w / total) * seconds)
  const lengths = ideal.map(v => Math.max(1, Math.floor(v)))
  let spare = seconds - lengths.reduce((sum, n) => sum + n, 0)
  const byRemainder = ideal.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r)
  for (let k = 0; spare > 0; k = (k + 1) % byRemainder.length) { lengths[byRemainder[k].i] += 1; spare -= 1 }
  // Rounding up to one second each can overshoot: take it back from the longest shots.
  while (spare < 0) {
    const longest = lengths.indexOf(Math.max(...lengths))
    lengths[longest] -= 1
    spare += 1
  }

  let at = 0
  return list.map((shot, i) => {
    const { span, ...rest } = shot
    const start = at
    at += lengths[i]
    return { ...rest, start, end: at }
  })
}

// ── The prompt itself ────────────────────────────────────────────────────────

const POSSESSIVE = { Female: 'her', Male: 'his' }

/** The lines that say which picture is which. Written here, from the app's own list, never by the model. */
export function referenceLines(input, product) {
  const who = input.character.name || 'the person'
  const possessive = POSSESSIVE[input.character.gender] ?? 'their'
  let products = 0
  let characters = 0

  return input.references.map(({ role, tag }) => {
    if (role === 'product') {
      products += 1
      if (products > 1) {
        return `${tag}: another product to show. Keep its exact shape, colour and finish in every shot where it appears.`
      }
      return `${tag}: the ${product || 'product'} (the product being advertised). Keep its exact shape, colour, material and finish in every shot. Use only the product from this image and ignore the image's background.`
    }
    if (role === 'character') {
      characters += 1
      return characters === 1
        ? `${tag}: ${who}, the main character. Keep ${possessive} face, hair and outfit identical in every shot.`
        : `${tag}: another picture of the main character. Keep the same face, hair and outfit.`
    }
    if (role === 'character_extra') {
      return `${tag}: another view of the same character. Use it only to keep the face, body and outfit consistent.`
    }
    return `${tag}: the location. Use it as the setting, layout and lighting reference.`
  })
}

const stamp = (start, end) => `${start}-${end}s`

/**
 * The finished prompt: the reference lines, the summary, the shots, the style and the consistency line, and
 * the rules that close it.
 */
export function composePrompt(input, plan) {
  const speaker = input.character.name || 'the character'
  const lines = []

  const refs = referenceLines(input, plan.product)
  if (refs.length) lines.push(...refs, '')

  if (plan.summary) lines.push(`Summary: ${plan.summary}`, '')

  plan.shots.forEach((shot, i) => {
    lines.push(`SHOT ${i + 1} [${stamp(shot.start, shot.end)}] (${shot.label}): ${shot.visual}`)
    if (shot.dialogue) lines.push(`Dialogue (${speaker}${shot.tone ? `, ${shot.tone}` : ''}): "${shot.dialogue}"`)
    if (shot.sfx) lines.push(`SFX: ${shot.sfx}`)
    lines.push('')
  })

  const style = plan.style ||
    `Shot on a smartphone, vertical ${input.aspect}, natural light, slight handheld shake, realistic skin texture. Authentic UGC, not a polished commercial.`
  lines.push(`Style: ${style}`)

  const alike = `${speaker.charAt(0).toUpperCase()}${speaker.slice(1)} looks identical in every shot: same face, same hair, same outfit. The same product and the same place in every shot.`
  lines.push(`Consistency: ${plan.consistency || alike}`)

  lines.push(`No subtitles. No on-screen text. No background music: natural sounds only. Spoken language: ${input.language}.`)
  return lines.join('\n')
}
