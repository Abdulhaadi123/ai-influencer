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
 *   The model writes the creative parts: the format, the summary, the place, the person's look, each shot's camera,
 *   action, performance, speech and sound, the style, the voice. Everything that has to be exactly right is done here,
 *   in code, so a model that is "usually right" cannot break it:
 *     • how the clip is cut: the slots of each length are ours, the model picks a format whose beats fill them
 *       (`FORMATS`, `beatSheet`), told to the model and enforced again when its answer is read (`timed`);
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

import { isUuid } from './validate.js'

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
    // The file the picture is, when the app says (so the writer can be shown it). Only an id is kept, and only one that is
    // an id: whose file it is, is checked against the database before anything is done with it (api/director-prompt.js).
    const assetId = isUuid(entry.assetId) ? entry.assetId.toLowerCase() : null
    return { role, tag: `@Image${i + 1}`, ...(assetId ? { assetId } : {}) }
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
 * The slots of a clip at each length: how many seconds each shot runs, in order. The hook gets the first three seconds on its
 * own, no shot is shorter than two seconds, and each row adds up to its clip's length (both checked in the tests). The times
 * are ours, not the model's: a model left to time an ad itself wrote 0-3, 3-8, 9-30 and a hook of eight seconds.
 */
const SLOTS = Object.freeze({
  4: [4],
  5: [2, 3],
  6: [3, 3],
  8: [3, 3, 2],
  10: [3, 4, 3],
  12: [3, 3, 3, 3],
  15: [3, 3, 5, 4],
  20: [3, 3, 4, 6, 4],
  25: [3, 4, 4, 6, 4, 4],
  30: [3, 4, 5, 7, 6, 5],
})

/**
 * The shapes a short ad takes. The first versions of the writer had one (hook, problem, product, demo, result, call to action)
 * and every ad came out cut the same way: "basic", in the owner's sir's word (26 November 2026). These are the formats that
 * carry UGC ads (a problem solved, an honest review, an unboxing, a routine, a quick how-to, a list of reasons) and a film with
 * no person for the ideas that ask for one. The model picks one; the beats are its own.
 *
 * Each beat has a rank: a clip with fewer slots keeps the lowest ranks, in the order they play. The hook (or opening) and the
 * call to action (or end frame) rank first and second, so every ad keeps its first and last beat. `minShots` keeps a format
 * from lengths too short for it (three reasons do not fit in three shots with a hook and a call to action).
 */
export const FORMATS = Object.freeze({
  problem_solution: {
    use: 'the product ends an everyday annoyance',
    beats: [['HOOK', 1], ['PROBLEM', 4], ['PRODUCT', 5], ['DEMO', 3], ['RESULT', 6], ['CTA', 2]],
  },
  honest_review: {
    use: 'a real opinion after using it: why they tried it, the detail they love, the verdict',
    beats: [['HOOK', 1], ['WHY I TRIED IT', 4], ['PRODUCT', 5], ['FAVOURITE DETAIL', 3], ['VERDICT', 6], ['CTA', 2]],
  },
  unboxing: {
    use: 'a first impression: the reveal, the first touch, the first use',
    beats: [['HOOK', 1], ['REVEAL', 3], ['FIRST LOOK', 5], ['FIRST USE', 4], ['REACTION', 6], ['CTA', 2]],
  },
  routine: {
    use: 'the product as one step of a routine: get ready with me, a morning routine, a day in a life',
    beats: [['HOOK', 1], ['THE ROUTINE', 5], ['THE PRODUCT STEP', 3], ['CLOSE DETAIL', 4], ['THE RESULT', 6], ['CTA', 2]],
  },
  how_to: {
    use: 'a quick tutorial: how to use it, a trick, a hack',
    beats: [['HOOK', 1], ['SETUP', 5], ['STEP ONE', 3], ['STEP TWO', 6], ['PAYOFF', 4], ['CTA', 2]],
  },
  reasons: {
    use: 'a short list, "three reasons I…", when the product has several distinct wins',
    minShots: 4,
    beats: [['HOOK', 1], ['REASON ONE', 3], ['REASON TWO', 4], ['REASON THREE', 5], ['PROOF', 6], ['CTA', 2]],
  },
  hands_only: {
    use: 'faceless UGC: only hands and the product, close and in macro, the texture and the use shown, a voice-over or no speech at all',
    beats: [['HOOK', 1], ['FIRST LOOK', 5], ['DETAIL', 3], ['IN USE', 4], ['THE RESULT', 6], ['END FRAME', 2]],
  },
  product_film: {
    use: 'a cinematic, luxury or studio film with the product as the hero: nobody on screen, or a person who acts and feels but never talks to the lens',
    beats: [['OPENING', 1], ['REVEAL', 3], ['DETAIL', 4], ['IN USE', 5], ['HERO', 6], ['END FRAME', 2]],
  },
})

/**
 * Formats in which nobody talks to the lens: any speech is a voice-over, and the closing line does not ask a face to hold
 * still (in a hands-only clip there is none to hold).
 */
export const FACELESS_FORMATS = Object.freeze(['hands_only', 'product_film'])
export const DEFAULT_FORMAT = 'problem_solution'

