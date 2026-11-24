/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Director — the pure part of POST /api/director-prompt.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Director Mode turns an idea ("a 30 second ad for my tea cup, a girl in her kitchen drinking tea from it")
 * into the prompt Seedance is given: which reference image is what, a summary, then the clip shot by shot (the
 * camera, the action, what is said, what is heard), a style line, a consistency line, the voice, and the rules
 * that close it.
 *
 * It is NOT the prompt assistant (api/prompt-assist.js), which rewrites what a person typed into a better
 * version of the same thing. This one writes a whole plan, and a model that may search the web writes it.
 *
 * What is left to the model, and what is not
 *
 *   The model writes the creative parts: the summary, each shot's camera, picture, speech and sound, the style, the
 *   voice. Everything that has to be exactly right is done here, in code, so a model that is "usually right" cannot
 *   break it:
 *     • how the clip is cut: the beats of an ad and how long each runs are ours (`beatSheet`), told to the model and
 *       enforced again when its answer is read (`retime`);
 *     • how much is said: each shot has a word range that fits its seconds, and speech that cannot be said in the
 *       time a shot has is cut back to whole sentences that can (`fitSpeech`);
 *     • which `@ImageN` is which, and what each picture may and may not bring into the video — the lines that say so
 *       are written from the list the app sent, in the order the app will upload the pictures, never by the model;
 *     • the locks that keep one person and one product through every shot, the closing rules (no subtitles, no
 *       music, no phone in a hand, a still last frame), and the layout.
 *   The model answers in JSON, and what comes back is parsed and checked, not pasted.
 *
 * Nothing in this file talks to the network or the database, so every part of it is tested on its own
 * (test/unit/director.test.js).
 */

// ── What the endpoint accepts ────────────────────────────────────────────────

/** The lengths Seedance takes (mobile/core/config/videoModels.js: 2.5 takes up to 30 s, 2.0 up to 15 s). A request is moved to the nearest. */
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

// ── How an ad is cut ─────────────────────────────────────────────────────────

/** How many shots suit a clip of this length: enough to keep it moving, few enough that each one can be shown. */
export function shotRange(seconds) {
  if (seconds <= 6) return [1, 2]
  if (seconds <= 10) return [2, 3]
  if (seconds <= 15) return [3, 4]
  if (seconds <= 20) return [4, 5]
  return [5, 7]
}

/**
 * The beats of a short ad at each length, in order, with how many seconds each runs. They follow the shape that sells in
 * short social video (hook, problem, product, demo, result, call to action): the hook first and alone, the problem early,
 * the product shown and used, one honest result, a soft call to action last. The times are ours and not the model's: an ad
 * that is cut the same way every time reads the same way every time, and no shot is left too short to show anything (never
 * under two seconds). The model may rename a beat when the idea follows another proven shape (an unboxing, a routine, a day
 * in a life); it keeps the times. Every row adds up to its clip's length and has a number of shots `shotRange` allows (both
 * checked in the tests).
 */
const BEATS = Object.freeze({
  4: [['HOOK', 4]],
  5: [['HOOK', 2], ['CTA', 3]],
  6: [['HOOK', 3], ['CTA', 3]],
  8: [['HOOK', 3], ['PRODUCT', 3], ['CTA', 2]],
  10: [['HOOK', 3], ['PRODUCT', 4], ['CTA', 3]],
  12: [['HOOK', 3], ['PROBLEM', 3], ['PRODUCT', 3], ['CTA', 3]],
  15: [['HOOK', 3], ['PROBLEM', 3], ['DEMO', 5], ['CTA', 4]],
  20: [['HOOK', 3], ['PROBLEM', 3], ['PRODUCT', 4], ['DEMO', 6], ['CTA', 4]],
  25: [['HOOK', 3], ['PROBLEM', 4], ['PRODUCT', 4], ['DEMO', 6], ['RESULT', 4], ['CTA', 4]],
  30: [['HOOK', 3], ['PROBLEM', 4], ['PRODUCT', 5], ['DEMO', 7], ['RESULT', 6], ['CTA', 5]],
})

