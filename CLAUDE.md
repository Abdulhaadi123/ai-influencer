# Project context for Claude Code

This file gives a new Claude Code session enough context to be useful
immediately. Read this first, then the guide for the part you are changing —
`mobile/CLAUDE.md` for the app, `backend/README.md` for the server.

## What this app is

A mobile app for creating AI influencers and generating content with them.
People sign up with an email and password; every influencer, generation and
file belongs to their account. Rows live in PostgreSQL and files in a private
S3 bucket, both behind our own backend.

Three core features — everything else has been deliberately removed:

1. **Influencer creation** — describe an influencer by prompt and/or upload a
   reference image and pick which attributes to copy → a generated image.
2. **Brand promotion** — product image + influencer + script → a promo video
   where the influencer presents the product, with voice.
3. **Motion copy** — a character image + a driving video → the influencer
   performs that same motion.

## Repository layout

**The mobile app is the product.** The web app is kept only as a reference; it
is not deployed and no longer works against the current backend.

```
mobile/                the React Native (Expo) app              ← the product
mobile/core/           shared, platform-agnostic logic
backend/               API, worker, Postgres schema, Docker     ← see backend/README.md
backend/db/migrations/ the database schema, applied on API start
web/                   the old Vite UI                          ← reference only
```

**`core/` lives inside `mobile/`** because `eas build` uploads only the project
directory. **`backend/` is self-contained** — its own `package.json` and
Dockerfile; nothing in it imports app code, and the app knows only its URL
(`EXPO_PUBLIC_API_BASE`).

## How the pieces talk

```
app ──(access token)──►  backend API ──► PostgreSQL   users, sessions, influencers, gallery, queue
                              │      ──► S3            files (private; presigned URLs only)
                              │      ──► api.kie.ai    generation (the only holder of the key)
                              │      ──► SendGrid      confirmation and password-reset emails
                         backend worker ──► KIE + S3   collects finished jobs while the app is closed
```

**The app never connects to the database or to S3 with credentials**, and no
secret ships in it. `mobile/.env` holds one value: the API's URL.

**Authorization lives in the backend.** Every query that touches user data
carries the user id taken from the verified session — never an id from the
request. There is no Row Level Security, because no untrusted client connects
to Postgres; the database port is not reachable from outside the server.

## Accounts

Our own, in `backend/api/auth/` — sign up, email verification, sign in, sign
out, forgot and reset password, change password, delete account.

There is no "sign out everywhere": a password change or reset already ends every
other session, which is the case it existed for.

- Passwords: Argon2id, OWASP settings (`backend/api/_lib/passwords.js`).
- Sessions: random access + refresh tokens stored only as SHA-256 hashes,
  checked against the database on every call, refresh tokens rotated with
  replay detection (`backend/api/_lib/sessions.js`).
- Emails: SendGrid API from the backend. Links open small web pages on the
  backend (`backend/api/auth/pages.js`), not screens in the app — mail clients
  strip custom-scheme links.
- No answer reveals whether an email is registered.

## Generation stack

All generation runs through **KIE**, through the authenticated `/api/kie`
proxy, with one server-side key.

| Feature | Model id | Set in |
|---|---|---|
| Images | `nano-banana-pro` | `mobile/core/config/generation.js` |
| Video (with native audio) | `kling-3.0/video` + `sound: true` | same |
| Motion copy | `kling-3.0/motion-control` | same |

Selectable alternatives live in `mobile/core/config/videoModels.js`. **Never
hard-code a model id in UI or feature code.**

Rules with history behind them — detail in `mobile/CLAUDE.md`:

- **A slow job is not a failed job.** Foreground polling throws `STILL_RUNNING`;
  the job lives on in `generation_jobs` and is collected later.
- **KIE result URLs expire after 24 h and there is no list-tasks endpoint.** A
  `generation_jobs` row is the only way back to a paid result.
- **Only the server writes a job's state**, from KIE's own answer. The app asks
  for a job to be checked; it cannot report a result.
- **Rank reference images, never list them** (`core/videoRefs.js`).

## Hard constraints

- **React Native safety.** No DOM, `window`, `document` or `localStorage` in
  `mobile/core/` outside `core/platform/`. Platform code goes in sibling files —
  Metro picks `foo.native.js` over `foo.js`.
- **No user data or credential in device storage.** `core/platform/storage.*`
  holds the theme preference only; the session is in the Keychain / Keystore.
- **Every backend query on user data filters by the session's user id.** An
  endpoint that trusted an id from the request would expose everyone's data.
- **Offline is not signed out.** Only the server rejecting a refresh token ends
  a session in the app.

## Dev workflow

```bash
cd backend
npm install
DATABASE_URL=postgres://... npm start   # applies migrations, API on :8080
npm run worker                          # job collector, second terminal
```

```bash
cd mobile
npx expo start                                    # then press `a` for Android
npx expo export --platform android --no-bytecode  # prove it still bundles
```

From the Android emulator the backend on this computer is `http://10.0.2.2:8080`.
Without SendGrid configured, the backend writes emails (with their links) to its
log instead of sending them.

## Things not to do

- **Never kill the Vite dev server** (port 5173) if it is running. The owner wants it running.
- **Don't add UI that isn't actually wired.**
- **Don't report a slow generation as an error.** See `STILL_RUNNING`.
- **Don't store a bare KIE result URL or a presigned S3 URL** — both expire.
- **Don't commit or push unless asked.**