/** What each beat is for, as the model is told it. */
const BEAT_JOBS = Object.freeze({
  'ONE SHOT': 'the whole ad in one continuous shot: something worth looking at in the first second, the product clearly shown, one honest line about it.',
  HOOK: 'stops the scroll in the first second, on its own. A bold, specific line straight into the lens (a confession, a surprising fact, a strong opinion, a question) together with an action worth looking at, or the product or its result shown at once. It works with the sound off.',
  OPENING: 'a first frame that is already striking: a texture, a silhouette, light moving across the product.',
  PROBLEM: 'the everyday frustration the product answers, shown and said in the person\'s own specific words ("my tea is cold before I finish it", not "drinks get cold").',
  PRODUCT: 'the product enters the frame on purpose and is seen clearly, label toward the lens, while the person says what it is in plain words.',
  DEMO: 'the product in use: one or two concrete steps a camera can see, never a list of features. If the product has not been shown yet, it enters here.',
  RESULT: 'what changes for the person, shown and said honestly in their own words.',
  'WHY I TRIED IT': 'the honest reason they tried it, or the doubt they had about it.',
  'FAVOURITE DETAIL': 'one specific detail up close that only someone who uses it notices: a texture, a click, a smell, a finish.',
  VERDICT: 'the honest verdict in a line or two; a small "but" makes it believable.',
  REVEAL: 'the product revealed: a lid lifted, wrapping pulled back, or the product turned into the light.',
  'FIRST LOOK': 'the first close look and touch: turning it, feeling the weight or the texture.',
  'FIRST USE': 'using it for the first time, the camera on what happens.',
  REACTION: 'the genuine reaction in the face: surprise, a laugh, a slow nod.',
  'THE ROUTINE': 'the moment of the day around it, the step just before the product.',
  'THE PRODUCT STEP': 'the product used as the step it is, close enough to see how.',
  'CLOSE DETAIL': 'one specific detail up close: a texture, a finish, the way it moves or pours.',
  'THE RESULT': 'the finished result of the routine, seen and felt.',
  SETUP: 'what is needed, shown at once, the product included.',
  'STEP ONE': 'one concrete step, filmed so a viewer could copy it.',
  'STEP TWO': 'the next concrete step, filmed so a viewer could copy it.',
  PAYOFF: 'the satisfying result of the steps.',
  'REASON ONE': 'the first reason, shown as well as said.',
  'REASON TWO': 'a second reason of a different kind, shown as well as said.',
  'REASON THREE': 'a third reason of a different kind again, shown as well as said.',
  PROOF: 'the reasons proven in one picture.',
  DETAIL: 'one detail up close: the material, the texture, a moving part, the label.',
  'IN USE': 'the product doing what it does, in a real moment.',
  HERO: 'the product at its best: still, centred, the light on it.',
  CTA: 'one soft, friendly call to action in the person\'s own words, the product in view; no hard sell and no invented offer. The last line ends before the final second, and the shot ends calm and settled.',
  'END FRAME': 'a calm closing image of the product, its label readable, a voice-over line at most; the shot ends still.',
})

/** The slots of a clip of this length (the nearest length there is a row for). */
function slotsOf(seconds) {
  const known = Object.keys(SLOTS).map(Number)
  return SLOTS[seconds] ?? SLOTS[nearest(Number(seconds) || DEFAULT_SECONDS, known)]
}

/** The formats a clip of this length can take: all of them but those that need more shots than it has. */
export function formatsFor(seconds) {
  const shots = slotsOf(seconds).length
  return Object.keys(FORMATS).filter(name => shots >= (FORMATS[name].minShots ?? 1))
}

/** The beats of `format` that fill `count` slots, in the order they play: the lowest ranks are kept. One slot is one shot. */
export function formatBeats(format, count) {
  if (count <= 1) return ['ONE SHOT']
  const beats = (FORMATS[format] ?? FORMATS[DEFAULT_FORMAT]).beats
  const kept = new Set([...beats].sort((a, b) => a[1] - b[1]).slice(0, count).map(([label]) => label))
  return beats.filter(([label]) => kept.has(label)).map(([label]) => label)
}

/**
 * What a person can say in `seconds` and still sound like a person: the fewest words a talking shot should carry, and the
 * most. About 1.8 to 2.7 words a second, with room for a breath before and a look after: a 15 second ad carries about 33
 * words and a 30 second one about 66, the range short-video scripts are written to.
 */
export function speechWords(seconds) {
  return [Math.round(seconds * 1.8), Math.floor(seconds * 2.7)]
}

/**
 * The cut of an ad of this length in a format: each shot's beat, its times and the words of speech it can carry.
 * @returns {Array<{label: string, start: number, end: number, words: [number, number]}>}
 */
export function beatSheet(seconds, format = DEFAULT_FORMAT) {
  const slots = slotsOf(seconds)
  const labels = formatBeats(format, slots.length)
  let at = 0
  return slots.map((length, i) => {
    const beat = { label: labels[i], start: at, end: at + length, words: speechWords(length) }
    at += length
    return beat
  })
}

// ── What the model is told ───────────────────────────────────────────────────

const CAMERA_SHAPES = { '9:16': 'vertical 9:16', '16:9': 'horizontal 16:9', '1:1': 'square 1:1' }

/**
 * One finished plan, at the level of detail the model is asked for: a different product, a different length and a different
 * format from most requests, so that it shows the depth and not a template to copy (the instructions say so too).
 */
const EXAMPLE_PLAN = Object.freeze({
  format: 'honest_review',
  angle: 'A coffee lover admits a small ceramic dripper beat his machine, and the slow bloom of the coffee is the proof.',
  hooks: [
    'I sold my espresso machine because of this.',
    'My coffee machine is jealous of this little cone.',
    'Stop buying coffee pods. Seriously.',
  ],
  product: 'ceramic pour-over dripper',
  summary: 'Sam, a relaxed man in his early thirties, films himself at his small kitchen counter on a sunny morning. He admits a simple ceramic dripper beat his machine, and shows the slow pour that makes the difference.',
  setting: 'A narrow apartment kitchen counter at eight in the morning: a gooseneck kettle, a glass carafe, a paper bag of coffee beans, a chipped blue mug; low sun from a window on camera-left.',
  look: 'A man in his early thirties, medium build, short curly dark hair, light stubble, olive skin, a faded grey t-shirt.',
  voice: 'Early thirties, low and warm, easy pace, a dry sense of humour.',
  music: 'Warm acoustic guitar loop, about 95 BPM, relaxed and bright.',
  shots: [
    {
      beat: 'HOOK', start: 0, end: 3,
      camera: 'Medium close-up, phone front camera at arm\'s length, handheld with a slight sway',
      action: 'Sam leans into frame holding the white ceramic dripper up beside his face, its ridged inside toward the lens, steam rising from the kettle behind him.',
      performance: 'Eyebrows raised, a guilty half-smile, eyes straight into the lens.',
      dialogue: 'I sold my espresso machine because of this.',
      delivery: 'deadpan, confessional',
      sfx: 'the kettle ticking as it heats',
    },
    {
      beat: 'WHY I TRIED IT', start: 3, end: 6,
      camera: 'Medium shot, phone propped on the counter, locked',
      action: 'Sam sets the dripper on the glass carafe and drops in a paper filter, then shakes ground coffee in from the bag.',
      performance: 'A small shrug while he talks, eyes on his hands, then back up to the lens.',
      dialogue: 'I honestly thought it was a gimmick.',
      delivery: 'wry, relaxed',
      sfx: 'the paper filter rustling, coffee grounds pattering',
    },
    {
      beat: 'FAVOURITE DETAIL', start: 6, end: 11,
      camera: 'Close-up, phone rear camera close to the dripper, push-in',
      action: 'The gooseneck kettle pours a thin spiral of water over the grounds; the coffee swells and bubbles, then dark coffee threads down into the carafe.',
      performance: null,
      dialogue: 'Watch it bloom. That\'s the secret. Tastes like my café\'s.',
      delivery: 'quiet, almost reverent',
      sfx: 'a soft steady pour, coffee dripping into glass',
    },
    {
      beat: 'CTA', start: 11, end: 15,
      camera: 'Medium close-up, phone front camera at arm\'s length, handheld with a slight sway',
      action: 'Sam sips from the chipped blue mug, the dripper resting on the carafe beside his shoulder, its glazed side toward the lens.',
      performance: 'Closes his eyes for a beat, then nods slowly at the lens with a small grin.',
      dialogue: 'Best thing on my counter. Link\'s below.',
      delivery: 'satisfied, easy',
      sfx: 'a mug set down on wood',
    },
  ],
  style: 'Shot on a phone, vertical 9:16: the front camera for talking shots, the rear camera for the close-up, low morning sun from a window on camera-left, warm highlights and cool shadows, true-to-life colour, natural skin texture, slight handheld movement.',
  consistency: 'The same narrow kitchen counter, the same morning sun from camera-left, the same chipped blue mug and glass carafe in every shot.',
})