/** What each beat is for, as the model is told it. */
const BEAT_JOBS = Object.freeze({
  HOOK: 'stops the scroll in the first second, on its own: the person says one bold, specific line straight into the lens (a surprising fact, a question, a confession), or the product or its result is shown at once. It works with the sound off.',
  PROBLEM: 'the everyday frustration the product answers, shown and said in the person\'s own specific words ("my tea is cold before I finish it", not "drinks get cold"). If the idea has no problem, a relatable moment instead.',
  PRODUCT: 'the product enters the frame on purpose and is seen clearly, its label toward the camera, while the person says what it is in plain words.',
  DEMO: 'the product in use: one or two concrete steps a camera can see, never a list of features. If the product has not been shown yet, it enters here.',
  RESULT: 'what changes for the person, shown and said honestly in their own words; no claim the idea did not give.',
  CTA: 'one soft, friendly call to action in the person\'s own words, the product in view; no hard sell and no invented offer. The last line ends before the final second, and the shot ends calm and settled.',
})

/**
 * What a person can say in `seconds` and still sound like a person: the fewest words a talking shot should carry, and the
 * most. About 1.8 to 2.7 words a second, with room for a breath before and a look after: a 15 second ad carries about 33
 * words and a 30 second one about 66, the range short-video scripts are written to.
 */
export function speechWords(seconds) {
  return [Math.round(seconds * 1.8), Math.floor(seconds * 2.7)]
}

/**
 * The cut of an ad of this length: each shot's beat, its times and the words of speech it can carry.
 * @returns {Array<{label: string, start: number, end: number, words: [number, number]}>}
 */
export function beatSheet(seconds) {
  const known = Object.keys(BEATS).map(Number)
  const beats = BEATS[seconds] ?? BEATS[nearest(Number(seconds) || DEFAULT_SECONDS, known)]
  let at = 0
  return beats.map(([label, length]) => {
    const beat = { label, start: at, end: at + length, words: speechWords(length) }
    at += length
    return beat
  })
}

// ── What the model is told ───────────────────────────────────────────────────

