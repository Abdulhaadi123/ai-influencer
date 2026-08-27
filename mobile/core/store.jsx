import { useState, useEffect, createContext, useContext } from 'react'
import * as storage from './platform/storage'

// Generic small-value localStorage hook (inspiration boards, brand deals, etc.)
function useLocalStorage(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const stored = storage.getItem(key)
      return stored ? JSON.parse(stored) : initial
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      storage.setItem(key, JSON.stringify(value))
    } catch (e) {
      console.warn('localStorage quota exceeded — data not saved', e)
    }
  }, [key, value])

  return [value, setValue]
}

// ── Per-influencer storage ────────────────────────────────────────
// Each influencer lives in its own key: hf_influencer_${id}
// The ordered list of IDs lives in influencer_ids.
// This way adding/updating influencer N never risks losing influencer M.

const INF_PREFIX = 'hf_influencer_'
const IDS_KEY    = 'influencer_ids'

function readInfluencer(id) {
  try { return JSON.parse(storage.getItem(`${INF_PREFIX}${id}`)) } catch { return null }
}

function writeInfluencer(inf) {
  try {
    storage.setItem(`${INF_PREFIX}${inf.id}`, JSON.stringify(inf))
    return true
  } catch (e) {
    console.warn(`localStorage quota exceeded — influencer "${inf.name}" not saved`, e)
    return false
  }
}

function readIds() {
  try { return JSON.parse(storage.getItem(IDS_KEY) || 'null') } catch { return null }
}

function writeIds(ids) {
  try { storage.setItem(IDS_KEY, JSON.stringify(ids)) } catch {}
}

// Read the legacy single-key list (may still have data even after migration attempt)
function readLegacyList() {
  try {
    const raw = storage.getItem('influencers')
    if (!raw) return []
    return JSON.parse(raw) || []
  } catch { return [] }
}

function useInfluencerStore(initial) {
  const [influencers, setInfluencers] = useState(() => {
    const ids = readIds()
    if (ids && ids.length > 0) {
      const loaded = ids.map(readInfluencer).filter(Boolean)

      // If we loaded fewer than expected, some hf_influencer_* writes failed (quota).
      // Recover missing ones from the legacy 'influencers' key which may still have the data.
      if (loaded.length < ids.length) {
        const loadedSet = new Set(loaded.map(i => i.id))
        const legacy = readLegacyList()
        for (const inf of legacy) {
          if (!loadedSet.has(inf.id)) {
            loaded.push(inf)
            loadedSet.add(inf.id)
          }
        }
        // Restore original order
        const byId = Object.fromEntries(loaded.map(i => [i.id, i]))
        const ordered = ids.map(id => byId[id]).filter(Boolean)
        // Also pick up any influencers in legacy but not in ids (edge case)
        const orderedSet = new Set(ordered.map(i => i.id))
        for (const inf of legacy) {
          if (!orderedSet.has(inf.id)) ordered.push(inf)
        }
        return ordered.length > 0 ? ordered : initial
      }

      return loaded.length > 0 ? loaded : initial
    }

    // No new-format IDs yet — fall back to legacy single key
    const legacy = readLegacyList()
    return legacy.length > 0 ? legacy : initial
  })

  useEffect(() => {
    const ids = influencers.map(i => i.id)
    writeIds(ids)
    for (const inf of influencers) writeInfluencer(inf)
    // Remove keys for deleted influencers
    const idSet = new Set(ids)
    for (const key of storage.getAllKeys()) {
      if (key.startsWith(INF_PREFIX)) {
        const id = key.slice(INF_PREFIX.length)
        if (!idSet.has(id)) try { storage.removeItem(key) } catch {}
      }
    }
  }, [influencers])

  return [influencers, setInfluencers]
}

// ── Shared contexts — one source of truth across all pages ──
const InfluencersCtx = createContext(null)
const BrandDealsCtx  = createContext(null)

// ── One-time removal of the bundled demo influencers ────────────────────────
//
// The app used to ship eight sample influencers (Kayla, Camila, Marcus, plus
// five carried over from the old web deployment) and inject them on first run.
// They are gone: everyone got the same fake roster, several of them were one
// real person's content, and their media only ever resolved against the old
// website's origin.
//
// Removing them from the bundle stops NEW installs receiving them, but an
// existing install already has the records on disk, so they are cleared here.
//
// The `file://` check is the safeguard: persistMedia writes results to a
// file:// path on the device, and only ever for something the user generated
// themselves. Seed history entries are all http:// or bare web paths. So a
// demo influencer the user actually made something with is KEPT — deleting it
// would take their clip with it.

const DEMO_IDS = [
  'kayla-template', 'camila-template', 'marcus-template',
  'mpe00fxqdypgtihqft', 'mpm5hc0xi4d78ry3qr', 'mpm8eqj77o69r06igss',
  'mpma2ne5wzlwy87k7n', 'mpmd4rw1nhdryivbpxh',
]
const DEMO_PURGE_FLAG = 'demo_influencers_removed_v1'

function hasUserContent(inf) {
  return (inf?.generationHistory || []).some(e => typeof e?.url === 'string' && e.url.startsWith('file://'))
}

try {
  if (!storage.getItem(DEMO_PURGE_FLAG)) {
    const ids = readIds() || []
    const keep = ids.filter(id => {
      if (!DEMO_IDS.includes(id)) return true          // the user's own, always keep
      return hasUserContent(readInfluencer(id))        // demo they built on, keep
    })
    for (const id of ids) {
      if (!keep.includes(id)) {
        try { storage.removeItem(`${INF_PREFIX}${id}`) } catch {}
      }
    }
    writeIds(keep)
    // The photo board only ever held demo stills; nothing in the app reads it.
    try { storage.removeItem('photo_studio_history') } catch {}
    storage.setItem(DEMO_PURGE_FLAG, '1')
  }
} catch (_) {}


export function StoreProvider({ children }) {
  const influencerStore = useInfluencerStore([])
  const brandDealsState = useLocalStorage('brand_deals', [])

  // No seeding. The app used to ship a roster of demo influencers and merge
  // them in here; they are gone, so a fresh install starts empty and every
  // influencer in the list is one the user made.

  return (
    <InfluencersCtx.Provider value={influencerStore}>
      <BrandDealsCtx.Provider value={brandDealsState}>
        {children}
      </BrandDealsCtx.Provider>
    </InfluencersCtx.Provider>
  )
}

export function useInfluencers()       { return useContext(InfluencersCtx) }
export function useBrandDeals()        { return useContext(BrandDealsCtx) }

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}