/**
 * A second example, the other kind of ad: a studio product film with nobody on screen, as in the reference ads the owner's sir
 * sent (ingredients around the product, liquid in slow motion, a commercial light, the product alone at the end).
 */
const EXAMPLE_FILM = Object.freeze({
  format: 'product_film',
  angle: 'Freshness you can see: the juice looks cold and just pressed before a word is said.',
  hooks: [
    'A halved orange hits wet slate and bursts into droplets.',
    'Cold droplets run down the bottle in a beam of light.',
    'The cap twists off with a crisp crack.',
  ],
  product: 'orange juice bottle',
  summary: 'A short studio film: a halved orange bursts on wet slate, then the chilled bottle stands beaded with cold droplets in a warm rim light and settles as the hero.',
  setting: 'A studio tabletop of wet dark slate with three halved oranges and a few green leaves; a soft key light from camera-left, a warm rim light from behind, a deep charcoal background.',
  look: null,
  voice: 'A woman in her thirties, warm and low, close to the microphone.',
  music: 'Minimal electronic beat, about 105 BPM, fresh and bright.',
  shots: [
    {
      beat: 'OPENING', start: 0, end: 3,
      camera: 'Extreme close-up, macro lens, locked',
      action: 'A halved orange drops onto the wet slate and its juice bursts outward in glistening droplets against the charcoal background.',
      performance: null, dialogue: null, delivery: null,
      sfx: 'a wet thud, droplets pattering on stone',
    },
    {
      beat: 'REVEAL', start: 3, end: 7,
      camera: 'Close-up, 85mm, push-in',
      action: 'The glass bottle of orange juice stands among the halved oranges, cold droplets running down its sides as the rim light traces its edge, its label facing the lens.',
      performance: null,
      dialogue: 'Cold-pressed, the way oranges should taste.',
      delivery: 'warm, unhurried',
      sfx: 'glass set down softly on slate',
    },
    {
      beat: 'END FRAME', start: 7, end: 10,
      camera: 'Medium close-up, 50mm, locked',
      action: 'The bottle alone at the centre of the slate, label facing the lens, a single droplet sliding down the glass, the oranges soft and out of focus behind it.',
      performance: null, dialogue: null, delivery: null,
      sfx: 'a last droplet tapping the slate',
    },
  ],
  style: 'Commercial studio film, vertical 9:16: a soft key light from camera-left and a warm rim light from behind on a deep charcoal background, saturated orange and green against dark slate, crisp macro detail, shallow depth of field.',
  consistency: 'The same wet slate, the same halved oranges and the same studio light in every shot.',
})

/**
 * The director's standing instructions: who it is, why the plan matters, how to work, the cut, the formats, the craft of UGC,
 * what the video model renders well, the language, the pictures, safety, the quality bar, the answer's shape and one example.
 *
 * Written to the prompting guides of both model makers (Anthropic's and OpenAI's, read 26 November 2026): a role, the reason
 * behind each rule rather than the rule alone, the work in order, sections in tags, the ask for ambitious and specific work,
 * a check before answering, the output's shape last before the example. `language` and `aspect` are checked values (see
 * LANGUAGE and ASPECTS), the only things put into it; the idea itself goes in the request, never here.
 */