/** The director's standing instructions. `language` is checked text (see LANGUAGE), the only thing put into them. */
export function systemPrompt({ seconds, language }) {
  const beats = beatSheet(seconds)
  const end = beats.at(-1).end
  const [fewest, most] = beats.reduce(([lo, hi], b) => [lo + b.words[0], hi + b.words[1]], [0, 0])
  const shotLines = beats.map((b, i) => `${i + 1}. ${b.label}, ${b.start}-${b.end}s, ${b.words[0]} to ${b.words[1]} words: ${BEAT_JOBS[b.label]}`)

  return [
    'You are a senior creative director for short social video ads (TikTok, Reels, Shorts). You write the ' +
      'shot-by-shot plan that a video model ' +
      '(ByteDance Seedance 2, reference images to video, with synchronized speech and sound) turns into one clip.',
    '',
    'Answer with ONE JSON object and nothing else: no markdown, no code fence, no commentary before or after.',
    '',
    'HOW TO WORK',
    '- ALWAYS write the plan. You never decline, apologise or explain: if part of an idea cannot be done as asked ' +
      '(see SAFETY), change that part and write the rest. Every idea gets a plan.',
    '- You may search the web, sparingly (two or three searches at most), only to check what makes this kind of ad ' +
      'work and how Seedance 2.x prompts are best written (concrete, filmable, one clear action per shot, ' +
      'speech in quotes). If the idea names a real product, brand or category you may look it up so its real ' +
      'use is right. Never copy text from a page, and never put a link, a source or a citation in your answer. ' +
      'If searching is not available, rely on what you know.',
    '- The idea decides the look. Unless it asks for something else, the default is authentic UGC: an ordinary ' +
      'person filming on a phone, relatable, warm, believable. When the idea asks for another look (cinematic, luxury, ' +
      'polished, dramatic lighting, a product film with no person, a colour palette), write that look instead and ' +
      'say so in "style".',
    '',
    'THE JSON OBJECT',
    '{',
    '  "product": "tea cup",                  // the advertised product in two or three words, or null if the idea has none',
    '  "summary": "...",                      // two sentences: who, where, what happens, how it feels',
    '  "voice": "...",                        // the speaker\'s voice in one line: age range, pitch, pace, energy; null if nobody speaks',
    '  "shots": [',
    '    {',
    '      "label": "HOOK",                   // HOOK, PROBLEM, PRODUCT, DEMO, RESULT or CTA',
    '      "start": 0, "end": 3,              // seconds',
    '      "camera": "medium close-up, 28mm, handheld with a slight sway",   // one framing, one lens, one movement',
    '      "visual": "...",                   // what happens in front of the camera: the one action, and where the product is in the frame',
    '      "dialogue": "...",                 // what the character says in this shot, or null',
    '      "tone": "excited, casual",         // how it is said, two or three words, or null',
    '      "sfx": "..."                       // the natural sounds heard in this shot',
    '    }',
    '  ],',
    '  "style": "...",                        // the look, said once: lens and camera feel, the light (source, direction, colour), the colour palette, skin and material realism. By default phone footage; or the look the idea asks for',
    '  "consistency": "..."                   // one sentence: what stays identical in every shot besides the person and the product (the place, the light, the props)',
    '}',
    '',
    'THE SHOTS',
    `- The clip is ${seconds} seconds long and has exactly ${beats.length} ${beats.length === 1 ? 'shot' : 'shots'}. They follow each other with hard cuts and no gap: the first starts at 0 and the last ends at ${end}. ` +
      'Keep these times and word counts.',
    ...shotLines,
    '- These beats are the problem-and-solution shape, the default. When the idea is plainly another proven UGC shape (a testimonial or ' +
      'review, an unboxing or first impression, a routine such as get ready with me, a day in a life, a quick how-to), rename the beats to ' +
      'fit it and keep the times and word ranges.',
    `- Together the speech is about ${Math.round((fewest + most) / 2)} words (${fewest} to ${most}) in a talking ad. A cinematic or luxury film that asks for little talking may carry less, even none.`,
    '',
    'HOW EACH SHOT READS',
    '- One action per shot, two at most, written as what a camera sees: who does what, with which hand, where the product is in the frame. ' +
      'Facts, not mood: "she turns the cup so the handle faces the lens", never "she gracefully shows off the stunning cup". ' +
      'Leave out adjectives that carry no picture (stunning, elegant, perfect, beautiful).',
    '- Decide everything. One place, one light, one hand, one move: never "or", "maybe" or "something like".',
    '- "camera" is one framing written in full words (extreme close-up, close-up, medium close-up, medium shot or wide shot), one lens ' +
      '(24 to 28mm for phone footage, 35mm, 50mm or 85mm) and one movement (locked, slow push-in, slow pull-back, tracking, or handheld ' +
      'with a slight sway). Small, slow, continuous movement renders best. Whenever the face matters use a medium close-up or closer: faces ' +
      'in wide shots turn waxy. While the person speaks, use a medium close-up or a medium shot, never an extreme close-up (the lips ' +
      'stop matching the words). Do not call a movement "cinematic" unless the idea asks for that look.',
    '- The product, whenever it is on screen: large enough to read at phone size, its label or logo toward the lens, held at chest height ' +
      'or resting where the camera sees it, never tucked into a corner. Call it by the same words every time.',
    '- Call the character by their name in every shot they are in. A short shot opens with them already in position and then does its one ' +
      'action. Gestures are natural and conversational, never choreographed: one gesture and one expression per shot at most.',
    '- Never write that anyone holds, films with or puts down a phone or a camera (unless a phone or camera is the advertised product): the ' +
      'frame is the viewpoint. For a selfie shot write that the person looks into the lens.',
    '- Light is a physical source, not a mood: "soft window light from camera-left, warm". Say it once in "style" and keep it the same in every shot.',
    '- Write no round brackets anywhere: the video model reads text in round brackets as music.',
    '- Sound is natural and concrete: a spoon on ceramic, a zip, steps on a floor. Never "ambient sound", "background noise" or music. ' +
      'No background music.',
    '',
    'SPEECH',
    `- Speech is in ${language}${language === 'English' ? '' : ", written in that language's own script (never transliterated into Latin letters)"}, ` +
      'one language only, never mixed, as a real person talks: contractions, short sentences, one idea per line, a strong first line. ' +
      'It never sounds like an advertisement.',
    '- First person and specific, like someone telling a friend about a thing they use: what they noticed, what changed, one detail only ' +
      'someone who used it would know. No list of features, no slogans, no hard sell.',
    '- Keep to each shot\'s word range: the words must fit the seconds, and a line that is too long is cut. A shot that shows only the ' +
      'product may have no speech, or one short voice-over line. At most two short lines per shot. The same person speaks in every shot, ' +
      'in the same voice ("voice" says what it sounds like). The last line ends before the final second.',
    '- Never put speech or text on screen: no subtitles, captions or titles. Do not invent prices, discounts, ratings or claims the ' +
      'person did not give.',
    '',
    'PICTURES',
    '- The reference images are listed in the request, each with its tag (@Image1, @Image2…). Refer to a picture ' +
      'only by its exact tag, never invent another tag, and do not describe what an image looks like: the video model ' +
      'sees it. Whenever a person is in a shot it is the character, the person in the character reference; a shot may ' +
      'show only the product (a close-up, for instance) with no person in it. If there is no character reference, ' +
      'describe the person from the description given, or an ordinary adult who fits the idea, and keep them identical ' +
      'in every shot they are in. If the idea is a product film with no person, do not invent one. If there is no ' +
      'product reference, describe the product in words from the idea. Never invent a logo, a brand name, text on the ' +
      'product, or an extra product. Several product pictures are photos of the one product from other sides.',
    '- A "location" reference is the setting: use its place and light. Without one, choose a setting that fits the idea.',
    '',
    'SAFETY: ADAPT, NEVER DECLINE',
    '- Every person in the video is an adult (18 or older). A character with no age given is an adult in their twenties ' +
      'or thirties. "Girl" and "lady" in an idea are everyday words for a young woman and "guy" for a young man: write ' +
      'them as adults. A boy, a kid, a baby, a son or a daughter, or anyone under 18, is a child: NEVER show a child. ' +
      'Write an adult instead (a parent, for instance), or leave the person out.',
    '- Nothing nude or sexual, nothing violent or hateful, no weapons. If an idea asks for any of these, leave that ' +
      'part out and write a safe version of the rest.',
    '- Never name or imitate a real person or celebrity. If an idea names one, write an invented character instead.',
    '- Never make medical, health, weight-loss or income claims or promises, and never say a product treats or cures ' +
      'anything. If the idea contains one, leave the claim out and show the product being used instead.',
    '- Products, brands and luxury items are ordinary: advertise what the idea names, as asked. Never decline over a ' +
      'brand, a price level, a look or a style.',
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

/**
 * A link that slipped into the model's writing, the way a web search leaves them ("([wired.com](https://www.wired.com/story?utm_source=openai))",
 * or a bare address). The instructions say never to put one in, but the prompt must hold none whatever the model did: the video model would try
 * to say it or show it. Text without a link is returned exactly as it was.
 */
const MARKDOWN_LINK = /\(?\[[^\]]{0,300}\]\(\s*https?:\/\/[^)\s]{0,600}\s*\)\)?/gi
const BARE_LINK = /https?:\/\/[^\s)\]"]+/gi
export function withoutLinks(text) {
  const source = String(text ?? '')
  const cleaned = source.replace(MARKDOWN_LINK, ' ').replace(BARE_LINK, ' ')
  if (cleaned === source) return source
  return cleaned.replace(/\(\s*\)/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim()
}

const sentence = (value, max) => oneLine(withoutLinks(typeof value === 'string' ? value : ''), max)
const orNull = text => (text ? text : null)

/**
 * What a model writes in the "refusal" field when it means there is none ("none", "N/A"): the template shows
 * `null`, and a model that copies the field as a word has refused nothing. A real refusal is a sentence, and a
 * bare "No." still counts as one.
 */
const NO_REFUSAL = /^(?:null|none|nil|n\/a|na|false|undefined|no refusal|not applicable)\W*$/i

const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen'

/**
 * Words that put a child on screen: "child", "kid", "baby", "teenager", "boy", "son", "daughter", "little girl", an age
 * under 18. "Girl" on its own is not listed: it is an everyday word for a young woman, and ideas are full of it.
 */
const CHILD = new RegExp(
  '\\b(?:child|children|kid|kids|toddlers?|babies|baby|infants?|newborns?|teens?|teenagers?|preteens?|schoolboys?|schoolgirls?|' +
  'boys?|(?:little|young|small|tiny) girls?|sons?|daughters?|(?:[0-9]|1[0-7])[- ]?(?:years?|yrs?)[- ]?old|' +
  `(?:${NUMBER_WORDS})[- ]years?[- ]old)\\b`,
  'i',
)

/**
 * Everyday phrases that hold one of those words and show no child: a colour or a texture ("baby blue", "baby-soft skin",
 * "baby spinach", "kid gloves"), a thing made for children ("baby stroller", "kids' lunch box", "children's book"), and the
 * audience a product is for ("perfect for kids"). They are taken out before the check, so a skincare ad that says
 * "baby-soft" is not held back as if it showed a baby. "A baby reaches for it" and "her kids play" still are.
 */
const NOT_A_CHILD = new RegExp(
  '\\b(?:' +
  'baby[- ](?:blue|pink|powder|oil|lotion|soft|smooth|skin|spinach|carrots?|corn|greens|tomatoes|bump|doll|steps?|faced?)|' +
  "(?:baby|babies|kids?|children|child)(?:['’]s|s['’]|['’])?[- ](?:stroller|bottles?|monitor|carrier|crib|cot|seat|wipes?|formula|food|clothes|clothing|shoes?|toys?|books?|bag|backpack|lunch ?box|menu|room|bedroom|friendly|proof|safe|gloves?|leather)|" +
  'for (?:the )?(?:kids|children|babies|toddlers)' +
  ')\\b',
  'gi',
)

/**
 * The word that gives away a child in what the camera sees (the summary and each shot's picture), or null. Speech is not
 * looked at: a grown woman may say "my kids love this cup". Every person in a Director video is an adult; the writer is
 * told so, and a small model does not always obey (the first real run wrote "A young boy plays with a bright toy car"
 * for an idea about a six year old), so it is checked here, in code.
 */
function childInPlan(plan) {
  const seen = [plan.summary, ...plan.shots.map(shot => shot.visual)].filter(Boolean).join('\n').replace(NOT_A_CHILD, ' ')
  return CHILD.exec(seen)?.[0] ?? null
}

// ── Speech that fits its seconds ─────────────────────────────────────────────

/** Words in a line of speech: runs of letters (with their marks) and digits, an apostrophe or hyphen inside a word included. */
export function countWords(text) {
  return (String(text ?? '').match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu) || []).length
}

