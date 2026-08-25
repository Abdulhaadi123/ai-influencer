/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Influencer creation prompts — shared by the web wizard and the mobile one.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the logic behind "select what to copy": which attributes the user
 * ticks decides what the prompt tells the model to preserve from the reference
 * image. It lived inside the web page, which meant the mobile wizard would have
 * had to duplicate it — and the two would have drifted apart. It is plain data
 * and string building with no DOM, so it belongs in core.
 */

/** The attribute checkboxes shown in the wizard's "what to copy" step. */
export const COPY_ATTRIBUTES = [
  { id: 'face',       label: 'Face & identity', desc: 'Facial structure & features' },
  { id: 'hair',       label: 'Hair',            desc: 'Style, colour, length' },
  { id: 'skin',       label: 'Skin tone',       desc: 'Complexion & texture' },
  { id: 'eyes',       label: 'Eyes',            desc: 'Colour & shape' },
  { id: 'build',      label: 'Body & build',    desc: 'Physique & proportions' },
  { id: 'outfit',     label: 'Outfit',          desc: 'Clothing & accessories' },
  { id: 'expression', label: 'Expression',      desc: 'Mood & emotion' },
  { id: 'background', label: 'Background',      desc: 'Setting & scene' },
]

/** How each attribute is phrased inside the generated prompt. */
export const ATTR_PHRASE = {
  face: 'the exact facial structure and features',
  hair: 'the hairstyle, colour and length',
  skin: 'the skin tone and texture',
  eyes: 'the eye colour and shape',
  build: 'the body type and build',
  outfit: 'the outfit, clothing and accessories',
  expression: 'the facial expression and mood',
  background: 'the background and setting',
}

const REALISM =
  'Photorealistic, natural lighting, sharp real detail. ' +
  'No beauty retouching, no stylization, no CGI or 3D-render look.'

/**
 * Build the three generation prompts for a new influencer.
 *
 * Two paths, which can combine:
 *  • Reference image → passed separately as the reference; the prompt states
 *    which attributes to preserve, and folds in any typed description.
 *  • Description only → straight text-to-image from what the user typed.
 *
 * @param {object} d  { gender, description, referenceImage, copyAttributes, copyNote }
 * @returns {string[]} exactly three prompts
 */
export function buildImagePrompts(d) {
  const gender = d.gender === 'Male' ? 'man' : d.gender === 'Female' ? 'woman' : 'person'
  const hasRef = !!d.referenceImage
  const desc = d.description?.trim()

  let base
  if (hasRef) {
    const selected = d.copyAttributes || []
    const keep = selected.map(id => ATTR_PHRASE[id]).filter(Boolean)
    const preserve = keep.length
      ? `Preserve exactly from the reference image: ${keep.join(', ')}.`
      : `Recreate this exact ${gender} from the reference image — unmistakably the same person.`
    const note = d.copyNote?.trim() ? ` Also keep: ${d.copyNote.trim()}.` : ''
    const descLine = desc ? ` Additional direction: ${desc}.` : ''
    base = `Ultra-realistic photograph of the ${gender} in the reference image. ${preserve}${note}${descLine} ${REALISM} True-to-reference identity.`
  } else {
    base = `Ultra-realistic photograph of a ${gender}. ${desc}. ${REALISM}`
  }

  // When expression AND background are both copied, the user wants the
  // reference reproduced closely — so don't add pose variation on top.
  const selected = d.copyAttributes || []
  const locked = hasRef && selected.includes('expression') && selected.includes('background')

  const variants = [
    'Natural relaxed pose, looking toward the camera.',
    'Soft three-quarter angle, natural expression.',
    'Candid natural posture.',
  ]
  return variants.map(v => (locked ? base : `${base} ${v}`))
}
