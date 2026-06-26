import { getApiUrl } from './apiUrl'

// KIE.AI enforces a 3000-character prompt limit — trim with a small safety margin
const KIE_PROMPT_MAX = 2900
function capPrompt(p) {
  if (!p || p.length <= KIE_PROMPT_MAX) return p
  return p.slice(0, KIE_PROMPT_MAX - 3) + '...'
}

const KIE_VIDEO_PROMPT_MAX = 2450
function capVideoPrompt(p) {
  if (!p || p.length <= KIE_VIDEO_PROMPT_MAX) return p
  return p.slice(0, KIE_VIDEO_PROMPT_MAX - 3) + '...'
}

const PENDING_KEY = 'kie_pending_gens'
const PENDING_VIDEO_KEY = 'kie_pending_videos'
const PENDING_PHOTO_KEY = 'kie_pending_photos_v2'
const PHOTO_SESSION_KEY = 'kie_photo_gen_session'

// ── Media caching to avoid double uploading ────────────────────────
const MEDIA_CACHE_KEY = 'kie_media_cache'
const _mediaCache = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(MEDIA_CACHE_KEY) || '{}')
    const map = new Map()
    const now = Date.now()
    const expiry = 24 * 60 * 60 * 1000 // 24 hours
    let hasLegacy = false
    for (const [k, v] of Object.entries(raw)) {
      // Ignore legacy string values or expired entries
      if (v && typeof v === 'object' && v.url && (now - v.uploadedAt < expiry)) {
        map.set(k, v)
      } else {
        hasLegacy = true
      }
    }
    if (hasLegacy) {
      try { localStorage.setItem(MEDIA_CACHE_KEY, JSON.stringify(Object.fromEntries(map))) } catch {}
    }
    return map
  }
  catch { return new Map() }
})()

function _mediaCacheSave() {
  try { localStorage.setItem(MEDIA_CACHE_KEY, JSON.stringify(Object.fromEntries(_mediaCache))) }
  catch { /* cache in memory only */ }
}

function mediaFingerprint(dataUrl) {
  return `${dataUrl.length}:${dataUrl.slice(0, 48)}:${dataUrl.slice(-24)}`
}

// ── Pending generation helpers ──────────────────────────────────────
export function savePendingGen(influencerId, slot, jobIds) {
  const list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')
  const filtered = list.filter(j => !(j.influencerId === influencerId && j.slot === slot))
  filtered.push({ influencerId, slot, jobIds, startedAt: Date.now() })
  localStorage.setItem(PENDING_KEY, JSON.stringify(filtered))
}

export function clearPendingGen(influencerId, slot) {
  const list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')
  localStorage.setItem(PENDING_KEY, JSON.stringify(
    list.filter(j => !(j.influencerId === influencerId && j.slot === slot))
  ))
}

export function getPendingGens() {
  return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')
}

export function markPhotoGenSession() { try { sessionStorage.setItem(PHOTO_SESSION_KEY, '1') } catch {} }
export function hasPhotoGenSession()  { try { return !!sessionStorage.getItem(PHOTO_SESSION_KEY) } catch { return false } }

export function savePendingVideo(influencerId, jobIds, count) {
  const list = JSON.parse(localStorage.getItem(PENDING_VIDEO_KEY) || '[]')
  const next = list.filter(j => j.influencerId !== influencerId)
  next.push({ influencerId, jobIds, count, startedAt: Date.now() })
  localStorage.setItem(PENDING_VIDEO_KEY, JSON.stringify(next))
}

export function clearPendingVideo(influencerId) {
  const list = JSON.parse(localStorage.getItem(PENDING_VIDEO_KEY) || '[]')
  localStorage.setItem(PENDING_VIDEO_KEY, JSON.stringify(
    list.filter(j => j.influencerId !== influencerId)
  ))
}

export function getPendingVideo(influencerId) {
  const list = JSON.parse(localStorage.getItem(PENDING_VIDEO_KEY) || '[]')
  return list.find(j => j.influencerId === influencerId) || null
}