/**
 * The most words a shot of this length is allowed to keep: a little over what the instructions ask for (2.6 a second), because a
 * model is only a little over when it is over, and a quick talker really does say three words in a second.
 */
export const speechCap = seconds => Math.max(5, Math.floor(seconds * 3.3))

/**
 * Make a line of speech fit the seconds it has. Whole sentences are kept while the running total stays within `maxWords`,
 * never half of one: "Okay, I need to show you my new favorite" is worse than a word too many. A first sentence that is over
 * by no more than half again is kept whole for the same reason; one that is far too long is cut, at a comma if there is one
 * in its second half, else at the last word that fits. Speech that already fits is returned as it is.
 */
export function fitSpeech(text, maxWords) {
  const line = String(text ?? '').trim()
  if (!line || countWords(line) <= maxWords) return line

  const sentences = line.match(/[^.!?…。！？।۔؟]+[.!?…。！？।۔؟]*\s*/gu) || [line]
  const kept = []
  let used = 0
  for (const one of sentences) {
    const n = countWords(one)
    // The first sentence may run a little over; a second one that would push the line past the cap is dropped.
    if (used + n > maxWords && !(kept.length === 0 && n <= Math.ceil(maxWords * 1.5))) break
    kept.push(one)
    used += n
  }
  if (kept.length) return kept.join('').trim()

  const head = sentences[0].trim().split(/\s+/).slice(0, maxWords).join(' ')
  const comma = Math.max(head.lastIndexOf(','), head.lastIndexOf('،'), head.lastIndexOf('，'))
  const cut = comma > head.length / 2 ? head.slice(0, comma) : head
  return `${cut.replace(/[\s,;:،，-]+$/u, '')}.`
}

