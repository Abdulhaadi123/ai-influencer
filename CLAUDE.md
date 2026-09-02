# Project context for Claude Code

This file gives a new Claude Code session enough context to be useful
immediately. Read this first before making changes.

## What this app is

A React+Vite single-page app for creating AI influencers and generating
content with them. Local-first: every user's data lives in their own
browser localStorage.

Three core features — everything else has been deliberately removed:

1. **Influencer creation** — describe an influencer by prompt and/or upload a
   reference image and pick which attributes to copy → generated images.
2. **Brand promotion** — product image + influencer + profile + script →
   a promo video where the influencer presents the product, with voice.
3. **Motion copy** — a character image + a driving video → the influencer
   performs that same motion.

## Repository layout

The mobile app is the product going forward; the web app still runs and is
kept working, but new feature work targets `mobile/`.

```
mobile/       the React Native (Expo) app            ← primary
mobile/core/  shared, platform-agnostic logic        ← used by BOTH apps
web/          the Vite web UI                        ← still works, still deployed
api/          Vercel serverless functions            ← WEB ONLY
public/       static assets                          ← web only
```

**`core/` lives inside `mobile/`, and the web app imports sideways into it**
(`web/App.jsx` does `import { StoreProvider } from '../mobile/core/store'`).
The dependency runs web → mobile. It sits there because `eas build` uploads
only the project directory, so a root-level `../core` did not exist in the
build container and every `@core/...` import failed to resolve.

**The mobile app does NOT use `api/`.** It calls `api.kie.ai` directly with a
key bundled into the app (`EXPO_PUBLIC_KIE_API_KEY`). The `/api/*` proxies
exist for the browser, which must not hold a key. Breaking the web deployment
does **not** break the mobile app — they share code, not infrastructure.

## Generation stack

All generation runs through **KIE** (`api.kie.ai`). Users never log in or
connect an account of their own — one account's credits serve everyone. How
the key is supplied differs by platform:

| Platform | Key | Path |
|---|---|---|
| Web | `KIE_API_KEY`, server-side | browser → `/api/kie` proxy → `api.kie.ai` |
| Mobile | `EXPO_PUBLIC_KIE_API_KEY`, **bundled into the app** | app → `api.kie.ai` |

| Feature | Model id | Set in |
|---|---|---|
| Images | `nano-banana-pro` | `mobile/core/config/generation.js` |
| Video (with native audio) | `kling-3.0/video` + `sound: true` | same |
| Motion copy | `kling-3.0/motion-control` | same |

**Never hard-code a model id in UI or feature code.** Model ids live only in
`mobile/core/config/generation.js`; feature code calls the generation functions.

### Architecture (important)

```
screens / pages  →  core/services/generation/index.js   (facade — import from HERE only)
                      └─ providers/kie.js               (the only provider today)
                           ├─ web:    /api/kie  →  api.kie.ai   (key stays server-side)
                           └─ mobile: api.kie.ai directly       (key bundled in the app)
```

The split happens in `core/platform/kieTransport{,.native}.js` — the provider
itself never knows which one it got.

`index.js` is a bare `export * from './providers/kie'`. To add a provider,
add a file under `providers/` with the same exports and switch that line —
UI code never changes.

### `mobile/core/` — the shared, platform-agnostic layer

Holds everything that is NOT web-specific, so both apps import it unchanged.

```
mobile/core/
  config/generation.js     default model ids
  config/videoModels.js    selectable video / motion models + their input shapes
  services/generation/     the generation facade + KIE provider
  prompts/                 systemPrompt, videoPrompt, charSheetPrompt, influencerPrompts
  jobQueue.js              persisted KIE taskIds — the generation queue
  videoRefs.js             which reference images survive a model's image cap
  identityRefs.js          the three reference sheets
  regenerate.js            re-run an influencer's main image
  studioSettings.js        per-influencer studio state
  utils/influencerUtils.js
  api/kieAuth.js           engine health check
  api/diagnostics.js       free, credit-free integration checks
  store.jsx                app state (React context — no DOM)
  platform/                ← the ONLY place platform APIs may appear
```

Two pieces of core carry hard-won rules; see `mobile/CLAUDE.md` for the
detail:

- **`videoRefs.js`** — video models take one or two reference images, so
  something is always dropped. Rank, never list: product outranks identity
  sheets, and only products actually sent may be named in the prompt.
- **`jobQueue.js`** — KIE result URLs expire after 24 h and there is no
  list-tasks endpoint, so the local taskId record is the only index. A slow
  job throws `STILL_RUNNING` and is never reported as a failure.

`mobile/core/platform/` holds both implementations of each capability:

| Capability | Web | Native |
|---|---|---|
| synchronous key-value | `storage.js` (localStorage) | `storage.native.js` (expo-sqlite/kv-store, **not** AsyncStorage) |
| KIE transport | `kieTransport.js` (via `/api/kie`) | `kieTransport.native.js` (direct) |
| OpenAI transport | `openaiTransport.js` (disabled) | `openaiTransport.native.js` (direct) |
| compress / share media | `media.js` (canvas) | `media.native.js` (expo-image-manipulator / expo-sharing) |
| keep a result past 24 h | `persistMedia.js` (passthrough) | `persistMedia.native.js` (downloads to documents dir) |

`apiUrl.js` is imported only by the two web modules and has no native
variant. There is no `app.js` / `app.native.js`.

Metro resolves `foo.native.js` ahead of `foo.js` automatically, so the RN
implementations go in sibling `.native.js` files with no web changes.

