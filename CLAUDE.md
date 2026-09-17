# Project context for Claude Code

This file gives a new Claude Code session enough context to be useful
immediately. Read this first, then the README of whichever part you are
changing — `mobile/CLAUDE.md` for the app, `backend/README.md` for the server.

## What this app is

A mobile app for creating AI influencers and generating content with them.
Users sign in; every influencer, generation and file belongs to their account
and lives in Supabase (rows) and a private S3 bucket (files).

Three core features — everything else has been deliberately removed:

1. **Influencer creation** — describe an influencer by prompt and/or upload a
   reference image and pick which attributes to copy → a generated image.
2. **Brand promotion** — product image + influencer + script → a promo video
   where the influencer presents the product, with voice.
3. **Motion copy** — a character image + a driving video → the influencer
   performs that same motion.

## Repository layout

**The mobile app is the product.** The web app is kept only as a reference and
is not deployed.

```
mobile/                 the React Native (Expo) app              ← the product
mobile/core/            shared, platform-agnostic logic          ← used by both apps
backend/                API + generation worker, deployable alone ← see backend/README.md
supabase/migrations/    schema, Row Level Security, grants       ← run in order
web/                    the old Vite UI                          ← reference only
public/                 static assets for the web UI
```

**`core/` lives inside `mobile/`, and the web app imports sideways into it**
(`web/App.jsx` does `import { StoreProvider } from '../mobile/core/store'`).
It sits there because `eas build` uploads only the project directory, so a
root-level `../core` did not exist in the build container.

**`backend/` is self-contained** — its own `package.json`, Dockerfile and
`vercel.json`, and nothing in it imports app or web code. The app knows only its
URL (`EXPO_PUBLIC_API_BASE`).

## How the pieces talk

```
app ──(Supabase JWT)──►  Supabase     rows, auth, Realtime — Row Level Security per user
app ──(Supabase JWT)──►  backend/api  KIE proxy, S3 presigning, ingest, deletes
                         backend/server/worker.js  collects finished jobs while the app is closed
backend ─────────────►  api.kie.ai   the only holder of the KIE key
backend ─────────────►  S3           private bucket, users/<user-id>/… keys
```

**No secret ships in the app.** The KIE and OpenAI keys live only in
`backend/.env`. `mobile/.env` holds public values: the Supabase URL and anon key,
the API base, and the password-reset deep link.

## Generation stack

All generation runs through **KIE**. Users never connect an account of their
own — one server-side key serves everyone, through the authenticated
`/api/kie` proxy.

| Feature | Model id | Set in |
|---|---|---|
| Images | `nano-banana-pro` | `mobile/core/config/generation.js` |
| Video (with native audio) | `kling-3.0/video` + `sound: true` | same |
| Motion copy | `kling-3.0/motion-control` | same |

Selectable alternatives and each vendor's request shape live in
`mobile/core/config/videoModels.js`. **Never hard-code a model id in UI or
feature code.**

```
screens  →  core/services/generation/index.js   (facade — import from HERE only)
              └─ providers/kie.js               (the only provider)
                   └─ core/platform/kieTransport.js → /api/kie → api.kie.ai
```

Rules with history behind them — the detail is in `mobile/CLAUDE.md`:

- **A slow job is not a failed job.** Foreground polling throws `STILL_RUNNING`;
  the job lives on in `generation_jobs` and is collected later.
- **KIE result URLs expire after 24 h and there is no list-tasks endpoint.** The
  `generation_jobs` row is the only way back to a paid result — never delete one
  that has not been saved.
- **Rank reference images, never list them** (`core/videoRefs.js`): models take
  one or two, and only products actually sent may be named in the prompt.

## Hard constraints

- **React Native safety.** No DOM, `window`, `document` or `localStorage`
  anywhere in `mobile/core/` outside `core/platform/`. Platform code goes in
  sibling files — Metro picks `foo.native.js` over `foo.js`.
- **No user data or credential in device storage.** `core/platform/storage.*`
  holds the theme preference and nothing else; the session is in the Keychain /
  Keystore via `authStorage.native.js`.
- **Row Level Security is the data boundary**, not application code. The
  service-role key exists only on the server.
- **The owner of a write comes from the device session** (`requireUserId()` in
  `core/supabase.js`), never from `supabase.auth.getUser()`, which is a network
  call that reads a dropped connection as "signed out".

## Dev workflow

```bash
cd mobile
npx expo start                                    # then press `a` for Android
npx expo export --platform android --no-bytecode  # prove it still bundles
```

```bash
cd backend
npm install && npm start      # API on :8080 — from the Android emulator it is http://10.0.2.2:8080
npm run worker                # the job collector, in a second terminal
```

After adding a native module (as `expo-secure-store` was), a development build
must be rebuilt with `npx expo run:android`; a JS reload is not enough.

## Things not to do

- **Never kill the Vite dev server** (port 5173) if it is running. The owner wants it running.
- **Don't add UI that isn't actually wired.** A recurring cleanup theme here
  has been removing controls that looked functional but did nothing.
- **Don't report a slow generation as an error.** See `STILL_RUNNING`.
- **Don't store a bare KIE result URL or a presigned S3 URL** — both expire.
- **Don't commit or push unless asked.**

> **Known breakage (web, reference only):** `web/pages/Influencers.jsx` imports
> `buildCharSheetPrompt` and `buildCharSheetPromptWithClaude` from
> `mobile/core/prompts/charSheetPrompt`, which exports neither. The mobile app is
> unaffected.