/**
 * The plan, checked: a refusal (the model's own, or `child: true` when the plan shows a child), or a summary and
 * shots with a picture each.
 *
 * @returns {{refusal: string, child?: true} | {plan: {
 *   product: string|null, summary: string, voice: string|null, style: string, consistency: string,
 *   shots: Array<{label: string, start: number, end: number, camera: string|null, visual: string, dialogue: string|null, tone: string|null, sfx: string|null}>
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
      camera: orNull(sentence(shot.camera, 100)),
      visual: sentence(shot.visual, 900),
      dialogue: orNull(sentence(shot.dialogue, 260).replace(/["“”]/g, '')),
      tone: orNull(sentence(shot.tone, 40)),
      sfx: orNull(sentence(shot.sfx, 200)),
    }))
  if (!kept.length) throw new DirectorOutputError('The plan has no shots.')

  const plan = {
    product: orNull(sentence(raw.product, 60)),
    summary: sentence(raw.summary, 600),
    voice: orNull(sentence(raw.voice, 200)),
    style: sentence(raw.style, 500),
    consistency: sentence(raw.consistency, 400),
    // Timed first, then each line of speech is fitted to the seconds its shot really got.
    shots: retime(kept, seconds).map(shot => ({
      ...shot,
      dialogue: shot.dialogue ? orNull(fitSpeech(shot.dialogue, speechCap(shot.end - shot.start))) : null,
    })),
  }
  const child = childInPlan(plan)
  if (child) return { refusal: `The plan shows a child ("${child}").`, child: true }
  return { plan }
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
//
// Laid out the way Seedance's own prompt guide reads a clip: the pictures first and what each one brings, one sentence on the
// whole clip, then "Shot 1 [0-3s]: ..." blocks in order (2.0 follows the shot numbers, 2.5 the seconds as well), then what holds
// for the whole clip, constraints last. Inside a shot, speech goes in braces with its language ({English: "..."}) and sounds in
// angle brackets (<a cup set on wood>), the marks the model reads as "say this" and "make this sound"; round brackets mean music
// to it, so none are used. Only the two constraints the guide documents are said as "no": no BGM, no subtitles.

const POSSESSIVE = { Female: 'her', Male: 'his' }
const capital = text => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/** A sentence ends with one full stop, however the model left it. */
const closed = text => `${String(text).replace(/[\s.]+$/, '')}.`