export function savePendingPhoto(influencerId, jobIds) {
  const list = JSON.parse(localStorage.getItem(PENDING_PHOTO_KEY) || '[]')
  const next = list.filter(j => j.influencerId !== influencerId)
  next.push({ influencerId, jobIds, startedAt: Date.now() })
  localStorage.setItem(PENDING_PHOTO_KEY, JSON.stringify(next))
}

export function clearPendingPhoto(influencerId) {
  const list = JSON.parse(localStorage.getItem(PENDING_PHOTO_KEY) || '[]')
  localStorage.setItem(PENDING_PHOTO_KEY, JSON.stringify(list.filter(j => j.influencerId !== influencerId)))
}

export function getPendingPhoto(influencerId) {
  const list = JSON.parse(localStorage.getItem(PENDING_PHOTO_KEY) || '[]')
  return list.find(j => j.influencerId === influencerId) || null
}

export const initSession = async () => {} // No MCP session to initialize

// ── Base64 Reference Image Upload ───────────────────────────────────
async function uploadRefImage(base64Data) {
  if (!base64Data) return null
  if (base64Data.startsWith('http')) return base64Data
  
  const fp = mediaFingerprint(base64Data)
  if (_mediaCache.has(fp)) {
    const cached = _mediaCache.get(fp)
    if (cached && cached.url && (Date.now() - cached.uploadedAt < 24 * 60 * 60 * 1000)) {
      return cached.url
    } else {
      _mediaCache.delete(fp)
      _mediaCacheSave()
    }
  }

  try {
    const res = await fetch(getApiUrl('/api/kie/api/file-base64-upload?__kiepath=/api/file-base64-upload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base64Data,
        uploadPath: 'images/base64',
        fileName: `ref_${Date.now()}.jpg`
      })
    })
    
    if (!res.ok) {
      console.error(`[KIE Upload] HTTP ${res.status} — proceeding without reference image`)
      return null
    }
    
    const json = await res.json()
    
    // API may return downloadUrl directly or nested under data
    const url = json.data?.downloadUrl || json.downloadUrl || null
    if (!url) {
      console.error('[KIE Upload] No downloadUrl in response:', JSON.stringify(json).slice(0, 200))
      return null
    }
    
    _mediaCache.set(fp, { url, uploadedAt: Date.now() })
    _mediaCacheSave()
    return url
  } catch (e) {
    console.error('[KIE Upload] Exception — proceeding without reference image:', e.message)
    return null
  }
}

// ── Base64 Audio Upload ──────────────────────────────────────────────
// Uploads an audio data URL to KIE's file API and returns the CDN URL.
async function uploadAudioFile(base64Data) {
  if (!base64Data) return null
  if (base64Data.startsWith('http')) return base64Data

  const fp = mediaFingerprint(base64Data)
  if (_mediaCache.has(fp)) {
    const cached = _mediaCache.get(fp)
    if (cached && cached.url && (Date.now() - cached.uploadedAt < 24 * 60 * 60 * 1000)) {
      console.log('[KIE Audio] cache hit — skipping upload')
      return cached.url
    } else {
      _mediaCache.delete(fp)
      _mediaCacheSave()
    }
  }

  try {
    // Derive extension from data URL header (data:audio/mpeg;base64,...)
    const mimeMatch = base64Data.match(/^data:(audio\/[^;]+);base64,/)
    const mime = mimeMatch?.[1] || 'audio/mpeg'
    const ext = mime.includes('wav') ? 'wav' : mime.includes('m4a') || mime.includes('mp4') ? 'm4a' : 'mp3'
    const fileName = `audio_${Date.now()}.${ext}`

    const res = await fetch(getApiUrl('/api/kie/api/file-base64-upload?__kiepath=/api/file-base64-upload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base64Data,
        uploadPath: 'audio/base64',
        fileName
      })
    })

    if (!res.ok) {
      console.error(`[KIE Audio Upload] HTTP ${res.status} — proceeding without audio`)
      return null
    }

    const json = await res.json()
    const url = json.data?.downloadUrl || json.downloadUrl || null
    if (!url) {
      console.error('[KIE Audio Upload] No downloadUrl:', JSON.stringify(json).slice(0, 200))
      return null
    }

    console.log('[KIE Audio Upload] success:', url.slice(0, 80))
    _mediaCache.set(fp, { url, uploadedAt: Date.now() })
    _mediaCacheSave()
    return url
  } catch (e) {
    console.error('[KIE Audio Upload] Exception — proceeding without audio:', e.message)
    return null
  }
}