Web-only by design and NOT in core: `web/context/theme.jsx` (uses the DOM
view-transition API), all of `web/pages/` and `web/components/`.

### React Native safety (hard constraint)

- **No per-user OAuth, no `window.open` popups** — neither exists in RN.
  (This is why Higgsfield was dropped for KIE.)
- **No DOM** in the service layer — plain `fetch` only.
- **Use `core/platform/storage.js`**, never `localStorage` directly.
- Nothing in `core/` outside `core/platform/` may touch `window`, `document`,
  `localStorage`, `FileReader`, or any other DOM API. Worth re-checking after
  edits — one stray `window.` breaks the mobile app.

## Key files to know

| Path | What it does |
|---|---|
| `mobile/core/config/generation.js` | **Default model ids** — one place to switch a model |
| `mobile/core/config/videoModels.js` | Selectable models + each vendor's request shape and image cap |
| `mobile/core/services/generation/index.js` | Generation facade — the only import point for UI |
| `mobile/core/services/generation/providers/kie.js` | KIE adapter: uploads, job launch, polling, `STILL_RUNNING` |
| `mobile/core/jobQueue.js` | Persisted taskIds — survives restarts, drives the Queue tab |
| `mobile/core/videoRefs.js` | Ranks reference images against the model's cap |
| `mobile/core/store.jsx` | storage-backed contexts (`useInfluencers`, `useBrandDeals`) |
| `mobile/core/prompts/systemPrompt.js` | Image prompt templates — poses, wardrobe, vibes |
| `mobile/core/prompts/videoPrompt.js` | `buildVideoPrompt` + voice presets |
| `mobile/core/platform/` | Web + native impls of storage / transports / media |
| `mobile/src/navigation/index.js` | Bottom tabs: Home, Influencers, Create, Queue, Settings |
| `mobile/src/screens/QueueScreen.js` | Generation queue — status, collect, expiry |
| `mobile/src/screens/VideosTab.js` | Brand promo studio |
| `mobile/src/screens/MotionCopyScreen.js` | Motion copy studio |
| `mobile/src/screens/CreateScreen.js` | 3-step creation wizard |
| `web/App.jsx` | Routes (`/influencers`, `/create`, `/settings`) + providers |
| `web/pages/Influencers.jsx` | Profile + Videos + Motion Copy studio (5,300+ lines — known debt) |
| `api/kie.js` | Edge proxy that attaches `KIE_API_KEY` server-side (**web only**) |
| `api/img-proxy.js` | Download proxy — **allowlisted hosts** (see below) |
| `api/claude.js` | Anthropic proxy — caller supplies its own `x-api-key` |

> **Known breakage:** `web/pages/Influencers.jsx` imports
> `buildCharSheetPrompt` and `buildCharSheetPromptWithClaude` from
> `mobile/core/prompts/charSheetPrompt`, which exports neither. The web app's
> main page cannot load until that is reconciled. The mobile app is unaffected.

### The KIE proxy path convention

Browser code never calls `api.kie.ai` directly. It calls `/api/kie/...` and
passes the upstream path in a `__kiepath` query param, e.g.:

```
/api/kie/api/v1/jobs/createTask?__kiepath=/api/v1/jobs/createTask
```

`api/kie.js` (production) and `kiePlugin` in `vite.config.js` (dev) both read
`__kiepath`, strip it, and forward to `api.kie.ai` — or to
`kieai.redpandaai.co` for `/api/file-*` upload routes.

### api/img-proxy.js allowlist

Downloads of generated media are proxied to bypass CORS. `ALLOWED_HOSTS`
must contain the CDNs KIE actually serves from, or **every download 403s**:

- `aiquickdraw.com` — generation results (`tempfile.aiquickdraw.com`)
- `redpandaai.co` — uploaded media (`tempfile.`/`kieai.redpandaai.co`)

If a model is swapped and results start coming from a new CDN, add it here.
Note the dev proxy in `vite.config.js` does **not** enforce this allowlist,
so an allowlist bug only shows up in production.

## Conventions

- Inline styles with CSS variables (`var(--bg)`, `var(--text-primary)`).
  Theme tokens are set on `<html data-theme="dark|light">` from
  `web/context/theme.jsx`.
- IDs use `generateId()` from `store.jsx` (`Date.now() + random`).

## Dev workflow

**Mobile (primary):**

```bash
cd mobile
npx expo start                                    # then press `a` for Android
npx expo export --platform android --no-bytecode  # prove it still bundles
```

Keys go in `mobile/.env` as `EXPO_PUBLIC_KIE_API_KEY` (and optionally
`EXPO_PUBLIC_OPENAI_API_KEY`). Both are **inlined into the shipped bundle** —
see `mobile/SHARING.md` before distributing a build.

**Web:**

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # production build
```

`KIE_API_KEY` goes in the root `.env` (server-side, never `VITE_`-prefixed —
that prefix would ship the key to the browser). Settings → *KIE.AI Engine*
shows whether the key is live.

## Things not to do

- **Never kill the Vite dev server** (port 5173). The owner wants it running.
- **Don't add UI that isn't actually wired.** A recurring cleanup theme here
  has been removing controls that looked functional but did nothing.
- **Don't report a slow generation as an error.** KIE jobs can take many
  minutes; `STILL_RUNNING` means "handed to the queue", not "failed".
- **Don't store a bare KIE result URL** — it dies within 24 hours.
- Don't refactor `web/pages/Influencers.jsx` casually. It's 5,300+ lines with
  tangled state; any split needs its own session and in-browser verification.
