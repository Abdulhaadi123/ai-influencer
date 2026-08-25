/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Video prompt builder — shared by the web Content Studio and the mobile one.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the single largest piece of domain logic in the app: it turns the
 * studio's settings into the structured prompt sent to Kling. It used to live
 * inside the web page as a closure over a dozen pieces of component state,
 * which meant the mobile studio would have had to reimplement it.
 *
 * It is now a PURE function: everything it used to read from component state
 * arrives in the `settings` object. No DOM, no React.
 */

function inferAmbientSound(envKey, environment) {
  if (envKey && AMBIENT_SOUND[envKey]) return AMBIENT_SOUND[envKey]
  const e = (environment || envKey || '').toLowerCase()
  if (/restaurant|dining|bistro|brasserie|diner/.test(e)) return 'Ambient restaurant — low dining chatter, cutlery, warm bustle.'
  if (/beach|ocean|sea|shore|surf/.test(e)) return 'Ambient beach — waves, light breeze, distant seagulls.'
  if (/park|garden|nature|forest|woods/.test(e)) return 'Outdoor ambience — birds, light breeze, natural sounds.'
  if (/office|work|corporate|coworking/.test(e)) return 'Quiet office ambience — distant keyboard, low HVAC hum.'
  if (/car|vehicle|driving|road/.test(e)) return 'Ambient car interior — engine hum, road noise.'
  if (/bar|club|lounge|nightclub/.test(e)) return 'Ambient nightlife — low crowd murmur, distant music, gentle bass.'
  if (/pool|spa|resort|hotel/.test(e)) return 'Ambient resort — light water, gentle breeze, relaxed atmosphere.'
  if (/market|bazaar|store|shop/.test(e)) return 'Ambient market — light crowd, distant chatter.'
  if (/rooftop|terrace|balcony/.test(e)) return 'Outdoor rooftop ambience — light wind, distant city sounds.'
  if (/airport|station|transit/.test(e)) return 'Ambient transit sounds — light crowd, distant announcements.'
  return 'Natural ambient sound — location-appropriate background audio.'
}

export const VOICE_PRESETS = {
  female: [
    { id: 'f-21-american-bright',  label: '21-year-old American',   sub: 'Bright · fast · TikTok-native',     voice: '21-year-old American woman accent, bright and energetic, fast-paced and upbeat.' },
    { id: 'f-28-american-warm',    label: '28-year-old American',   sub: 'Warm · confident · grounded',       voice: '28-year-old American woman accent, warm and confident, clear and grounded.' },
    { id: 'f-35-american-calm',    label: '35-year-old American',   sub: 'Calm · measured · trustworthy',     voice: '35-year-old American woman accent, calm and measured, slow and soothing.' },
    { id: 'f-british-polished',    label: 'British — polished',     sub: 'Refined · elegant · clear',         voice: 'Polished British woman accent, refined and elegant, clear and measured.' },
    { id: 'f-british-playful',     label: 'British — playful',      sub: 'Bright · warm · charming',          voice: 'Playful British woman accent, bright and warm, light and charming.' },
    { id: 'f-deep-japanese',       label: 'Japanese — soft',        sub: 'Soft · gentle · precise',           voice: 'Soft Japanese woman accent, gentle and precise, calm and measured.' },
  ],
  male: [
    { id: 'm-22-american-energy',  label: '22-year-old American',   sub: 'Energetic · direct · natural',      voice: '22-year-old American man accent, energetic and direct, upbeat and natural.' },
    { id: 'm-30-american-deep',    label: '30-year-old American',   sub: 'Deep · confident · authoritative',  voice: '30-year-old American man accent, deep and confident, authoritative and measured.' },
    { id: 'm-38-american-warm',    label: '38-year-old American',   sub: 'Warm · relaxed · approachable',     voice: '38-year-old American man accent, warm and relaxed, approachable and conversational.' },
    { id: 'm-british-sharp',       label: 'British — sharp',        sub: 'Refined · precise · authoritative', voice: 'Sharp British man accent, refined and precise, clear and authoritative.' },
    { id: 'm-british-story',       label: 'British — storyteller',  sub: 'Warm · engaging · unhurried',       voice: 'Warm British man storytelling accent, engaging and unhurried, naturally charismatic.' },
  ],
}

