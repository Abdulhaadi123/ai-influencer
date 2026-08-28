import { getApiUrl } from '../platform/apiUrl'

export function buildInfluencerSheetPrompt(inf) {
  const phys = inf.physicalDesc ? `The character: ${inf.physicalDesc}. ` : ''
  const style = inf.clothingStyle ? `Outfit: ${inf.clothingStyle}. ` : ''
  const backstory = inf.backstory?.trim()
  const ctx = backstory ? `Character background: ${backstory.slice(0, 300)}. Let this inform their physique, presence, and energy — e.g. a personal trainer should look visibly athletic and fit, a gamer may look relaxed and casual, a CEO projects confidence. ` : ''
  return `Professional full-body character turnaround sheet. Pure white background, no background elements whatsoever. Soft neutral studio lighting, perfectly flat and even across all four panels — no shadows, no color cast, no vignette.

${phys}${style}${ctx}

Single row of four equally sized full-body shots from head to toe, each with a small label in clean sans-serif capitals printed above the figure:
Panel 1 — "FRONT VIEW": character facing directly forward, arms relaxed at sides, feet together.
Panel 2 — "SIDE VIEW": character in perfect left profile, arms at sides.
Panel 3 — "BACK VIEW": character facing directly away, arms relaxed.
Panel 4 — "THREE-QUARTER VIEW": character at 45-degree angle facing forward-right.

Replicate every single physical detail identically across all four panels: exact facial structure and bone structure, unique facial features and natural asymmetries, precise skin tone, real pore texture, natural blemishes, freckles, moles, birthmarks, natural moisture and skin sheen, realistic catchlights in the eyes, exact iris color and detail, exact hair color and texture and styling. Zero beauty retouching — raw skin imperfections must be visible. Same outfit, same proportions, same scale in every panel.

Shot on Hasselblad X2D 100C, photorealistic, ultra-sharp micro detail, RAW photograph quality. Character design sheet, model sheet, orthographic turnaround reference.`
}

export function buildCharSheetPrompt(brand, category, productDesc = null, angles = null) {
  const subject = productDesc || (category ? `${brand} ${category}` : `${brand} product`)
  const angleSpec = angles
    ? `The 6 panels show: ${angles}.`
    : `Choose the 6 most informative and commercially relevant angles for this specific product — select the angles that would appear on a real product character sheet, such as front, back, sides, top, bottom, and key detail closeups, based on what is most useful for this product type.`

  return `Professional product character sheet on a pure white (#FFFFFF) background. The subject is a ${subject}. ${angleSpec} Create a single composite image with exactly 6 panels in a strict uniform 3-column by 2-row grid. All 6 panels are perfectly equal in size — no panel larger or smaller than another, no gaps, no overlapping, strict grid alignment. The product is visually identical across all panels — same exact colors, materials, textures, logos, design details, and proportions throughout. For any angle or surface not explicitly described, match exactly the colors, materials, and finish shown in the reference image — do not invent or assume any detail. All branding, logos, and text physically on the product are preserved and clearly visible. No annotation labels, no "Front" / "Back" / "Side" captions, no text overlays of any kind. Studio product photography: soft even lighting, sharp focus throughout, perfectly clean white background, professional commercial quality. 16:9 landscape format.`
}