// ── KIE.AI status helpers ─────────────────────────────────────────────
// API returns status as either a string ("success","fail","pending") or
// a legacy numeric code (1=done, 2=fail, 3=fail). Handle both.
function kieIsSuccess(status) {
  return status === 1 || status === 'success'
}
function kieIsFailed(status) {
  return status === 2 || status === 3 || status === 'fail' || status === 'failed'
}
// Result URL — KIE.AI uses different field names depending on the model version.
// Try every known variant so we don't miss any.
function kieResultUrl(data) {
  return data?.resultImageUrl          // most common
    || data?.resultUrl                 // some models
    || data?.response?.resultImageUrl  // nested form
    || data?.response?.resultUrl       // nested form alt
    || data?.images?.[0]               // array form
    || data?.output?.resultImageUrl    // output wrapper
    || data?.output?.url               // output url
    || null
}

// ── Polling functions ──────────────────────────────────────────────
export async function pollAllJobs(jobIds, total, onProgress, _staleTolerance = 8, isCancelled = null, onPartialResults = null) {
  const pending = new Set(jobIds)
  const urls = []
  
  for (let round = 0; round < 60 && pending.size > 0 && urls.length < total; round++) {
    if (isCancelled?.()) throw new Error('CANCELLED')
    if (round > 0) await new Promise(r => setTimeout(r, 3000))
    if (isCancelled?.()) throw new Error('CANCELLED')
    
    for (const jobId of [...pending]) {
      if (isCancelled?.()) throw new Error('CANCELLED')
      try {
        const res = await fetch(getApiUrl(`/api/kie/api/v1/flux/kontext/record-info?__kiepath=/api/v1/flux/kontext/record-info&taskId=${jobId}`))
        if (!res.ok) continue
        
        const json = await res.json()
        if (json.code !== 200) continue
        
        const status = json.data?.status ?? json.data?.successFlag
        const resultUrl = kieResultUrl(json.data)
        if (round === 0 || status !== 'pending') {
          console.log(`[KIE Poll] round=${round} jobId=${jobId.slice(-8)} status=${status} hasUrl=${!!resultUrl}`)
          // When success but no URL found — dump the full data so we know what field to use
          if (kieIsSuccess(status) && !resultUrl) {
            console.error('[KIE Poll] SUCCESS but no URL found! Full data:', JSON.stringify(json.data).slice(0, 500))
          }
        }
        
        if (kieIsSuccess(status) && resultUrl) {
          pending.delete(jobId)
          if (!urls.includes(resultUrl)) {
            urls.push(resultUrl)
            onProgress?.(Math.min(22 + (urls.length / total) * 73, 95))
            onPartialResults?.(urls.slice(0, total))
          }
        } else if (kieIsFailed(status)) {
          pending.delete(jobId)
          console.warn(`[KIE Poll] Job ${jobId} failed with status: ${status}`)
        }
      } catch (e) {
        if (e.message === 'CANCELLED') throw e
        console.warn(`[KIE Poll] Error for job ${jobId}:`, e.message)
      }
    }
  }
  
  if (urls.length > 0) {
    onProgress?.(100)
    return urls.slice(0, total)
  }
  if (jobIds.length === 0) throw new Error('No job IDs to poll')
  console.error('[KIE Poll] Timed out. Last known status check failed to detect completion.')
  throw new Error('Image generation timed out')
}