export function systemPrompt({ seconds, language, aspect = DEFAULT_ASPECT }) {
  const slots = slotsOf(seconds)
  const count = slots.length
  const shape = CAMERA_SHAPES[aspect] ?? CAMERA_SHAPES[DEFAULT_ASPECT]
  const offered = formatsFor(seconds)
  const sheet = beatSheet(seconds)
  const end = sheet.at(-1).end
  const [fewest, most] = sheet.reduce(([lo, hi], b) => [lo + b.words[0], hi + b.words[1]], [0, 0])
  const shotWord = count === 1 ? 'shot' : 'shots'

  const slotLines = sheet.map((b, i) => `Shot ${i + 1}: ${b.start}-${b.end}s, speech ${b.words[0]} to ${b.words[1]} words`)
  const formatLines = count === 1
    ? ['- one_shot: the clip is one continuous shot (ONE SHOT). Answer "format": "one_shot".']
    : offered.map(name => `- ${name}: ${formatBeats(name, count).join(' → ')}. For ${FORMATS[name].use}.`)
  const usedBeats = [...new Set(count === 1 ? ['ONE SHOT'] : offered.flatMap(name => formatBeats(name, count)))]
  const jobLines = usedBeats.map(label => `- ${label}: ${BEAT_JOBS[label]}`)
  const speech = `${language}${language === 'English' ? '' : ", written in that language's own script (never transliterated into Latin letters)"}`

  return [
    '<role>',
    'You are the creative director of a performance agency that makes UGC video ads for TikTok, Instagram Reels and YouTube ' +
      'Shorts. You have scripted and directed thousands of ads that feel like a real person\'s own video and still sell, and you ' +
      'know exactly how an AI video model renders a written shot. Here you write the shot plan that ByteDance Seedance 2 ' +
      '(reference images to video, with synchronized speech and sound) turns into one finished clip.',
    '</role>',
    '',
    '<why_it_matters>',
    '- The video model films what you write, word for word. A vague plan becomes a generic, forgettable video; a specific plan ' +
      'becomes a believable ad. The person who asked pays for every clip, so a basic plan wastes their money.',
    '- They typed only a short idea. You make every creative decision they did not: the angle, the hook, the place and its ' +
      'objects, the outfit, the performance, every line of speech, every camera choice. Be ambitious and specific: the standard ' +
      'is an ad a top creator would post and a brand would pay for, never a template with the product\'s name filled in.',
    '- Code reads your answer, not a person: it is one JSON object in the shape given at the end. Code adds the picture tags, ' +
      'the timings, the locks that keep the person and the product the same, and the closing rules, so you never write those.',
    '</why_it_matters>',
    '',
    '<how_to_work>',
    'Think it through in this order before you write; only the JSON is your answer.',
    '1. The product and the buyer: what exactly it is, who buys it, the moment of their day it belongs to, the one benefit that ' +
      'sells it, the doubt a buyer has. If pictures are attached, study them: the product\'s real shape, size, colour, material ' +
      'and label, how it opens, how it is held and used. If the idea names a brand or product you do not know, you may search ' +
      'the web once or twice to learn what it is and how it is used; never copy text from a page, and never put a link, a ' +
      'source or a citation in your answer. Everything about craft is in these instructions: do not search for it.',
    '2. The angle: one sentence on why someone would stop scrolling for this, and why they would believe this person. Then ' +
      'pick the one format below that tells that angle best.',
    '3. The hook: write three different hooks and keep the strongest. It works in the first second with the sound off (an ' +
      'action or a picture worth stopping for) and with the sound on (a line that makes them need the next one).',
    '4. The creator and their world: one specific person (the character given) in one specific, lived-in place at one time ' +
      'of day, with three to five named objects that say who they are, one outfit, one light source.',
    '5. The script: write the speech as one continuous take in the creator\'s own voice, then split it across the shots by ' +
      'their word budgets. Hear it aloud: any line that sounds like copywriting is rewritten.',
    '6. The shots: direct each slot. The framing and the camera, the one action, the performance (face, eyes, hands, ' +
      'energy), where the product is and how it is held, the sounds.',
    '7. Check the plan against the quality bar below and fix whatever is generic before you answer.',
    '- ALWAYS write the plan. You never decline, apologise or explain: if part of an idea cannot be done as asked (see ' +
      'safety), change that part and write the rest. Every idea gets a plan.',
    '</how_to_work>',
    '',
    '<the_cut>',
    `The clip is ${seconds} seconds long and has exactly ${count} ${shotWord}${count === 1 ? '' : ', joined by hard cuts with no gap'}: ` +
      `the first starts at 0 and the last ends at ${end}. Keep these times and these word budgets.`,
    ...slotLines,
    `Together the speech is about ${Math.round((fewest + most) / 2)} words (${fewest} to ${most}) in a talking ad. A cinematic or ` +
      'product-only film may say less, even nothing.',
    '</the_cut>',
    '',
    '<formats>',
    `Choose the ONE format that sells this idea best, and put its beats into the ${shotWord} in this order. The beats are already ` +
      `fitted to ${count} ${shotWord}. If the idea itself asks for a format (an unboxing, a review, a routine, a tutorial), use it.`,
    'When the request has a character (a picture of them, or a name or a description), the person paid for an ad with that ' +
      'character in it: they are its face, seen clearly in it. Then choose hands_only only when the idea asks for no face or ' +
      'only hands, and product_film only when it asks for a cinematic, luxury or studio film (and even then they appear in it). ' +
      'With no character and no person in the idea, product_film or hands_only is the natural choice.',
    ...formatLines,
    'What each beat does:',
    ...jobLines,
    '</formats>',
    '',
    '<ugc_craft>',
    'Unless the idea asks for another look, the ad is authentic UGC: a real person\'s own phone video that happens to sell.',
    `- Camera: shot on a phone, ${shape}. Talking shots: the front camera at arm's length, eye level or a little above, the ` +
      'face slightly off-centre, the person talking straight into the lens as if on a video call with a friend. Product ' +
      'close-ups: the rear camera close to the product in the creator\'s own hand, a point-of-view shot, or the phone propped ' +
      'on a counter for hands-free demos. Subtle natural handheld movement and small reframes; never gimbal-smooth glides, ' +
      'whip pans or fast zooms.',
    '- Editing: talking parts may run as jump cuts, two shots in a row with the same framing where the person has shifted a ' +
      'little and carries on mid-thought. Alternate talking shots with close-ups of the product to keep the eye moving.',
    '- Place: real and lived-in, named precisely. Not "a modern kitchen" but "a small kitchen counter with a dented kettle, a ' +
      'fruit bowl and morning sun across the tiles". Natural window light or a lamp in the room; a little mixed colour is fine.',
    '- People: natural skin with pores and fine lines, a little asymmetry, everyday clothes with creases, hair as it really is, ' +
      'never airbrushed. Real micro-expressions: a half-smile, raised ' +
      'eyebrows, a quick laugh, a shrug, eyes going to the product and back to the lens. The energy of a creator, not a ' +
      'presenter: relaxed, a little excited, never shouting.',
    '- Speech: starts mid-thought ("Okay, so…", "I need to talk about this", "Nobody told me…"), contractions, short sentences, ' +
      'one idea per line, the strongest line first. First person and specific: a detail only someone who uses it would know, ' +
      'a small honest flaw, a before and after feeling. Never slogans, feature lists, brand-speak, superlatives or "game changer".',
    '- Proof: show the benefit working instead of claiming it: the texture on the skin, the mist catching the light, the lid ' +
      'clicking shut, the stain gone.',
    '- The call to action is soft and in their own words ("Link\'s right there if you want one"), the product in view.',
    '- Hooks that work: a confession, a strong opinion ("Stop buying…"), the result first, a question nobody answers, a ' +
      'point-of-view situation, a genuine reaction as the product works, the start of a short list.',
    '- Faceless UGC (hands_only): only hands and the product, the phone close to them. The hook is an action (a seal peeled, a ' +
      'cap twisted off, the first swatch), then the texture in macro and the product used on the back of a hand or on a real ' +
      'surface; natural nails and skin, one hand doing one thing at a time. No face anywhere; a voice-over or no speech.',
    'When the idea asks for another look (cinematic, luxury, polished, a studio product film, a film with no person, a colour ' +
      'palette), write that look with the same precision instead and say so in "style": the phone rules above then do not ' +
      'apply; everything else does.',
    '</ugc_craft>',
    '',
    '<film_craft>',
    'When the idea asks for a cinematic, luxury or studio film (product_film), it is a short story told in pictures, and the ' +
      'product is the hero:',
    '- An arc, not a list of angles: discovery, first touch, the feeling, where it takes them, the product alone at the end. A ' +
      'sensory moment may carry the person to a second place: the scent of a perfume takes her from a quiet boutique to a ' +
      'waterfall. Two places at most; name the place in every shot.',
    '- Feeling is shown in a close-up of the face: the eyes closing, an inhale, a small smile. The person acts; they never ' +
      'talk to the lens. Speech is at most one short voice-over line, or none.',
    '- The product\'s world around it: what it is made of or from, only when the idea or the label says so (halved coconuts ' +
      'and palm leaves around a coconut oil, citrus slices around a citrus scent), and a surface that suits it (wet stone, ' +
      'polished marble, dark glass, linen).',
    '- Motion that sells, one per shot, at real speed: a splash of water around the bottle, mist through a beam of light, ' +
      'droplets running down glass, a light sweep along the label, an orbit or push-in on the product. Slow motion only when ' +
      'the idea asks for it, and then in one shot at most.',
    '- Light like a commercial: a soft key with a rim light that outlines the product on a dark ground, or golden-hour and ' +
      'overcast daylight outdoors. Shallow depth of field, macro for textures.',
    '- An editorial, high-fashion look when the idea asks for one: a seamless studio backdrop, one hard key light that sculpts ' +
      'the face, a single bold styling detail, a still and confident pose held for the camera, the product worn or held like ' +
      'part of the outfit.',
    '- The end frame: the product alone, centred, its label facing the lens, still.',
    '</film_craft>',
    '',
    '<pace_and_sound>',
    'A proper ad has energy and a sound bed:',
    '- Pace: UGC is quick and lively, like a real creator\'s post: speech at a natural, brisk pace, every action at real speed, ' +
      'a new picture every two to four seconds. A film is confident, not slow: purposeful moves, one still beat at the end.',
    '- Music: choose a music bed that fits the ad and write it in "music": the genre, the tempo in BPM and the energy ("upbeat ' +
      'modern pop beat, about 110 BPM, bright and confident"; "dark minimal trap beat, about 90 BPM, confident"). Under speech ' +
      'it stays low so every word is clear. "music" is null only when the idea asks for no music or for ASMR sound.',
    '- No words on screen: captions, titles and a written call to action are added later in editing, because a video model ' +
      'writes text as gibberish. The speech and the pictures carry the message.',
    '</pace_and_sound>',
    '',
    '<what_renders_well>',
    'Seedance renders what is concrete and loses what is vague. These rules come from what it does with written shots:',
    '- One clear action per shot, two at most, written as what a camera sees: who does what, with which hand, where the ' +
      'product is in the frame. Order inside a shot with "then". Facts, not mood: "she tilts the bottle so the label catches ' +
      'the window light", never "she elegantly shows off the stunning bottle". Words that carry no picture (stunning, amazing, ' +
      'perfect, elegant, premium, high-quality, cinematic) make generic footage: leave them out.',
    '- Decide everything. One place per shot, one light, one hand, one move: never "or", "maybe" or "something like". A UGC ' +
      'ad stays in one place; a film may move once (see film_craft).',
    '- "camera" is one framing in full words (extreme close-up, close-up, medium close-up, medium shot or wide shot), the ' +
      'lens feel (phone front camera, phone rear camera close to the subject, or 35mm, 50mm, 85mm for a film look) and one ' +
      'movement (locked, push-in, pull-back, pan, tracking, or handheld with a slight sway). Small, continuous movement ' +
      'renders best.',
    '- Real-time speed: people, hands, the product, liquid and mist all move at natural, real-world speed. Never write slow ' +
      'motion, slow-mo or "slowly" unless the idea asks for it: the video model turns those words into an ad that drags.',
    '- Faces: a medium close-up or closer whenever the face matters (faces in wide shots turn waxy). While someone speaks: a ' +
      'medium close-up or a medium shot, never an extreme close-up (the lips stop matching the words).',
    '- The product, whenever it is on screen: large enough to read at phone size, its label or logo toward the lens, at chest ' +
      'height or near the lens, never tucked into a corner. Say how it is held ("pinched between thumb and two fingers, label ' +
      'out"): vague hands render badly. Call it by the same words every time.',
    '- Name the character in every shot they are in. A short shot opens with them already in position.',
    '- Never write that anyone holds, films with or puts down a phone or a camera, unless that is the product: the frame is ' +
      'the viewpoint. For a selfie shot, write that they look into the lens at arm\'s length.',
    '- Nothing to read on screen besides the product\'s own label: no captions, titles, signs or screens (written text comes ' +
      'out as gibberish). No mirrors and no other people unless the idea needs them (doubles and extra faces appear).',
    '- Light is a physical source with a direction and a colour ("soft window light from camera-left, warm"), said once in ' +
      '"style" and the same in every shot.',
    '- Sounds are concrete and tied to an action: the cap clicks, a spray hisses, a mug is set on wood. Never "ambient sound" ' +
      'or "background noise". Music is its own line ("music"), never one of a shot\'s sounds.',
    '- Write no round brackets anywhere: the video model reads text in round brackets as music.',
    '</what_renders_well>',
    '',
    '<speech>',
    `- Speech is in ${speech}, one language only, never mixed. The same person speaks in every shot, in the same voice ("voice" ` +
      'says what it sounds like).',
    '- Keep to each shot\'s word budget: the words must fit the seconds, and a line that is too long is cut. At most two short ' +
      'lines in a shot. A shot that shows only the product may have no speech, or one short voice-over line. The last line ' +
      'ends before the final second.',
    '- Feelings and everyday experiences are the creator\'s own and welcome. Never invent prices, discounts, ratings, ' +
      'statistics, awards or results the idea did not give, and never put speech or text on screen.',
    '</speech>',
    '',
    '<pictures>',
    '- The reference images are listed in the request, each with its tag (@Image1, @Image2…). Code writes the lines that say ' +
      'which picture is which, so never write a tag in your plan: call the product by its name and the character by theirs ' +
      '("the bottle", "Mia"). A tag in a shot ("the bottle from @Image4") tells the video model that shot holds a different ' +
      'object. Do not describe what an image looks like: the video model sees it. Use what you see in attached pictures to ' +
      'choose real actions (how it opens, how it is held), not to describe its looks.',
    '- If you cannot tell what kind of thing the product is (no picture is attached and the idea does not say), never guess ' +
      'one (a stick, a cream, a spray): call it by its name, and show it held, turned and looked at, never used in a way you ' +
      'made up.',
    '- Whenever a person is in a shot it is the character, the person in the character reference; a shot may show only the ' +
      'product (a close-up, for instance) with no person in it. If there is no character reference, write "look" from the ' +
      'description given, or an ordinary adult who fits the idea, and keep them identical in every shot. If the idea is a ' +
      'product film with no person, do not invent one.',
    '- If there is no product reference, describe the product in words from the idea. Never invent a logo, a brand name, text ' +
      'on the product, or an extra product. Several product pictures are photos of the one product from other sides.',
    '- A "location" reference is the setting: use its place and its light. Without one, choose a setting that fits the idea.',
    '</pictures>',
    '',
    '<safety>',
    'Adapt, never decline.',
    '- Every person in the video is an adult (18 or older). A character with no age given is an adult in their twenties or ' +
      'thirties. "Girl" and "lady" in an idea are everyday words for a young woman and "guy" for a young man: write them as ' +
      'adults. A boy, a kid, a baby, a son or a daughter, or anyone under 18, is a child: NEVER show a child. Write an adult ' +
      'instead (a parent, for instance), or leave the person out.',
    '- Nothing nude or sexual, nothing violent or hateful, no weapons. If an idea asks for any of these, leave that part out ' +
      'and write a safe version of the rest.',
    '- Never name or imitate a real person or celebrity. If an idea names one, write an invented character instead.',
    '- Never make medical, health, weight-loss or income claims or promises, and never say a product treats or cures ' +
      'anything. If the idea contains one, leave the claim out and show the product being used instead.',
    '- Products, brands and luxury items are ordinary: advertise what the idea names, as asked. Never decline over a brand, a ' +
      'price level, a look or a style.',
    '</safety>',
    '',
    '<quality_bar>',
    'Before you answer, check every shot and every line:',
    '- Could this shot be moved into an ad for another product unchanged? Then it is generic: tie it to this product, this ' +
      'person and this place.',
    '- Does every shot give the viewer one concrete thing to remember: a texture, an object, a gesture, a sound?',
    '- Does the first second stop the scroll with the sound off, and does the first line make them need the second?',
    '- Is the product clearly on screen by the end of the second shot, unless the format is a slow reveal?',
    '- If the request has a character, is their face seen clearly in the ad, unless the idea asked for no face?',
    '- Does everything move at real-time speed, with nothing written as slow motion unless the idea asked for it? Is there a music bed?',
    '- In hands_only, is there no face anywhere? In product_film, does the last shot show the product alone?',
    '- Would a real person say every line out loud, exactly like that? Is one benefit shown, not only said?',
    `- Exactly ${count} ${shotWord}, the slot times, the word budgets, no mood adjectives, no round brackets.`,
    '</quality_bar>',
    '',
    '<answer_format>',
    'Answer with ONE JSON object and nothing else: no markdown, no code fence, no commentary before or after. Its keys, in ' +
      'this order:',
    '- "format": the name of the format you chose.',
    '- "angle": one sentence: why this stops the scroll and why we believe this person (it is not shown in the video).',
    '- "hooks": the three hooks you considered, as an array of three strings; the first shot uses the best one.',
    '- "product": the advertised product in two or three words, or null if the idea has none.',
    '- "summary": two sentences: who, where, what happens, how it feels.',
    '- "setting": the one place: the room or spot, the time of day, three to five named objects, the light source.',
    '- "look": the person as the camera sees them (age, build, hair, skin, outfit), from the description given and ' +
      'completed where it is silent; null if nobody is in the video.',
    '- "voice": the speaker\'s voice in one line (age range, pitch, pace, energy), or null if nobody speaks.',
    '- "music": the music bed in one line (genre, tempo in BPM, energy), or null when the idea asks for none.',
    `- "shots": exactly ${count}, in order, each with "beat" (its name from the format), "start" and "end" (the slot's seconds), ` +
      '"camera", "action" (15 to 40 words: the one action, where the product is in the frame, how it is held), "performance" ' +
      '(face, eyes, gesture, energy in this shot; null in a shot with no person), "dialogue" (the words said in this shot, or ' +
      'null), "delivery" (how they are said, two to four words, or null) and "sfx" (the concrete sounds of this shot).',
    '- "style": the look, said once: the camera feel, the light (source, direction, colour), the colour palette, skin and ' +
      'material realism. By default phone footage; or the look the idea asks for.',
    '- "consistency": one sentence: what stays identical in every shot besides the person and the product (the place, the ' +
      'light, the objects).',
    '</answer_format>',
    '',
    '<examples>',
    'Two finished plans, for other products, lengths and formats than most requests: a talking UGC ad and a studio product ' +
      'film. They show the depth expected. Never reuse their words, objects or lines; your plan follows the cut, the formats ' +
      'and the language above.',
    '<example>',
    JSON.stringify(EXAMPLE_PLAN),
    '</example>',
    '<example>',
    JSON.stringify(EXAMPLE_FILM),
    '</example>',
    '</examples>',
  ].join('\n')
}