export async function buildCharSheetPromptWithClaude(images, brand, category, apiKey) {
  // images is an array of data URLs
  const imageBlocks = (Array.isArray(images) ? images : [images]).map(dataUrl => {
    const [header, base64] = dataUrl.split(',')
    const mediaType = header.match(/:(.*?);/)?.[1] || 'image/jpeg'
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }
  })

  const imageCount = imageBlocks.length
  const res = await fetch(getApiUrl('/api/claude'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `You are a luxury product expert and photography director. You have deep knowledge of designer brands, product lines, and how they look from every angle. You study product images and use your training knowledge to produce detailed, accurate descriptions. Output JSON only — nothing else.`,
      messages: [{
        role: 'user',
        content: [
          ...imageBlocks,
          { type: 'text', text: `Brand: ${brand}${category ? `\nCategory: ${category}` : ''}

You have been given ${imageCount} image${imageCount > 1 ? 's' : ''} of this product from different angles. Study all of them and identify exactly what product this is. Use what you can see across all images AND your training knowledge to describe it accurately from every angle.

Output a JSON object with exactly two fields:

"productDesc" — a precise, complete description covering the entire product: exact colors on every surface, materials, all logos and text (front, back, sides, interior), construction details, hardware. Use your knowledge of this product line to fill in surfaces not visible in the image. Be specific and confident — no hedging words like "likely" or "typically". Write it as definitive fact.

"angles" — exactly 6 panel descriptions for a professional character sheet, each with specific visual details for that angle. Use your product knowledge to describe what is actually on each surface — the real back closure, real side panels, real sole or lining — not generic guesses. Example for a cap: "front view showing embroidered H logo on structured crown, left profile showing side panel seam and brim edge, right profile showing matching side panel, rear view showing metal Hermès clasp and tonal strap, top-down view showing crown stitching pattern, underside of brim showing contrast lining color and stitching"

Output only valid JSON. No explanation, no markdown.` },
        ],
      }],
    }),
  })

  if (!res.ok) throw new Error(`Claude analysis failed (${res.status})`)
  const data = await res.json()
  if (data.error) throw new Error(data.error.message)

  const text = data.content?.[0]?.text?.trim()
  if (!text) throw new Error('Claude returned empty response')

  // Try to extract JSON from anywhere in the response
  let json = null
  const attempts = [
    () => JSON.parse(text),
    () => JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()),
    () => { const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('no JSON object found') },
  ]
  for (const attempt of attempts) {
    try { json = attempt(); break } catch {}
  }

  if (!json) throw new Error('Claude response could not be parsed as JSON. Raw: ' + text.slice(0, 200))
  if (!json.productDesc) throw new Error('Claude JSON missing productDesc field')

  return buildCharSheetPrompt(brand, category, json.productDesc, json.angles || null)
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity reference sheets.
//
// These two lived only in the deleted web studio, so the mobile app had no way
// to produce a close-up or a feature sheet — the fields existed on every
// influencer and were always null. Recovered verbatim from the web
// implementation (commit 4559740) so both platforms would generate identical
// references, and placed in core because they are pure string builders.
// ─────────────────────────────────────────────────────────────────────────────

export function buildFeatureSheetPrompt(inf) {
  const phys = inf.physicalDesc ? `The subject: ${inf.physicalDesc}. ` : ''
  return `Beauty model feature reference sheet. ${phys}Pure white background throughout. Clinical reference card layout — like a casting or makeup artist reference sheet printed on white paper. Bold black uppercase sans-serif labels above each panel. Clear white gutters between every panel and white margins around the outside.

Layout — 4 rows stacked top to bottom:
Row 1 (full width): one wide panel labelled "EYE" — extreme macro close-up centered tightly on both irises. The irises fill the majority of the frame. Shows exact iris color, pattern, and detail. Lashes visible at edges but irises are the dominant subject.
Row 2 (full width): one wide panel labelled "BROW" — close-up from hairline to mid-nose showing exact brow shape, arch, thickness, hair direction, forehead skin.
Row 3 (two equal side-by-side panels):
  Left — labelled "LIP": close-up from nose base to chin showing exact lip shape, cupid's bow, natural lip color.
  Right — labelled "SKIN TEXTURE": macro close-up of cheek skin showing pores, freckles, natural skin detail, zero retouching.
Row 4 (two equal side-by-side panels):
  Left — labelled "HAIR TEXTURE": close-up of hair strands showing exact color, shine, texture, wave or curl pattern.
  Right — labelled "HANDS": close-up of hand showing nail shape, length, nail color or nail art, knuckle skin detail.

Replicate the reference person's exact features in every panel: precise skin tone, freckle placement, hair color, lip shape, brow arch. Zero beauty retouching — raw photographic detail. White space clearly visible between all panels.

Photorealistic RAW photograph quality, ultra-sharp macro detail in each panel. Shot on Hasselblad 100mm macro lens.`
}

export function buildCloseUpPrompt(inf) {
  const phys = inf.physicalDesc ? `The subject: ${inf.physicalDesc}. ` : ''
  return `Professional studio headshot. Subject facing directly forward, eyes looking straight into the camera lens. Framed from shoulders up — head, neck, and upper chest visible. Clean seamless pure white backdrop, soft gradient toward very light grey at edges, no texture, no cast shadows on background.

${phys}Soft diffused studio lighting: two large softboxes at 45-degree angles producing soft, even, shadow-free illumination across the face. Subtle catchlights visible in both eyes. No harsh under-nose or chin shadows. Skin tone reproduced accurately — natural pore texture, subtle imperfections visible, zero retouching.

Replicate every physical detail from the reference image exactly: facial bone structure, unique facial features and natural asymmetries, precise skin tone, freckles, moles, iris color and detail, eyebrow shape, lip shape, hair color, texture and natural fall. The subject must be unmistakably the same individual.

Subject standing straight, head completely level, facing dead-on into the camera — no tilt, no turn, no pose. Eyes looking directly into the lens. Neutral expression, mouth relaxed and closed. No modelling, no attitude, no special pose whatsoever. Identical to a casting reference or identity card photo.

Shot on Phase One IQ4 150MP, 85mm portrait lens, f/2.8, studio strobe. Photorealistic, ultra-sharp facial detail, RAW photograph quality. Studio identity reference portrait.`
}