async function pollVideoJobs(launched, total, onProgress, onPartialResults, isCancelled) {
  const pending = new Set(launched.map(l => l.taskId))
  const urls = []
  
  for (let round = 0; round < 270 && pending.size > 0 && urls.length < total; round++) {
    if (isCancelled?.()) throw new Error('CANCELLED')
    if (round > 0) await new Promise(r => setTimeout(r, 2000))
    if (isCancelled?.()) throw new Error('CANCELLED')
    
    for (const job of launched) {
      const jobId = job.taskId
      if (!pending.has(jobId)) continue
      
      try {
        if (job.isVeo) {
          const res = await fetch(getApiUrl(`/api/kie/api/v1/veo/record-info?__kiepath=/api/v1/veo/record-info&taskId=${jobId}`))
          if (!res.ok) continue
          const json = await res.json()
          if (json.code !== 200) continue
          
          const status = json.data?.status ?? json.data?.successFlag
          const resultUrl = json.data?.resultUrl
          
          if (status === 1 && resultUrl) {
            pending.delete(jobId)
            if (!urls.includes(resultUrl)) {
              urls.push(resultUrl)
              onProgress?.(Math.min(35 + (urls.length / total) * 60, 95))
              onPartialResults?.(urls.slice(0, total))
            }
          } else if (status === 2 || status === 3) {
            pending.delete(jobId)
            console.warn(`Veo video job ${jobId} failed`)
          }
        } else {
          const res = await fetch(getApiUrl(`/api/kie/api/v1/jobs/recordInfo?__kiepath=/api/v1/jobs/recordInfo&taskId=${jobId}`))
          if (!res.ok) continue
          const json = await res.json()
          if (json.code !== 200) continue
          
          const state = json.data?.state
          const resultJsonStr = json.data?.resultJson
          
          if (state === 'success' && resultJsonStr) {
            const resultObj = JSON.parse(resultJsonStr)
            const resultUrl = resultObj.resultUrls?.[0]
            if (resultUrl) {
              pending.delete(jobId)
              if (!urls.includes(resultUrl)) {
                urls.push(resultUrl)
                onProgress?.(Math.min(35 + (urls.length / total) * 60, 95))
                onPartialResults?.(urls.slice(0, total))
              }
            }
          } else if (state === 'fail') {
            pending.delete(jobId)
            console.warn(`Kling video job ${jobId} failed: ${json.data?.failMsg || ''}`)
          }
        }
      } catch (e) {
        if (e.message === 'CANCELLED') throw e
        console.warn(`Video poll error for job ${jobId}:`, e.message)
      }
    }
  }
  
  if (urls.length > 0) {
    onProgress?.(100)
    return { urls: urls.slice(0, total), shareUrls: [] }
  }
  throw new Error('Video generation failed')
}

export async function resumeVideoJob(jobIds, count, onProgress, onPartialResults, isCancelled) {
  const launched = jobIds.map(id => ({
    taskId: id,
    isVeo: id.startsWith('veo')
  }))
  return pollVideoJobs(launched, count, onProgress, onPartialResults, isCancelled)
}

