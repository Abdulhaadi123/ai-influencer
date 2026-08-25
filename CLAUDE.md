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
core/      shared, platform-agnostic logic — used by BOTH apps
mobile/    the React Native (Expo) app          ← primary
web/       the Vite web UI                      ← still works, still deployed
api/       Vercel serverless functions          ← the mobile app's BACKEND
public/    static assets, incl. seeds.json      ← also served to mobile
```

**`api/` and `public/` are not web-only.** The mobile app has no API key of
its own: it calls the deployed `/api/kie` proxy, which attaches the
server-side key, and fetches `/seeds.json` from the same deployment.
Breaking the web deployment breaks the mobile app.

## Generation stack

All generation runs through **KIE** (`api.kie.ai`) using a **single
server-side API key** (`KIE_API_KEY`). Users never log in or connect an
account of their own.

| Feature | Model id | Set in |
|---|---|---|
| Images | `nano-banana-pro` | `core/config/generation.js` |
| Video (with native audio) | `kling-3.0/video` + `sound: true` | same |
| Motion copy | `kling-3.0/motion-control` | same |

**Never hard-code a model id in UI or feature code.** Model ids live only in
`core/config/generation.js`; feature code calls the generation functions.

### Architecture (important)

```
UI / pages  →  core/services/generation/index.js  (facade — import from HERE only)
                 └─ providers/kie.js                  (the only provider today)
                      └─ /api/kie  →  api.kie.ai      (server-side key)
```

`index.js` is a bare `export * from './providers/kie'`. To add a provider,
add a file under `providers/` with the same exports and switch that line —
UI code never changes.

### `core/` — the shared, platform-agnostic layer

`core/` is being prepared for a React Native port: it holds everything
that is NOT web-specific, so a mobile app can import it unchanged.

```
core/
  config/generation.js     model ids
  services/generation/     the generation facade + KIE provider
  prompts/                 systemPrompt, charSheetPrompt
  utils/influencerUtils.js
  api/kieAuth.js           engine health check
  store.jsx                app state (React context — no DOM)
  platform/                ← the ONLY place web APIs may appear
```

**The rule: nothing in `core/` outside `core/platform/` may touch
`window`, `document`, `localStorage`, `FileReader`, or any DOM API.**
This is currently true and is worth re-checking after edits — a single
stray `window.` reference breaks the mobile port.

`core/platform/` holds the web implementations of four capabilities:

| File | Capability | React Native equivalent |
|---|---|---|
| `storage.js` | synchronous key-value | expo-sqlite/kv-store, used synchronously (**not** AsyncStorage) |
| `apiUrl.js` | resolve an API base URL | always absolute; RN has no relative origin |
| `app.js` | restart the app | Expo Updates `reloadAsync()` |
| `media.js` | compress / download media | expo-image-manipulator, expo-file-system |

Metro resolves `foo.native.js` ahead of `foo.js` automatically, so the RN
implementations go in sibling `.native.js` files with no web changes.

Web-only by design and NOT in core: `web/context/theme.jsx` (uses the DOM
view-transition API), all of `web/pages/` and `web/components/`.

### React Native safety (hard constraint)

- **Server-side keys only.** No per-user OAuth, no `window.open` popups —
  neither exists in RN. (This is why Higgsfield was dropped for KIE.)
- **No DOM** in the service layer — plain `fetch` only.
- **Use `core/platform/storage.js`**, never `localStorage` directly.

## Key files to know

| Path | What it does |
|---|---|
| `web/App.jsx` | Routes (`/influencers`, `/create`, `/settings`) + providers |
| `core/store.jsx` | storage-backed contexts (`useInfluencers`, etc.) + seed data |
| `core/config/generation.js` | **All model ids** — the one place to switch a model |
| `core/services/generation/index.js` | Generation facade — the only import point for UI |
| `core/services/generation/providers/kie.js` | KIE adapter: uploads, job launch, polling |
| `core/platform/` | Web impls of storage / apiUrl / app-reload / media |
| `core/prompts/systemPrompt.js` | Prompt templates — poses, wardrobe, vibes |
| `core/api/kieAuth.js` | Engine health check (is the server key working) |
| `web/pages/Create.jsx` | 3-step creation wizard (Basics / Reference / Generate) |
| `web/pages/Influencers.jsx` | Profile + Videos + Motion Copy studio (5,800+ lines — known debt) |
| `web/components/MotionCopyStudio.jsx` | Motion copy UI, self-contained |
| `api/kie.js` | Edge proxy that attaches `KIE_API_KEY` server-side |
| `api/img-proxy.js` | Download proxy — **allowlisted hosts** (see below) |
| `api/claude.js` | Anthropic proxy — caller supplies its own `x-api-key` |

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

## Things not to do

- **Never kill the Vite dev server** (port 5173). The owner wants it
  running at all times.
- **Don't add UI that isn't actually wired.** A recurring cleanup theme in
  this project has been removing controls that looked functional but did
  nothing. If a control can't be implemented, don't ship it.
- Don't refactor `Influencers.jsx` casually. It's 5,800+ lines and the state
  is tangled; any split needs its own dedicated session with in-browser
  verification of every flow.

## Dev workflow

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # production build
npm run preview      # preview the production build locally
```

`KIE_API_KEY` goes in `.env` (server-side, never `VITE_`-prefixed — a
`VITE_` prefix would ship the key to the browser). Settings → *KIE.AI
Engine* shows whether the key is live.