/**
 * What the person asked for, as the data the director works from. `attached` are the tags of the pictures the model is
 * shown (api/director-prompt.js writerPictures), so it knows which of the listed pictures it can see.
 */
export function userMessage(input, attached = []) {
  const data = {
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
  }
  if (attached.length) data.pictures_attached = attached
  return JSON.stringify(data)
}

/**
 * The pictures the writer is shown, of those the app listed with a file of its own: the first two product photos, the
 * character's main picture and the location, in that order (four at most). Shown so it writes what the product really is and
 * how it is really used — a bottle it cannot see was "the product" in every shot. Never sent to the video model from here.
 */
export function writerPictures(references) {
  const owned = (references || []).filter(r => r.assetId)
  return [
    ...owned.filter(r => r.role === 'product').slice(0, 2),
    ...owned.filter(r => r.role === 'character').slice(0, 1),
    ...owned.filter(r => r.role === 'location').slice(0, 1),
  ].slice(0, 4)
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

/**
 * "the bottle from @Image4" → "the bottle": a tag the model wrote into what a shot shows. Code writes which picture is which;
 * a tag in a shot tells the video model that shot holds another object (real runs, 26 November 2026: gpt-6.1-terra and
 * gpt-5.5 named a different product photo in every shot of one bottle). Only the phrase that points at a picture goes; a
 * sentence with none is returned as it was.
 */
const TAG_PHRASE = /\s*,?\s*\b(?:as )?(?:shown |seen )?(?:from|in|of|like)\s+@Image\d+\b/gi
export const withoutTagPhrases = text => String(text ?? '').replace(TAG_PHRASE, '')
const seen = (value, max) => withoutTagPhrases(sentence(value, max))
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
  const seen = [plan.summary, plan.setting, plan.look, ...plan.shots.flatMap(shot => [shot.visual, shot.performance])]
    .filter(Boolean).join('\n').replace(NOT_A_CHILD, ' ')
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
  // A shot's picture is its "action" (what the writer is asked for since 26 November 2026), or "visual" (before then).
  const pictureOf = shot => seen(shot.action, 700) || seen(shot.visual, 700)
  const kept = shots
    .filter(shot => shot && typeof shot === 'object' && pictureOf(shot))
    .slice(0, 10)
    .map(shot => ({
      label: (sentence(shot.beat, 28) || sentence(shot.label, 28)).toUpperCase() || 'SHOT',
      span: Math.max(0.5, Number(shot.end) - Number(shot.start)) || 1,
      camera: orNull(sentence(shot.camera, 140)),
      visual: pictureOf(shot),
      performance: orNull(seen(shot.performance, 240)),
      dialogue: orNull(sentence(shot.dialogue, 260).replace(/["“”]/g, '')),
      tone: orNull(sentence(shot.delivery, 60) || sentence(shot.tone, 60)),
      sfx: orNull(sentence(shot.sfx, 200)),
    }))
  if (!kept.length) throw new DirectorOutputError('The plan has no shots.')

  const format = typeof raw.format === 'string' && Object.hasOwn(FORMATS, raw.format.trim().toLowerCase())
    ? raw.format.trim().toLowerCase()
    : DEFAULT_FORMAT
  const plan = {
    format,
    product: orNull(sentence(raw.product, 60)),
    summary: seen(raw.summary, 600),
    setting: orNull(seen(raw.setting, 400)),
    look: orNull(seen(raw.look, 400)),
    voice: orNull(sentence(raw.voice, 200)),
    music: orNull(sentence(raw.music, 160)),
    style: sentence(raw.style, 500),
    consistency: sentence(raw.consistency, 400),
    // Timed first (the slots of this length when the count is right, else in proportion), then each line of speech is
    // fitted to the seconds its shot really got.
    shots: timed(kept, seconds).map(shot => ({
      ...shot,
      dialogue: shot.dialogue ? orNull(fitSpeech(shot.dialogue, speechCap(shot.end - shot.start))) : null,
    })),
  }
  const child = childInPlan(plan)
  if (child) return { refusal: `The plan shows a child ("${child}").`, child: true }
  return { plan }
}

/**
 * The shots' times. When the model wrote as many shots as the clip has slots, they get the slots exactly (the hook its three
 * seconds, whatever the model wrote); otherwise their own lengths are kept in proportion (`retime`).
 */
export function timed(shots, seconds) {
  const slots = slotsOf(seconds)
  if (shots.length !== slots.length || slots.reduce((sum, n) => sum + n, 0) !== seconds) return retime(shots, seconds)
  let at = 0
  return shots.map((shot, i) => {
    const { span: _span, ...rest } = shot
    const start = at
    at += slots[i]
    return { ...rest, start, end: at }
  })
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

/** A sentence ends with its own mark if it has one ("…, then she laughs!"), else with a full stop. */
const ended = text => {
  const t = String(text).trim()
  return /[.!?…]$/.test(t) ? t : `${t.replace(/[\s,;:]+$/, '')}.`
}

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
/** Whether an idea asks for slow motion: only then may the prompt hold any. */
export const SLOW_MOTION = /\bslow[- ]?mo(?:tion)?\b|\bslowed down\b/i

/**
 * Slow motion taken out of what the model wrote ("a slow-motion splash" → "a splash", "locked, slow motion" → "locked",
 * "bursts in slow motion" → "bursts"), for an idea that did not ask for it: the first real videos of the new brief came out
 * slow from end to end. A sentence with none is returned as it was.
 */
export function withoutSlowMotion(text) {
  const source = String(text ?? '')
  if (!/slow[- ]?mo/i.test(source)) return source
  return source
    .replace(/\s*,?\s*\bin slow[- ]?mo(?:tion)?\b/gi, '')
    .replace(/\s*,\s*slow[- ]?mo(?:tion)?\b/gi, '')
    .replace(/\bslow[- ]?mo(?:tion)?\s+/gi, '')
    .replace(/\bslow[- ]?mo(?:tion)?\b/gi, '')
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim()
}

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
  // Nobody talks to the lens in a hands-only clip or a film: what is said is a voice-over (lips with no face to move them,
  // or a face that should only feel, made Seedance put a talking head in).
  const faceless = FACELESS_FORMATS.includes(plan.format)
  const speaker = faceless && talks ? 'A voice-over' : speakerOf(input, person)
  const shape = SHAPES[input.aspect] ?? input.aspect
  const tongue = languageName(input)
  const article = /^(8|11|18)\b/.test(String(input.seconds)) ? 'An' : 'A'

  const references = referenceLines(input, plan.product)
  const cut = plan.shots.length === 1 ? 'one continuous shot' : `${plan.shots.length} shots joined by hard cuts`
  const music = plan.music ? ended(withoutRoundBrackets(plan.music)) : null
  const opening = music
    ? `${article} ${input.seconds}-second ${shape} ad, ${cut}. ${talks ? 'Speech, a music bed and natural sounds' : 'A music bed and natural sounds'}.`
    : `${article} ${input.seconds}-second ${shape} ad, ${cut}. ${talks ? 'Speech and natural sounds only' : 'Natural sounds only'}; no BGM.`
  // Unless the idea asks for slow motion, none reaches the video model, and the prompt says real time outright.
  const slowAsked = SLOW_MOTION.test(input.idea)
  const pace = text => (slowAsked ? text : withoutSlowMotion(text))

  // A person with no picture of them is drawn from words alone, so the words are said once, before the shots, and held:
  // left to each shot, the face and the outfit drifted. With a picture, the picture decides, and no words compete with it.
  const pictured = input.references.some(r => r.role === 'character' || r.role === 'character_extra')
  const look = person && !pictured && plan.look
    ? `${input.character.name ? `${input.character.name}, the main character: ` : 'The main character: '}${ended(withoutRoundBrackets(plan.look))} The same face, hair and outfit in every shot.`
    : null
  const setting = plan.setting ? `Setting: ${ended(withoutRoundBrackets(plan.setting))}` : null

  const shotBlocks = withPerformance => plan.shots.map((shot, i) => {
    const picture = [pace(shot.visual), withPerformance ? pace(shot.performance) : null]
      .filter(Boolean).map(text => ended(withoutRoundBrackets(text))).join(' ')
    const block = [
      `Shot ${i + 1} [${stamp(shot.start, shot.end)}]:${shot.camera ? ` ${capital(closed(cameraWords(withoutRoundBrackets(pace(shot.camera)))))}` : ''}`,
      picture,
    ]
    if (shot.dialogue) {
      const how = shot.tone ? `, ${toneWords(withoutRoundBrackets(shot.tone))}` : ''
      block.push(`${speaker} says${how}: {${tongue}: "${withoutRoundBrackets(shot.dialogue).replace(/[{}]/g, '')}"}`)
    }
    if (shot.sfx) block.push(`<${withoutRoundBrackets(shot.sfx).replace(/[<>]/g, '')}>`)
    return block.join('\n')
  })

  const style = withoutRoundBrackets(pace(plan.style)) || (person
    ? `Shot on a phone, ${shape}: the front camera at arm's length for talking shots, natural light from the room's own window, true-to-life colour, natural skin texture, subtle handheld movement. Authentic UGC, not a polished commercial.`
    : `${capital(shape)}, clean natural light, realistic materials and textures, a steady camera, the product in sharp focus.`)
  // What stays the same when the model said nothing: a film may move once, so it promises only the product.
  const sameThings = plan.format === 'product_film' ? 'The same product in every shot.' : 'The same product and the same place in every shot.'
  const who = speakerOf(input, person)
  const alike = !person
    ? sameThings
    : plan.format === 'hands_only'
      ? `The same hands, skin tone and sleeves in every shot. ${sameThings}`
      : `${who} looks identical in every shot: same face, same hair, same outfit. ${sameThings}`
  const closing = [
    `Style: ${style}`,
    `Consistency: ${withoutRoundBrackets(plan.consistency) || alike}`,
    ...(talks ? [`Voice: ${closed(withoutRoundBrackets(plan.voice) || fallbackVoice(input))} ${speaker} speaks only ${tongue}, in the same voice in every shot.`] : []),
    `Hard cuts between the shots, no transitions or effects.${slowAsked ? '' : ' Everything moves at real-time speed, no slow motion.'}${person ? ' Hands look natural, five fingers each, and move differently in every shot.' : ''}`,
    music
      ? `Music: ${music}${talks ? ' Kept low under the voice, so every word is clear.' : ''} No subtitles, no captions, no text overlays.`
      : `${talks ? '' : 'No dialogue. '}No BGM, no music, no score, no melody: only ${talks ? 'the voice, ' : ''}environmental sounds and action sounds. No subtitles, no captions, no text overlays.`,
    person && speaker !== 'A voice-over' && plan.format !== 'hands_only'
      ? `The clip ends on a still frame: in the last second ${speaker.startsWith('The ') ? `the ${speaker.slice(4)}` : speaker} holds the pose, mouth closed.`
      : 'The clip ends on a still frame.',
  ]

  const assemble = ({ summary, consistency, performance }) => [
    ...references, ...(references.length ? [''] : []),
    opening, ...(summary && plan.summary ? [withoutRoundBrackets(pace(plan.summary))] : []),
    ...(look ? [look] : []), ...(setting ? [setting] : []), '',
    ...shotBlocks(performance).flatMap(block => [block, '']),
    ...closing.filter(line => consistency || !line.startsWith('Consistency:')),
  ].join('\n')

  // Past the limit, what goes first is what the rest already carries: the summary, then the consistency line, then the
  // performance notes. The pictures, the place, the actions and the speech are what the video is made of.
  const levels = [
    { summary: true, consistency: true, performance: true },
    { summary: false, consistency: true, performance: true },
    { summary: false, consistency: false, performance: true },
    { summary: false, consistency: false, performance: false },
  ]
  let prompt = ''
  for (const level of levels) {
    prompt = assemble(level)
    if (countWords(prompt) <= PROMPT_MAX_WORDS) break
  }
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