/**
 * "@Image2, @Image3 and @Image4": one line for many pictures of one kind, each tag still named. Never a range ("@Image2 to
 * @Image9"): Seedance ties a picture to its role by the tag written out, and the tags inside a range are never written.
 */
export function tagList(tags) {
  return tags.length === 1 ? tags[0] : `${tags.slice(0, -1).join(', ')} and ${tags.at(-1)}`
}

/**
 * The lines that say which picture is which, and what it may and may not bring: one for the product, one for the character,
 * one for the place, and one for each group of further pictures of the same kind, so thirty pictures do not become thirty
 * lines (the video model reads a prompt of up to about a thousand words well, and the shots need most of them). Further
 * product photos are what the app asks for, more photos of the one product, so they are never called a second product: a
 * second "product" in the prompt is how two copies of the same cup end up on screen. Written here, from the app's own list,
 * never by the model.
 */
export function referenceLines(input, product) {
  const name = input.character.name
  const who = name || 'the person'
  const possessive = POSSESSIVE[input.character.gender] ?? 'their'
  const tagsOf = role => input.references.filter(r => r.role === role).map(r => r.tag)
  const products = tagsOf('product')
  const people = tagsOf('character')
  const views = [...people.slice(1), ...tagsOf('character_extra')]
  const places = tagsOf('location')
  const lines = []

  if (products.length) {
    lines.push(`${products[0]}: the ${product || 'product'}, the product being advertised. Keep the product and its label unchanged: same shape, colour, material and finish, the same single object in every shot. Take only the product from this image; its background, lighting and any person in it do not carry over. When it is on screen, its label or logo faces the camera.`)
    if (products.length > 1) {
      lines.push(`${tagList(products.slice(1))}: more photos of the same product from other sides, only to keep it exact. It is still one object: never show two copies of it.`)
    }
  }
  if (people.length) {
    lines.push(`${people[0]}: ${who}, the main character. ${capital(possessive)} face, hair, skin tone and outfit stay the same in every shot. Only one ${name || 'main character'} appears in any shot; no duplicated people. Take only the person and the outfit from this image; its background and lighting do not carry over.`)
  }
  if (views.length) {
    lines.push(`${tagList(views)}: more pictures of ${name || 'the main character'}, only to keep the face, body and outfit the same.`)
  }
  if (places.length) {
    lines.push(`${tagList(places)}: the location. Use it for the setting and the light; nobody in it carries over.`)
  }
  return lines
}