// ── Public Image Generation APIs ────────────────────────────────────
export async function generateSingleImage({ prompt, aspectRatio = '16:9', resolution = '4k', referenceImage = null, outfitImage = null, onProgress, pendingKey = null, onJobIds = null, isCancelled = null }) {
  onProgress?.(5)
  const faceUrl = referenceImage ? await uploadRefImage(referenceImage) : null
  onProgress?.(15)
  const outfitUrl = outfitImage ? await uploadRefImage(outfitImage) : null
  onProgress?.(25)
  
  const body = {
    prompt: capPrompt(prompt),
    aspectRatio: aspectRatio,
    model: 'flux-kontext-pro'
  }
  if (faceUrl) {
    body.inputImage = faceUrl
  } else if (outfitUrl) {
    body.inputImage = outfitUrl
  }
  
  const res = await fetch(getApiUrl('/api/kie/api/v1/flux/kontext/generate?__kiepath=/api/v1/flux/kontext/generate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  
  if (!res.ok) throw new Error(`Flux generate failed: status ${res.status}`)
  const json = await res.json()
  if (json.code !== 200 || !json.data?.taskId) throw new Error(json.msg || 'Failed to start Flux generation')
  
  const taskId = json.data.taskId
  const jobIds = [taskId]
  onJobIds?.(jobIds)
  
  if (pendingKey) savePendingGen(pendingKey.influencerId, pendingKey.slot, jobIds)
  
  try {
    const urls = await pollAllJobs(jobIds, 1, onProgress, 16, isCancelled)
    onProgress?.(100)
    return urls[0] ?? null
  } finally {
    if (pendingKey) clearPendingGen(pendingKey.influencerId, pendingKey.slot)
  }
}

export async function generateThreeImages({ prompts, aspectRatio = '9:16', model = 'gpt_image_2', faceRef = null, styleRef = null, physicalDesc = '', faceRefNote = '', styleRefNote = '', onProgress, onPartialResults }) {
  onProgress?.(5)
  const faceUrl = faceRef ? await uploadRefImage(faceRef) : null
  console.log('[KIE] faceUrl:', faceUrl ? 'uploaded ✓' : 'none')
  onProgress?.(12)
  const styleUrl = styleRef ? await uploadRefImage(styleRef) : null
  console.log('[KIE] styleUrl:', styleUrl ? 'uploaded ✓' : 'none')
  onProgress?.(20)
  
  const launchPromises = prompts.map(async (prompt, i) => {
    const body = {
      prompt: capPrompt(prompt),
      aspectRatio: aspectRatio,
      model: 'flux-kontext-pro'
    }
    if (faceUrl) {
      body.inputImage = faceUrl
    } else if (styleUrl) {
      body.inputImage = styleUrl
    }
    
    console.log(`[KIE] Firing generate request #${i + 1}, prompt length: ${body.prompt.length}, hasInputImage: ${!!body.inputImage}`)
    const res = await fetch(getApiUrl('/api/kie/api/v1/flux/kontext/generate?__kiepath=/api/v1/flux/kontext/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    
    if (!res.ok) throw new Error(`Flux generate failed: status ${res.status}`)
    const json = await res.json()
    console.log(`[KIE] Generate response #${i + 1}:`, json.code, json.data?.taskId || json.msg)
    if (json.code !== 200 || !json.data?.taskId) throw new Error(json.msg || 'Failed to start Flux generation')
    return json.data.taskId
  })
  
  const jobIds = await Promise.all(launchPromises)
  console.log('[KIE] All taskIds launched:', jobIds)
  onProgress?.(30)
  
  const urls = await pollAllJobs(jobIds, prompts.length, onProgress, 16, null, onPartialResults)
  onProgress?.(100)
  return urls.slice(0, prompts.length)
}

export async function generateNImages({ prompt, count = 1, aspectRatio = '9:16', resolution = '4k', referenceImage = null, outfitImage = null, closeUpImage1 = null, closeUpImage2 = null, propImages = [], onProgress, onResult, isCancelled, pendingKey = null }) {
  onProgress?.(5)
  const faceUrl = referenceImage ? await uploadRefImage(referenceImage) : null
  const outfitUrl = outfitImage ? await uploadRefImage(outfitImage) : null
  onProgress?.(18)
  
  const prompts = Array.isArray(prompt) ? prompt : Array.from({ length: count }, () => prompt)
  
  const launchPromises = prompts.map(async (p) => {
    const body = {
      prompt: capPrompt(p),
      aspectRatio: aspectRatio,
      model: 'flux-kontext-pro'
    }
    if (faceUrl) {
      body.inputImage = faceUrl
    } else if (outfitUrl) {
      body.inputImage = outfitUrl
    }
    
    const res = await fetch(getApiUrl('/api/kie/api/v1/flux/kontext/generate?__kiepath=/api/v1/flux/kontext/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    
    if (!res.ok) throw new Error(`Flux generate failed: status ${res.status}`)
    const json = await res.json()
    if (json.code !== 200 || !json.data?.taskId) throw new Error(json.msg || 'Failed to start generation')
    return json.data.taskId
  })
  
  const jobIds = await Promise.all(launchPromises)
  onProgress?.(25)
  
  if (pendingKey && jobIds.length) {
    markPhotoGenSession()
    savePendingPhoto(pendingKey, jobIds)
  }
  
  const pending = new Set(jobIds)
  let deliveredCount = 0
  
  for (let round = 0; round < 60 && pending.size > 0 && deliveredCount < prompts.length; round++) {
    if (isCancelled?.()) throw new Error('CANCELLED')
    if (round > 0) await new Promise(r => setTimeout(r, 3000))
    if (isCancelled?.()) throw new Error('CANCELLED')
    
    for (const jobId of [...pending]) {
      if (isCancelled?.()) throw new Error('CANCELLED')
      try {
        const res = await fetch(getApiUrl(`/api/kie/api/v1/flux/kontext/record-info?__kiepath=/api/v1/flux/kontext/record-info&taskId=${jobId}`))
        if (!res.ok) continue
        
        const json = await res.json()
        if (json.code !== 200) continue
        
        const status = json.data?.status ?? json.data?.successFlag
        const resultUrl = kieResultUrl(json.data)
        
        if (kieIsSuccess(status) && resultUrl) {
          pending.delete(jobId)
          if (deliveredCount < prompts.length) {
            deliveredCount++
            onResult?.(resultUrl)
            onProgress?.(Math.min(25 + (deliveredCount / prompts.length) * 70, 95))
          }
        } else if (kieIsFailed(status)) {
          pending.delete(jobId)
          console.warn(`Job ${jobId} failed with status: ${status}`)
        }
      } catch (e) {
        if (e.message === 'CANCELLED') throw e
        console.warn(`Poll error for job ${jobId}:`, e.message)
      }
    }
  }
  
  if (deliveredCount > 0) {
    onProgress?.(100)
    return
  }
  throw new Error('Generation timed out')
}

// ── Public Video Generation API ─────────────────────────────────────
export async function generateVideo({ prompt, aspectRatio = '9:16', duration = 8, count = 1, referenceImages = [], audioRef = null, hasVoice = false, startFrameUrl = null, model = 'kling-3.0/video', resolution = '1080p', onProgress, onPartialResults, isCancelled, pendingKey = null }) {
  onProgress?.(5)
  const imageUrls = []
  if (referenceImages && referenceImages.length) {
    const urls = await Promise.all(referenceImages.filter(Boolean).map(img => uploadRefImage(img)))
    imageUrls.push(...urls.filter(Boolean))
  }
  onProgress?.(20)

  // Upload audio file if provided (for Kling lip-sync)
  let audioUrl = null
  if (audioRef) {
    console.log('[KIE Video] Uploading audio for lip-sync...')
    audioUrl = await uploadAudioFile(audioRef)
    if (audioUrl) console.log('[KIE Video] Audio ready:', audioUrl.slice(0, 80))
    else console.warn('[KIE Video] Audio upload failed — video will be silent')
  }
  onProgress?.(25)
  
  const isVeo = model.toLowerCase().includes('veo')
  if (!isVeo && imageUrls.length > 2) {
    console.warn(`[KIE Video] Kling only supports at most 2 image_urls, slicing from ${imageUrls.length} to 2.`)
    imageUrls.splice(2)
  }
  const jobIds = []
  
  const launchPromises = Array.from({ length: count }, async (_, i) => {
    const promptSuffix = i === 0 ? '' : '​'.repeat(i)
    let finalPrompt = prompt + promptSuffix
    if (!isVeo) {
      finalPrompt = finalPrompt
        .replace(/@image_1/g, 'the presenter')
        .replace(/@image_2/g, 'the wardrobe')
        .replace(/@image_3/g, 'the face details')
        .replace(/@image_4/g, 'the features')
        .replace(/@image_[5-8]/g, 'the product')
        .replace(/@audio_1/g, 'the audio')
        .replace(/@/g, '');
    }
    finalPrompt = capVideoPrompt(finalPrompt)
    
    if (isVeo) {
      const body = {
        prompt: finalPrompt,
        aspect_ratio: aspectRatio,
        model: 'veo3_fast',
        imageUrls: imageUrls
      }
      const res = await fetch(getApiUrl('/api/kie/api/v1/veo/generate?__kiepath=/api/v1/veo/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!res.ok) throw new Error(`Veo generate failed: status ${res.status}`)
      const json = await res.json()
      if (json.code !== 200 || !json.data?.taskId) throw new Error(json.msg || 'Failed to start Veo video')
      return { taskId: json.data.taskId, isVeo: true }
    } else {
      const klingInput = {
        prompt: finalPrompt,
        aspect_ratio: aspectRatio,
        duration: duration,
        image_urls: imageUrls,
        mode: 'std',
        multi_shots: false,
        // sound: true when user uploaded audio (lip-sync) OR selected a voice preset/custom (Kling AI voice)
        sound: !!(audioUrl || hasVoice),
      }
      // If an audio URL was uploaded, attach it for lip-sync / audio generation
      if (audioUrl) {
        klingInput.audio_url = audioUrl
        console.log('[KIE Video] Audio attached for lip-sync:', audioUrl.slice(0, 80))
      }
      const body = {
        model: 'kling-3.0/video',
        input: klingInput
      }
      const res = await fetch(getApiUrl('/api/kie/api/v1/jobs/createTask?__kiepath=/api/v1/jobs/createTask'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!res.ok) throw new Error(`Kling generate failed: status ${res.status}`)
      const json = await res.json()
      if (json.code !== 200 || !json.data?.taskId) throw new Error(json.msg || 'Failed to start Kling video')
      return { taskId: json.data.taskId, isVeo: false }
    }
  })
  
  const launched = await Promise.all(launchPromises)
  jobIds.push(...launched.map(l => l.taskId))
  onProgress?.(30)
  
  if (pendingKey) savePendingVideo(pendingKey, jobIds, count)
  
  try {
    const result = await pollVideoJobs(launched, count, onProgress, onPartialResults, isCancelled)
    onProgress?.(100)
    if (pendingKey) clearPendingVideo(pendingKey)
    return result
  } catch (e) {
    if (pendingKey && e.message !== 'CANCELLED') clearPendingVideo(pendingKey)
    throw e
  }
}

// ── Pose Previews Generation ────────────────────────────────────────
const POSE_PREVIEW_DESCS_STANDING = {
  plandid:         'Body angled 25–30 degrees to the camera, weight shifted to back leg, eyes glancing slightly off to the side — relaxed and candid, caught half a second before noticing the camera.',
  candid:          'Mid-laugh at the apex — eyes lit up with genuine joy, head tilted slightly back, one hand raised naturally toward the mouth or chest, body animated and relaxed.',
  'cute-posed':    'Three-quarter turn toward camera, soft warm smile, one hand gently raised near the face or lightly touching the hair, shoulders relaxed and easy, chin slightly tilted down — approachable and poised.',
  walking:         'Mid-stride, weight naturally transferring from one foot to the other, arms swinging relaxed, hair slightly lifted from movement, gaze forward with calm confidence.',
  'mid-turn':      'Body turned 45 degrees away from camera, head turning back over the shoulder with a soft beginning smile, hair sweeping slightly from the turn — caught in the middle of the motion.',
  front:           'Body and head squared directly to the lens, weight shifted onto one hip with the opposite knee slightly bent, arms relaxed at sides, confident direct gaze straight into the camera.',
  'hip-pop':       'Standing, weight fully on one straight leg, the other knee bent causing the hip to drop on that side. One hand on the lower hip, fingers forward, elbow back. A visible gap of air between both arms and the torso. Full body head to toe.',
  triangle:        'Standing at 45 degrees to camera. Near arm raised to hip — elbow bent at 90 degrees, hand resting on hip bone, fingers forward, elbow back — creating a clear triangular gap between arm and body. Far arm relaxed. Gaze slightly downward.',
  'over-shoulder': 'Body turned 50 to 60 degrees away from the camera. Head rotated back over the near shoulder toward the lens — expression of soft surprise, lips gently parted. One hand near the back of the hair, the other mid-swing.',
  'long-line':     'Posture erect from crown to feet. Back foot carries all weight, front leg extended toward camera with knee slightly bent and foot pointed toward the lens. Hips shifted toward the standing leg. Back shoulder dropped down, creating a diagonal from front foot through dropped shoulder. Fingers fully relaxed.',
  'hands-pockets': 'Standing at 30 to 45 degrees to camera. Thumbs hooked into front pockets, shoulders dropped, back leg bearing slightly more weight. Head turned toward camera, chin slightly down and forward.',
  'crossed-arms':  'Standing at 30 degrees to camera. Arms crossed, right forearm resting over left, hands relaxed and not gripping. Elbows at mid-chest height. Chin slightly down and forward, jaw defined. Gaze direct and settled.',
  lean:            'One shoulder resting against a wall or door frame. Body at 60 to 70 degrees to camera, weight fully on wall-side shoulder. Near knee slightly bent, far leg crossed loosely at the ankle. Chin slightly down, gaze direct or into distance.',
}

export async function generatePosePreviews(influencer, onPoseComplete, { stance = 'standing' } = {}) {
  try {
    const gender = influencer.gender === 'Male' ? 'man' : 'woman'
    const physDesc = (influencer.physicalDesc || '').trim()
    const subjectLine = physDesc ? `${gender}, ${physDesc}` : gender
    
    const faceUrl = influencer.mainImage ? await uploadRefImage(influencer.mainImage) : null
    
    const POSE_IDS = Object.keys(POSE_PREVIEW_DESCS_STANDING)
    const stancePrefix = stance
    
    const launchPromises = POSE_IDS.map(async (poseId) => {
      const stancedId = `${stancePrefix}_${poseId}`
      try {
        let prompt = ''
        if (stance === 'sitting') {
          const poseDesc = POSE_PREVIEW_DESCS_STANDING[poseId]
          prompt = `${subjectLine}. Pure white seamless studio backdrop. Clean flat even studio lighting, no shadows on background. The subject is seated on a white stool or low chair, chest-up framing, closer to camera. Same pose energy as: ${poseDesc} — adapted to a seated position. Photorealistic, 4K.`
        } else {
          prompt = `${subjectLine}. Pure white seamless studio backdrop. Clean flat even studio lighting, no shadows on background, no lighting equipment visible. Full body visible head to toe, standing. ${POSE_PREVIEW_DESCS_STANDING[poseId]} Photorealistic, 4K.`
        }
        
        const body = {
          prompt: capPrompt(prompt),
          aspectRatio: '9:16',
          model: 'flux-kontext-pro'
        }
        if (faceUrl) {
          body.inputImage = faceUrl
        }
        
        const res = await fetch(getApiUrl('/api/kie/api/v1/flux/kontext/generate?__kiepath=/api/v1/flux/kontext/generate'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
        
        if (!res.ok) throw new Error(`Status ${res.status}`)
        const json = await res.json()
        if (json.code !== 200 || !json.data?.taskId) throw new Error(json.msg || 'No taskId')
        
        return { stancedId, jobId: json.data.taskId }
      } catch (e) {
        console.warn(`Pose preview launch failed for ${stancedId}:`, e.message)
        return { stancedId, jobId: null }
      }
    })
    
    const launched = (await Promise.all(launchPromises)).filter(r => r.jobId)
    if (!launched.length) return
    
    const pending = new Map(launched.map(item => [item.jobId, item.stancedId]))
    
    for (let round = 0; round < 120 && pending.size > 0; round++) {
      await new Promise(r => setTimeout(r, 2500))
      
      for (const [jobId, stancedId] of [...pending.entries()]) {
        try {
          const res = await fetch(getApiUrl(`/api/kie/api/v1/flux/kontext/record-info?__kiepath=/api/v1/flux/kontext/record-info&taskId=${jobId}`))
          if (!res.ok) continue
          
          const json = await res.json()
          if (json.code !== 200) continue
          
          const status = json.data?.status ?? json.data?.successFlag
          const resultUrl = kieResultUrl(json.data)
          
          if (kieIsSuccess(status) && resultUrl) {
            pending.delete(jobId)
            onPoseComplete(stancedId, resultUrl)
          } else if (kieIsFailed(status)) {
            pending.delete(jobId)
            console.warn(`Pose preview job ${jobId} failed`)
          }
        } catch (e) {
          console.warn(`Pose preview poll error for job ${jobId}:`, e.message)
        }
      }
    }
  } catch (e) {
    console.warn('generatePosePreviews failed:', e.message)
  }
}