function parseAdditionalNotes(notes, durationSecs) {
  if (!notes.trim()) return { actionBeats: [], directionNotes: '' }

  const sentences = notes.trim()
    .split(/(?<=[.!?])\s+|[\n]+/)
    .map(s => s.trim())
    .filter(Boolean)

  const actionBeats = []
  const directionLines = []

  const ACTION_VERBS = /\b(pick|picks up|hold|holds|turn|turns|spin|spins|lean|leans|look|looks at|walk|walks|sit|sits|stand|stands|laugh|laughs|smile|smiles|nod|nods|wave|waves|point|points|reach|reaches|touch|touches|grab|grabs|show|shows|open|opens|close|closes|tilt|tilts|adjust|adjusts|pull|pulls|lift|lifts|flip|flips|drop|drops|step|steps|crouch|crouches|glance|glances|wink|winks|pause|pauses|freeze|freezes|stop|stops)\b/i

  for (const s of sentences) {
    const isActionBeat = ACTION_VERBS.test(s) || /\b(she|he|they)\s+\w+/i.test(s) || /\bpause\b/i.test(s)

    if (isActionBeat) {
      // Determine position as a fraction 0–1 of the video/dialogue
      let fraction = 0.5 // default: middle of dialogue
      let ts = `0:${String(Math.round(durationSecs * 0.5)).padStart(2, '0')}`

      if (/\bat (the )?start\b|from the start|at the beginning|^first\b/i.test(s)) {
        fraction = 0; ts = '0:01'
      } else if (/\bat (the )?end\b|last|final|before (it )?cuts/i.test(s)) {
        fraction = 1; ts = `0:${String(Math.max(durationSecs - 2, 1)).padStart(2, '0')}`
      } else {
        const m = s.match(/at\s+(\d+)\s*s(?:ec(?:ond)?s?)?/i)
        if (m) {
          const sec = parseInt(m[1])
          fraction = Math.min(sec / durationSecs, 1)
          ts = `0:${String(sec).padStart(2, '0')}`
        }
      }

      let text = s
        .replace(/at (the )?(start|end|beginning)\b[,]?/gi, '')
        .replace(/from the start\b[,]?/gi, '')
        .replace(/at \d+\s*s(ec(ond)?s?)?\b[,]?/gi, '')
        .replace(/^(make sure|ensure|have her|have him|i want|please|note[:]?)\s+/i, '')
        .trim()
        .replace(/[.!?]+$/, '')

      if (!/^(she|he|they)\b/i.test(text)) text = `She ${text.charAt(0).toLowerCase()}${text.slice(1)}`
      text = text.charAt(0).toUpperCase() + text.slice(1)

      actionBeats.push({ text, timestamp: ts, fraction, fired: false })
    } else {
      directionLines.push(s.replace(/[.!?]+$/, '').trim())
    }
  }

  // Sort beats by fraction so they fire in chronological order
  actionBeats.sort((a, b) => a.fraction - b.fraction)

  return { actionBeats, directionNotes: directionLines.join('. ').trim() }
}