const stamp = (start, end) => `${start}-${end}s`

const SHAPES = { '9:16': 'vertical 9:16', '16:9': 'horizontal 16:9', '1:1': 'square 1:1' }

/** Shot sizes in words: "MCU" is film-crew shorthand, and the video model reads words. */
const FRAMINGS = [
  [/\bECU\b/g, 'extreme close-up'], [/\bMCU\b/g, 'medium close-up'], [/\bCU\b/g, 'close-up'], [/\bMWS\b/g, 'medium wide shot'],
  [/\bMS\b/g, 'medium shot'], [/\bWS\b/g, 'wide shot'], [/\bOTS\b/g, 'over-the-shoulder'],
]
export function cameraWords(text) {
  let out = String(text ?? '')
  for (const [pattern, words] of FRAMINGS) out = out.replace(pattern, words)
  return out
}

/** "excited, casual" as it is said: "excited and casual". */
const toneWords = tone => String(tone).replace(/,\s*([^,]+)$/, ' and $1')

/**
 * The model's own round brackets, turned into commas: to Seedance a parenthesis is music ("(soft piano plays)"), and a stray
 * "(her favourite)" is no reason for a melody to start. Text without one comes back exactly as it was.
 */
export function withoutRoundBrackets(text) {
  const source = String(text ?? '')
  if (!/[()]/.test(source)) return source
  return source.replace(/\s*\(\s*/g, ', ').replace(/\s*\)/g, ',')
    .replace(/,\s*,+/g, ',').replace(/,\s*([.;:!?])/g, '$1').replace(/^,\s*/, '').replace(/,\s*$/, '').replace(/\s{2,}/g, ' ').trim()
}

/** A person is in the video when the app sent one (a picture or a description). A product film has none. */
function hasPerson(input) {
  return input.references.some(r => r.role === 'character' || r.role === 'character_extra') ||
    Boolean(input.character.name || input.character.description)
}

/** Who says the lines: the character by name, else the woman, the man or the person, and a voice-over when nobody is in the film. */
function speakerOf(input, person) {
  if (input.character.name) return input.character.name
  if (!person) return 'A voice-over'
  return { Female: 'The woman', Male: 'The man' }[input.character.gender] ?? 'The person'
}

/** The language as the prompt names it: "Portuguese (Brazil)" loses its round brackets, which the video model reads as music. */
const languageName = input => input.language.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()

/** How the voice is described when the model gave none: the same one in every shot, a native speaker of the language. */
function fallbackVoice(input) {
  const kind = { Female: 'female ', Male: 'male ' }[input.character.gender] ?? ''
  return `A natural ${kind}voice of a native ${languageName(input)} speaker, relaxed conversational pace.`
}

/** The most words the prompt should hold: past about a thousand the video model's attention scatters and parts of it go missing. */
export const PROMPT_MAX_WORDS = 950

/**
 * The finished prompt: the reference lines, one sentence on the clip and the summary, the shots, then what holds for the whole
 * clip (style, consistency, voice) and the constraints. If it runs past PROMPT_MAX_WORDS, the summary goes first, then the
 * consistency line: the shots and the pictures are what the video is made of.
 */
