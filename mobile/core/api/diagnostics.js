/**
 * ─────────────────────────────────────────────────────────────────────────────
 * KIE integration diagnostics.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Verifies the whole KIE integration from inside the app WITHOUT spending
 * credits, so the setup can be checked on a real device before committing to a
 * paid generation.
 *
 * What it can prove for free:
 *   • the key is present and valid, and how many credits remain;
 *   • file upload works (this is what reference images and driving videos use);
 *   • each configured model id is one KIE actually accepts.
 *
 * The model check works because KIE answers a createTask with an EMPTY input in
 * two distinguishable ways:
 *   • 422 — "model name not supported"  → the id is wrong;
 *   • anything else (a field-validation error) → the model was accepted and
 *     only the input was rejected. No task is created, so nothing is charged.
 *
 * What it CANNOT prove: that a full generation succeeds. That needs a real job,
 * which costs credits — run one from the Create / Videos / Motion screens.
 */

import { kieFetch } from '../platform/kieTransport'
import { IMAGE_MODEL_ID, VIDEO_MODEL_KLING, MOTION_MODEL_KIE } from '../config/generation'

/** A 1x1 transparent PNG — the smallest thing that exercises the upload path. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const ok = (label, detail) => ({ label, status: 'ok', detail })
const bad = (label, detail) => ({ label, status: 'fail', detail })

async function checkCredits() {
  try {
    const res = await kieFetch('/api/v1/chat/credit')
    if (!res.ok) return bad('API key', `HTTP ${res.status} — key rejected`)
    const json = await res.json()
    if (json?.code !== 200) return bad('API key', json?.msg || 'rejected by KIE')
    return ok('API key', `valid · ${json.data} credits remaining`)
  } catch (e) {
    return bad('API key', e?.message ?? 'could not reach KIE')
  }
}

async function checkUpload() {
  try {
    const res = await kieFetch('/api/file-base64-upload', {
      method: 'POST',
      body: JSON.stringify({
        base64Data: TINY_PNG,
        uploadPath: 'images/base64',
        fileName: `diagnostic_${Date.now()}.png`,
      }),
    })
    if (!res.ok) return bad('File upload', `HTTP ${res.status}`)
    const json = await res.json()
    const url = json?.data?.downloadUrl || json?.downloadUrl
    return url
      ? ok('File upload', 'reference images and videos can be uploaded')
      : bad('File upload', json?.msg || 'no download URL returned')
  } catch (e) {
    return bad('File upload', e?.message ?? 'upload failed')
  }
}

/**
 * Confirms KIE recognises a model id. Sends a deliberately empty input so the
 * request is always rejected — no task is created and no credits are spent.
 */
async function checkModel(label, model) {
  try {
    const res = await kieFetch('/api/v1/jobs/createTask', {
      method: 'POST',
      body: JSON.stringify({ model, input: {} }),
    })
    const json = await res.json().catch(() => null)

    if (json?.code === 422) return bad(label, `KIE does not know "${model}"`)
    if (json?.code == null) return bad(label, `unexpected response (HTTP ${res.status})`)
    // Any non-422 code means the model resolved and only the input failed.
    return ok(label, model)
  } catch (e) {
    return bad(label, e?.message ?? 'check failed')
  }
}

/**
 * Run every free check.
 *
 * @param {(done:number, total:number)=>void} [onProgress]
 * @returns {Promise<{results: Array, passed: number, total: number}>}
 */
export async function runDiagnostics(onProgress) {
  const steps = [
    () => checkCredits(),
    () => checkUpload(),
    () => checkModel('Influencer image', IMAGE_MODEL_ID),
    () => checkModel('Brand promo video', VIDEO_MODEL_KLING),
    () => checkModel('Motion copy', MOTION_MODEL_KIE),
  ]

  const results = []
  for (let i = 0; i < steps.length; i++) {
    results.push(await steps[i]())
    onProgress?.(i + 1, steps.length)
  }

  return {
    results,
    passed: results.filter(r => r.status === 'ok').length,
    total: results.length,
  }
}