function annotateDialogue(rawText, productTag, durationSecs, isHandheld = false, wearMode = false, actionBeats = [], she = 'she', her = 'her', his = 'her') { // his = possessive ('her'/'his')
  if (!rawText.trim()) return ''

  // Split into clauses:
  // 1. On sentence endings (.  !  ?) followed by a space
  // 2. Then on comma-pivot breaks: ", but " / ", however " / ", though " / ", yet "
  const sentences = rawText.trim()
    .split(/(?<=[.!?])\s+/)
    .flatMap(s => s.split(/,\s+(?=(?:but|however|though|yet)\s)/i))
    .map(s => s.trim())
    .filter(Boolean)

  let microLeft = durationSecs <= 6 ? 1 : 2
  const useMicro = expr => { if (!microLeft) return ''; microLeft--; return expr }

  const prod = productTag || null
  const out = []

  // Worn-mode: rotate through natural interaction gestures so every 2nd sentence
  // has a physical beat with the product — keeps it visible without feeling staged.
  // All gestures are body-position-agnostic so they work for any wearable
  // (cap, bracelet, necklace, shirt, shoes, earrings, sunglasses, etc.)
  const She = she.charAt(0).toUpperCase() + she.slice(1)
  const Her = her.charAt(0).toUpperCase() + her.slice(1)
  const WORN_GESTURES = prod ? [
    `${She} touches ${prod} briefly — natural, not staged.`,
    `${Her} hand goes to ${prod} for a beat, then back to natural position.`,
    `${She} glances toward ${prod}, then back to lens — draws attention to it without words.`,
    `${She} adjusts ${prod} slightly — natural reflex, eyes stay on camera.`,
    `${She} angles ${his} body so ${prod} is clearly visible, then settles back.`,
  ] : []
  let wornGestureIdx = 0
  let wornGestureCounter = 0
  let wornGesturesUsed = 0
  const wornGestureMax = durationSecs <= 6 ? 1 : 2
  function maybeWornGesture() {
    if (!wearMode || !prod) return null
    if (wornGesturesUsed >= wornGestureMax) return null
    wornGestureCounter++
    if (wornGestureCounter % 3 !== 0) return null
    const g = WORN_GESTURES[wornGestureIdx % WORN_GESTURES.length]
    wornGestureIdx++
    wornGesturesUsed++
    return g
  }

  // Opening body state — already in pose, product worn or in hand as applicable
  if (isHandheld) {
    out.push(prod
      ? wearMode
        ? `@image_1 is self-filming — arm extended toward camera, ${prod} worn. ${she.charAt(0).toUpperCase()+she.slice(1)} is already walking. Camera bobs with ${his} steps from 0:00. One breath before ${she} speaks.`
        : `@image_1 is self-filming — arm extended toward camera, ${prod} in the other hand. ${she.charAt(0).toUpperCase()+she.slice(1)} is already walking. Camera bobs with ${his} steps from 0:00. One breath before ${she} speaks.`
      : `@image_1 is self-filming — arm extended toward camera, already walking. Camera bobs with ${his} steps from 0:00. One breath before ${she} speaks.`
    )
  } else {
    out.push(prod
      ? wearMode
        ? `@image_1 faces camera, ${prod} worn from 0:00. ${she.charAt(0).toUpperCase()+she.slice(1)} touches or adjusts ${prod} once early — natural reflex that draws attention to it. One breath before ${she} starts.`
        : `@image_1 faces camera, ${prod} in hand from 0:00. One breath before ${she} starts.`
      : `@image_1 faces camera. Eyes on lens. One breath.`
    )
  }

  // Fire "at start" beats before the first sentence
  for (const beat of actionBeats) {
    if (!beat.fired && beat.fraction === 0) {
      beat.fired = true
      out.push(`At ${beat.timestamp} — ${beat.text}.`)
    }
  }

  sentences.forEach((raw, i) => {
    const s = raw.trim()
    const l = s.toLowerCase()
    const isLast = i === sentences.length - 1
    const hasPivot = /^(but|however|though|yet)\s/i.test(l)
    const hasActually = /\bactually\b/.test(l)
    const hasEllipsis = s.includes('...')
    const endsExclaim = s.endsWith('!')
    const isCTA = isLast && /^(so if|if you|grab|go get|buy|check out|order|pick up|get yours)\b/i.test(l)
    const isNegative = /\b(not a fan|taste like|tastes like|99%|don'?t like|dislike|awful|terrible|cough syrup|worst|gross)\b/.test(l)

    // CTA — always last, lands light
    if (isCTA) {
      out.push(`"${s}" Lands easy — like a tip from a friend, not a pitch.`)
      return
    }

    // Pivot + ellipsis
    if (hasPivot && hasEllipsis) {
      wornGestureCounter++
      if (prod) out.push(wearMode ? `She touches ${prod} and angles so it's clearly visible to camera.` : `She tilts ${prod} toward camera.`)
      out.push(endsExclaim ? `"${s}" Energy up — genuine.` : `"${s}" [beat.]`)
      return
    }

    // Pure pivot ("but...", "however...", "actually...") without ellipsis
    if (hasPivot || (hasActually && !isNegative)) {
      wornGestureCounter++ // keep counter in sync
      if (prod) out.push(wearMode ? `She touches ${prod}, angles so it's visible. "${s}" [beat.]` : `She tilts ${prod} toward camera. "${s}" [beat.]`)
      else out.push(`She leans forward slightly. "${s}" [beat.]`)
      return
    }

    // Mid-sentence ellipsis without pivot: "this thing is... incredible"
    if (hasEllipsis) {
      const [before, after] = s.split(/\.\.\./)
      const g = maybeWornGesture()
      if (g) out.push(g)
      out.push(`"${before.trim()}..."`)
      out.push(`[micro-pause.]`)
      const afterTrimmed = after?.trim()
      if (afterTrimmed) out.push(/[!]$/.test(afterTrimmed) ? `"${afterTrimmed}" Energy up — genuine.` : `"${afterTrimmed}" [beat.]`)
      return
    }

    // First line — hook opener
    if (i === 0) {
      const m = useMicro(` Corners of ${his} mouth pull back — genuine, not performed.`)
      out.push(`"${s}" [beat.]${m}`)
      return
    }

    // Negative / dismissal line — slight honest reaction
    if (isNegative) {
      const m = useMicro(' Slight face — honest, not dramatic.')
      const g = maybeWornGesture()
      if (g) out.push(g)
      out.push(`"${s}"${m} [beat.]`)
      return
    }

    // Exclamation — energy up, genuine
    if (endsExclaim) {
      const g = maybeWornGesture()
      if (g) out.push(g)
      out.push(`"${s}" Energy up — genuine, not performed.`)
      return
    }

    // Default — statement with conversational beat
    const g = maybeWornGesture()
    if (g) out.push(g)
    out.push(`"${s}" [beat.]`)

    // Inject any action beats that fall at or before this sentence's position
    if (actionBeats.length) {
      const sentenceFraction = (i + 1) / sentences.length
      for (const beat of actionBeats) {
        if (!beat.fired && beat.fraction <= sentenceFraction) {
          beat.fired = true
          out.push(`At ${beat.timestamp} — ${beat.text}.`)
        }
      }
    }
  })

  // Fire any remaining beats (e.g. atEnd beats or no-dialogue case)
  for (const beat of actionBeats) {
    if (!beat.fired) {
      beat.fired = true
      out.push(`At ${beat.timestamp} — ${beat.text}.`)
    }
  }

  // Conversation ends naturally — no [beat.] hanging after the last spoken word
  if (out.length && out[out.length - 1].endsWith('[beat.]')) {
    out[out.length - 1] = out[out.length - 1].slice(0, -7).trimEnd()
  }

  return out.join(' ')
}

/**
 * @param {object} influencer  the influencer record
 * @param {object} settings    everything the studio form holds
 * @returns {string} the full structured video prompt
 */
export function buildVideoPrompt(influencer, settings) {
  const {
    productRef1 = null, productRef2 = null, productRef3 = null, productWorn = false,
    startFrameUrl = null, selectedWardrobe = null, selectedHome = null,
    // Defaults deliberately mirror the web studio's useState initialisers, so
    // an omitted setting produces the same prompt on both platforms.
    shotMode = 'oner', duration = 15, camera = 'Handheld',
    videoTimeOfDay = 'afternoon', environment = '', envKey = '', vibe = '',
    dialogue = '', additionalNotes = '',
    audioDataUrl = null, voicePreset = '', voiceCustom = '',
  } = settings || {}

  const name = influencer.name
  const phys = influencer.physicalDesc || `${name}, natural confident energy`
  const isMale = influencer.gender === 'Male'
  const she = isMale ? 'he' : 'she'
  const She = isMale ? 'He' : 'She'
  const her = isMale ? 'him' : 'her'
  const his = isMale ? 'his' : 'her'

  // Build ordered image tag map — influencer refs first, then products
  // @image_N is assigned in the order refs are passed to generateVideo
  const prodImgs = [
    productRef1 && { role: 'product1', url: productRef1 },
    productRef2 && { role: 'product2', url: productRef2 },
    productRef3 && { role: 'product3', url: productRef3 },
  ].filter(Boolean)
  const tagMap = {}
  if (startFrameUrl) {
    // Start frame mode: @image_1 = start frame (identity + outfit baked in), @image_2+ = products
    tagMap['identity'] = '@image_1'
    prodImgs.forEach((prod, i) => { tagMap[prod.role] = `@image_${i + 2}` })
  } else {
    const infImgs = [
      influencer.mainImage && { role: 'identity', url: influencer.mainImage },
      selectedWardrobe
        ? { role: 'wardrobe',  url: selectedWardrobe.image }
        : influencer.characterSheetImage && { role: 'charsheet', url: influencer.characterSheetImage },
      influencer.closeUpImage1 && { role: 'closeup1', url: influencer.closeUpImage1 },
      influencer.closeUpImage2 && { role: 'closeup2', url: influencer.closeUpImage2 },
    ].filter(Boolean)
    const homeImgEntry = selectedHome ? [{ role: 'home', url: selectedHome.image }] : []
    ;[...infImgs, ...homeImgEntry, ...prodImgs].forEach((img, i) => { tagMap[img.role] = `@image_${i + 1}` })
  }

  // Shot count — oner = always 1, multi = auto from duration
  const shotCount = shotMode === 'oner' ? 1 : duration <= 5 ? 1 : duration <= 8 ? 2 : duration <= 12 ? 3 : 4

  // Camera style → STYLE field
  const styleMap = {
    'Handheld':     'Self-filmed handheld. @image_1 holds the camera at arm\'s length, 24mm, walk-pace bob and drift throughout. Never fully static. NO shallow DOF, NO bokeh, NO blur, natural front-cam color.',
    'Tripod':       'Locked tripod, 28mm. Static frame, nothing moves except the subject. Everything in focus front to back. NO shallow DOF, NO bokeh, NO blur, clean natural color.',
    'Talking Head': 'Locked tripod, 50mm portrait lens. Medium shot — framed from mid-chest up. Subject is seated, hands visible resting on desk surface in foreground. Static frame, nothing moves except the subject. Even studio lighting, soft and controlled. Everything in focus. NO shallow DOF, NO bokeh, NO blur, clean neutral color.',
    'Wide':         '28mm, locked wide shot, full body visible in environment, natural light, everything in focus front to back. NO shallow DOF, NO bokeh, NO blur.',
    'Overhead':     'Overhead bird\'s-eye camera, locked, looking straight down at the subject. 35mm equivalent, everything in focus, clean and graphic. NO shallow DOF, NO bokeh, NO blur.',
  }
  const cameraMovement = { 'Handheld':'handheld moving','Tripod':'locked','Talking Head':'locked','Wide':'locked','Overhead':'locked' }
  const stylePreset = styleMap[camera] || styleMap['Handheld']
  const move = cameraMovement[camera] || 'locked'

  const isTalkingHead = camera === 'Talking Head'
  const isHandheld = camera === 'Handheld'
  const wearMode = !!(productRef1 && productWorn)

  // Environment — in start frame mode the scene is locked to the start frame, not the text field
  const todLabel = { morning: 'morning', afternoon: 'afternoon', 'golden hour': 'golden hour', night: 'night' }[videoTimeOfDay] || ''
  const todSuffix = todLabel ? `, ${todLabel}` : ''
  const envDesc = startFrameUrl
    ? 'Continue from start frame — environment and lighting match @image_1 exactly throughout.'
    : tagMap.home
      ? `${tagMap.home} for the location and environment setting.${environment ? ' ' + environment : ''}${todSuffix}`
      : `${environment || (isTalkingHead ? 'in a studio' : 'indoors')}${todSuffix}`

  // Mood arc
  const moodMap = {
    'Natural':   "Delivery is unhurried and conversational — pauses land where they would in real speech, never performed. Micro-expressions are small and honest: a slight mouth pull before a punchline, a brief brow soften on the reveal. Gestures are loose and incidental, not choreographed. Eye contact with the camera is easy, breaks naturally, comes back. Energy stays flat and warm across the whole clip.",
    'Energetic': `Delivery is fast and forward — ${she} pushes through lines with minimal pause, pace never drops. Eyebrows lift on emphasis words. Gestures are sharp and frequent: quick hand flicks, small head tilts that land on key beats. Body is slightly forward the whole time. Expression resets fast between lines — no lingering. Clip ends on full energy, nothing winds down.`,
    'Luxury':    `Delivery is slow and deliberate — every word has weight, pauses are long and intentional. Micro-expressions are subtle: a slow smirk rather than a smile, heavy-lidded confidence, no wide eyes. Gestures are minimal and controlled — small wrist movements, nothing above the shoulder. ${She} never rushes. Eye contact is held longer than comfortable, then released slowly.`,
    'Playful':   `Delivery has rhythm and bounce — slight sing-song cadence, small upticks at the ends of phrases. Quick genuine smiles that reach the eyes, eyebrow raises on key words. Light shoulder movement on emphasis. Pauses are short and teasing, like ${she}'s about to say something and makes you wait one beat. Gestures are small and spirited — pointing, light wrist flick.`,
    'Tutorial':  `Delivery is clear and even-paced — deliberate without being slow, every word lands cleanly. Direct sustained eye contact with the camera, nods on key points. Gestures are demonstrative: ${she} points at or tilts the product on relevant beats, uses open-palm gestures when explaining. Expression stays calm and assured throughout. No uptalk — every sentence lands flat and final.`,
    'Dramatic':  "Delivery is slow-building — early lines are quiet and measured, pace tightens toward the end. Strategic pauses that hold one beat longer than expected. Eyes stay on camera longer than normal, expression shifts are controlled and deliberate. Gestures are restrained — hands stay low, movement is minimal until the payoff line. The reveal lands with full stillness.",
    'Cozy':      `Delivery is soft and low-energy — ${she} sounds like ${she}'s talking to one person, not a camera. Slight smile throughout, never fades completely. Minimal gestures, hands stay relaxed. Pauses feel comfortable, not empty. Eye contact is warm and personal. Pace is slow enough that every word registers. Expression stays gentle from first frame to last.`,
    'Confident': "Delivery is even and controlled — no uptalk, no filler energy, every line lands flat and sure. Holds eye contact with the camera without excess blinking. Gestures are purposeful and limited — one clean move per beat, nothing nervous or decorative. Expression is neutral-warm: not performing happiness, just completely at ease. Pace stays consistent, never rushes the reveal.",
  }
  const moodArc = vibe ? (moodMap[vibe] || vibe) : 'Delivery is genuine and present throughout. Micro-expressions are honest and small. Gestures are natural and uncontrived.'

  // Color logic — keyed to chip selection (envKey) so free-form text still gets a grade
  const colorMap = {
    'Bedroom':'Warm soft palette, amber tones, clean skin highlight.',
    'Bathroom':'Neutral clean tones, slight coolness, face is brightest element.',
    'Kitchen':'Fresh neutral palette, clean whites, warm skin.',
    'Coffee Shop':'Warm caramel tones, soft and inviting.',
    'Mall / Store':'Bright clean palette, commercial whites, product pops.',
    'Street':'Golden-warm with cool sky fill, high-contrast.',
    'Gym':'High contrast, cool-neutral, energetic.',
    'Studio':'Clean neutral, controlled, product-forward.',
  }
  const colorLogic = envKey ? (colorMap[envKey] || 'Clean neutral, warm skin tones.') : 'Clean neutral, warm skin tones.'

  // Full dialogue — annotated with performance notation from the guide
  const fullDialogue = dialogue.trim()
  const prod1Tag = tagMap.product1 || null

  // Parse notes first so action beats can be woven into annotateDialogue
  const { actionBeats, directionNotes } = parseAdditionalNotes(additionalNotes, duration)

  const annotatedDialogue = annotateDialogue(fullDialogue, prod1Tag, duration, isHandheld, wearMode, actionBeats, she, her, his)
  // For multi-shot: distribute raw sentences across shots
  const dialogueLines = fullDialogue ? fullDialogue.split(/(?<=[.!?])\s+/).filter(s=>s.trim()) : []

  // Product logic rules (belt+suspenders reference alongside PRODUCT section)
  const productRules = []
  if (tagMap.product1) productRules.push(`${tagMap.product1} is always the same object — same color, label position, and size. Never substituted.${wearMode ? ` ${tagMap.product1} is WORN — never held. ${She} naturally interacts with it once or twice — a brief touch or glance — without overdoing it.` : ''}`)
  if (tagMap.product2) productRules.push(`${tagMap.product2} is always the same object — never substituted.`)
  if (tagMap.product3) productRules.push(`${tagMap.product3} is always the same object — never substituted.`)

  // PRODUCT section — dedicated block placed between WARDROBE and ENVIRONMENT
  const prodEntries = [
    tagMap.product1 && { tag: tagMap.product1, n: 1 },
    tagMap.product2 && { tag: tagMap.product2, n: 2 },
    tagMap.product3 && { tag: tagMap.product3, n: 3 },
  ].filter(Boolean)
  let productSection = ''
  if (prodEntries.length > 0) {
    const pLines = ['PRODUCT:']
    pLines.push('')
    prodEntries.forEach(({ tag, n }) => {
      pLines.push(`${tag} — product reference ${n}. Use as the exact source for this product's color, shape, label text and orientation, and proportions.`)
    })
    pLines.push('')
    const allProdTags = prodEntries.map(e => e.tag).join(' and ')
    pLines.push(`The product must appear identical in every frame — same label text and orientation, same colors, same proportions throughout. Never substituted, recolored, or modified. ${allProdTags} ${prodEntries.length > 1 ? 'contribute' : 'contributes'} ONLY the product — never the face, identity, wardrobe, environment, or color grade.`)
    if (wearMode) pLines.push(`Exception: ${tagMap.product1} is WORN — ${she} interacts with it naturally once or twice — a brief touch or glance — without overdoing it.`)
    productSection = pLines.join('\n')
  }

  // Build shots
  const shotDurs = shotCount === 1 ? [duration]
    : shotCount === 2 ? [2, duration - 2]
    : shotCount === 3 ? [2, Math.round((duration-2)/2), duration - 2 - Math.round((duration-2)/2)]
    : [2, 3, Math.floor((duration-5)/2), Math.ceil((duration-5)/2)]

  const framing = camera === 'Wide' ? 'WS' : camera === 'Overhead' ? 'overhead' : camera === 'Talking Head' ? 'MS' : 'MCU'
  const lens = camera === 'Handheld' ? '24mm' : camera === 'Wide' ? '28mm' : camera === 'Overhead' ? '35mm' : camera === 'Talking Head' ? '50mm' : '28mm'

  const shots = []
  let t = 0
  for (let i = 0; i < shotCount; i++) {
    const sd = shotDurs[i]
    const te = t + sd
    const ts = `0:${String(t).padStart(2,'0')} to 0:${String(te).padStart(2,'0')}`

    if (shotMode === 'oner') {
      const startPin = startFrameUrl ? `Video opens at 0:00 as @image_1 exactly. ` : ''
      const actionBody = fullDialogue
        ? annotatedDialogue
        : startFrameUrl ? '' : `@image_1 faces camera. Eyes on lens at 0:00.`
      const onerTail = fullDialogue ? ` Natural conversational gestures as ${she} speaks. End cleanly with the character holding a final pose, no talking or lip movement.` : ''
      shots.push(`ACTION:\n0:00 to 0:${String(duration).padStart(2,'0')} — ${framing}, ${lens}, ${move}. One continuous take.\n\n${startPin}${actionBody}${onerTail}`.trimEnd())
    } else if (i === 0) {
      const startPin = startFrameUrl ? `Video opens at 0:00 as @image_1 exactly. ` : ''
      const hookBody = dialogueLines[0] ? annotateDialogue(dialogueLines[0], prod1Tag, duration, isHandheld, wearMode, [], she, her, his) : (startFrameUrl ? '' : `@image_1 faces camera. Eyes on lens at 0:00.`)
      shots.push(`SHOT 1 — ${ts}, ${framing}, ${lens}, ${move}.\n${startPin}${hookBody}`.trimEnd())
    } else {
      const line = dialogueLines[i] || ''
      const gesture = prod1Tag && i === 1
        ? (wearMode ? `${she} touches ${prod1Tag} and angles toward camera to show it` : `${she} tilts ${prod1Tag} toward camera slightly`)
        : 'one hand lifts — palm-up, natural half-shrug'
      const lineStr = line ? `"${line.trim()}" [beat — eyes stay on camera.] ` : '[holds the moment.] '
      const closingTail = fullDialogue && i === shotCount - 1 ? ' End cleanly with the character holding a final pose, no talking or lip movement.' : ''
      const voiceTail = fullDialogue ? ' Voice unhurried. Tone genuine.' : ''
      shots.push(`SHOT ${i+1} — ${ts}, ${framing}, ${lens}, ${move}.\n@image_1 continues. ${gesture}. ${lineStr}${voiceTail}${closingTail}`.trimEnd())
    }
    t = te
  }

  // SUBJECT — identity + detail enhancement from close-up refs
  const genderHint = influencer.gender === 'Male' ? 'Male presenter. ' : influencer.gender === 'Female' ? 'Female presenter. ' : ''
  const subjectParts = startFrameUrl
    ? [`${genderHint}@image_1 is the start frame — begin the video from this exact frame. Identity (face, bone structure, skin tone, hair) is locked to @image_1 throughout. Match exactly.`]
    : [`${genderHint}@image_1 is the identity — face, bone structure, skin tone, hair. Match exactly.`]
  if (!startFrameUrl && tagMap.closeup1) subjectParts.push(`${tagMap.closeup1} for close-up facial detail — eye color, skin texture, pores.`)
  if (!startFrameUrl && tagMap.closeup2) subjectParts.push(`${tagMap.closeup2} for feature-level accuracy — lip shape, brow arch, skin tone.`)

  // WARDROBE — in start frame mode the outfit is baked into @image_1
  const wardrobeLine = startFrameUrl
    ? `Continue outfit from @image_1 exactly — same silhouette, fabric, color, styling throughout. Zero variation.`
    : tagMap.wardrobe
      ? `Match outfit from ${tagMap.wardrobe} exactly — silhouette, fabric, color, styling, zero variation. Outfit comes from ${tagMap.wardrobe} only, not @image_1.`
      : tagMap.charsheet
        ? `Match ${tagMap.charsheet} exactly — same outfit silhouette, fabric, color, styling throughout. Zero variation.`
        : ((influencer.wardrobeSlots||[]).filter(s=>s.name).map(s=>s.name).join(', ') || 'Casual, stylish, consistent throughout.')

  const allPresets = [...(VOICE_PRESETS.female || []), ...(VOICE_PRESETS.male || [])]
  const deliveryLine = audioDataUrl
    ? 'Lip-sync driven by @audio_1.'
    : voiceCustom.trim()
    ? `Voice: ${voiceCustom.trim()}`
    : voicePreset
    ? `Voice: ${allPresets.find(v => v.id === voicePreset)?.voice || ''}`
    : fullDialogue ? 'Natural voice, genuine and present.' : `No dialogue. ${inferAmbientSound(envKey, environment)}`

  // Append any unfired beats to their target shot
  const shotsWithBeats = shots.map((shot, i) => {
    let unfired
    if (shotMode === 'oner') {
      unfired = actionBeats.filter(b => !b.fired)
    } else {
      const shotStart = shotDurs.slice(0, i).reduce((a, b) => a + b, 0)
      const shotEnd = shotStart + shotDurs[i]
      unfired = actionBeats.filter(b => {
        const sec = b.fraction * duration
        return sec >= shotStart && sec < shotEnd && !b.fired
      })
    }
    unfired.forEach(b => { b.fired = true })
    if (!unfired.length) return shot
    const beatStr = shotMode === 'oner'
      ? unfired.map(b => `${b.text}.`).join(' ')
      : unfired.map(b => `At ${b.timestamp} — ${b.text}.`).join(' ')
    return shot + '\n' + beatStr
  })

  return `FORMAT: ${duration}s / ${shotCount === 1 ? '1 SHOT — continuous oner, ZERO CUTS' : `${shotCount} SHOTS`} / direct address

SUBJECT: ${subjectParts.join(' ')}

WARDROBE: ${wardrobeLine}
${productSection ? '\n' + productSection + '\n' : ''}
ENVIRONMENT: ${envDesc}

MOOD: ${moodArc}

COLOR LOGIC: ${colorLogic}

STYLE: ${stylePreset}

DELIVERY: ${deliveryLine}
${directionNotes ? `\nDIRECTION: ${directionNotes}` : ''}
LOGIC RULE: @image_1 face is fixed — same bone structure, eye color, skin tone, jawline, zero drift. Only one @image_1 in frame at any time.${shotMode==='oner' ? ' ZERO CUTS — single uninterrupted take 0:00 to ' + duration + 's. No jump cuts, no zoom, no camera switch, no temporal skip. @image_1 moves continuously — never freezes.' : ' Wardrobe identical across all shots.'}${tagMap.wardrobe ? ` Outfit matches ${tagMap.wardrobe} throughout — do not take outfit from @image_1.` : ''}${!isHandheld ? ' No phone or smartphone visible in frame at any time — no device in hand, on any surface, or in the background.' : ''} No music. No captions. No text overlays.${productRules.length ? ' ' + productRules.join(' ') : ''}

---

${shotsWithBeats.join('\n\n')}`
}