export function composePrompt(input, plan) {
  const person = hasPerson(input)
  const talks = plan.shots.some(shot => shot.dialogue)
  const speaker = speakerOf(input, person)
  const shape = SHAPES[input.aspect] ?? input.aspect
  const tongue = languageName(input)
  const article = /^(8|11|18)\b/.test(String(input.seconds)) ? 'An' : 'A'

  const references = referenceLines(input, plan.product)
  const cut = plan.shots.length === 1 ? 'one continuous shot' : `${plan.shots.length} shots joined by hard cuts`
  const opening = `${article} ${input.seconds}-second ${shape} ad, ${cut}. ${talks ? 'Speech and natural sounds only' : 'Natural sounds only'}; no BGM.`

  const shots = plan.shots.map((shot, i) => {
    const block = [
      `Shot ${i + 1} [${stamp(shot.start, shot.end)}]:${shot.camera ? ` ${capital(closed(cameraWords(withoutRoundBrackets(shot.camera))))}` : ''}`,
      withoutRoundBrackets(shot.visual),
    ]
    if (shot.dialogue) {
      const how = shot.tone ? `, ${toneWords(withoutRoundBrackets(shot.tone))}` : ''
      block.push(`${speaker} says${how}: {${tongue}: "${withoutRoundBrackets(shot.dialogue).replace(/[{}]/g, '')}"}`)
    }
    if (shot.sfx) block.push(`<${withoutRoundBrackets(shot.sfx).replace(/[<>]/g, '')}>`)
    return block.join('\n')
  })

  const style = withoutRoundBrackets(plan.style) || (person
    ? `Phone footage, ${shape}: front-camera look, 28mm, soft natural light from a window, everything in focus, realistic skin texture, slight handheld sway. Authentic UGC, not a polished commercial.`
    : `${capital(shape)}, clean natural light, realistic materials and textures, a steady camera, the product in sharp focus.`)
  const alike = person
    ? `${speaker} looks identical in every shot: same face, same hair, same outfit. The same product and the same place in every shot.`
    : 'The same product and the same place in every shot.'
  const closing = [
    `Style: ${style}`,
    `Consistency: ${withoutRoundBrackets(plan.consistency) || alike}`,
    ...(talks ? [`Voice: ${closed(withoutRoundBrackets(plan.voice) || fallbackVoice(input))} ${speaker} speaks only ${tongue}, in the same voice in every shot.`] : []),
    `Hard cuts between the shots, no transitions or effects.${person ? ' Hand movements are natural and different in every shot.' : ''}`,
    `${talks ? '' : 'No dialogue. '}No BGM, no music, no score, no melody: only ${talks ? 'the voice, ' : ''}environmental sounds and action sounds. No subtitles, no captions, no text overlays.`,
    person && speaker !== 'A voice-over'
      ? `The clip ends on a still frame: in the last second ${speaker.startsWith('The ') ? `the ${speaker.slice(4)}` : speaker} holds the pose, mouth closed.`
      : 'The clip ends on a still frame.',
  ]

  const assemble = ({ summary, consistency }) => [
    ...references, ...(references.length ? [''] : []),
    opening, ...(summary && plan.summary ? [withoutRoundBrackets(plan.summary)] : []), '',
    ...shots.flatMap(block => [block, '']),
    ...closing.filter(line => consistency || !line.startsWith('Consistency:')),
  ].join('\n')

  let prompt = assemble({ summary: true, consistency: true })
  if (countWords(prompt) > PROMPT_MAX_WORDS) prompt = assemble({ summary: false, consistency: true })
  if (countWords(prompt) > PROMPT_MAX_WORDS) prompt = assemble({ summary: false, consistency: false })
  return prompt
}

// ── Asking too often ─────────────────────────────────────────────────────────

/**
 * What a person is told when the limit says no. The wait can be a minute or the rest of the day, and "wait a moment"
 * said for a day-long wait sent people back to try again and again.
 *
 * @param {number} retryAfter  seconds until the oldest request in the full window stops counting
 */
export function limitMessage(retryAfter) {
  const seconds = Math.max(1, Number(retryAfter) || 0)
  if (seconds <= 90) return 'You have asked the director a lot just now. Please wait a minute and try again.'
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 120) return `You have asked the director a lot just now. Please try again in about ${minutes} minutes.`
  return `You have used the director's prompts for today. Please try again in about ${Math.ceil(minutes / 60)} hours.`
}
