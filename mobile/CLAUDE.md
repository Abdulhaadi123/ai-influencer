@AGENTS.md

# Mobile app (React Native / Expo)

The product. Expo SDK 56, React Native 0.85, React 19, React Navigation 7.

## Layout — read this first

The shared, platform-agnostic logic lives at **`mobile/core/`**, INSIDE this
project, reachable through the `@core` alias:

```js
import { useInfluencers } from '@core/store'
import { generateVideo } from '@core/services/generation'
import { IMAGE_MODEL_ID } from '@core/config/generation'
```

It used to sit at the repo root, which broke `eas build` — that command uploads
only the project directory. The `@core` alias is resolved in `metro.config.js`
via `resolveRequest`, not `extraNodeModules`: an `@`-prefixed name is parsed by
Metro as a scoped package and would never match.

## The platform boundary

`core/platform/` holds one file per capability. Metro picks `.native.js` ahead
of `.js` automatically — never import one variant directly.

| Capability | Web (reference only) | Native |
|---|---|---|
| session storage | `authStorage.js` (memory) | `authStorage.native.js` (SecureStore, chunked) |
| device preferences | `storage.js` (localStorage) | `storage.native.js` (expo-sqlite/kv-store) |
| API base URL | `apiUrl.js` (relative) | `apiUrl.native.js` (absolute) |
| upload to S3 | `uploader.js` (Blob PUT) | `uploader.native.js` (streamed via FileSystem) |
| media | `media.js` (canvas) | `media.native.js` (expo-image-manipulator / expo-sharing) |

**`storage.*` is only for device preferences** — the theme. No user data and no
credential may go through it.

## The backend

Everything goes through `backend/` (see `backend/README.md`), reached at
`EXPO_PUBLIC_API_BASE` — **the only value in `mobile/.env`**. The app never
connects to the database or holds a storage credential or API key; an .apk is a
zip file, and anything in it can be extracted.

**EAS cloud builds do not upload `.env`** (it is gitignored). Set
`EXPO_PUBLIC_API_BASE` as an EAS environment variable for each build profile, or
the build opens on the "Not configured" screen. See `SHARING.md`.

All calls go through `apiFetch` (`core/api/client.js`), which attaches the
session's access token, refreshes it when needed, and turns failures into
`ApiError`s whose message the server wrote for people.

## Authentication

Our own accounts API (`backend/api/auth/`). The app passes a password to the
server over TLS and then forgets it — it is never stored, logged, or put in an
error message. The server hashes it with Argon2id.

- `core/auth/index.js` — sign up, sign in, sign out (this device / everywhere),
  forgot password, resend confirmation, change password, delete account
- `core/auth/session.js` — the tokens: stored in the Keychain via `authStorage`,
  refreshed shortly before expiry
- `core/auth/AuthContext.jsx` — the session as React state; `useAuth()`
- The navigator swaps entirely on `isSignedIn`, so no screen inside the tabs
  ever renders without a session.

Things that look like details and are not:

- **`initialising` is separate from signed-out.** Reading the session from the
  Keychain takes a moment; treating that as "signed out" flashes the sign-in
  screen at every returning user.
- **One refresh at a time.** The server rotates the refresh token on every use
  and treats an old one coming back as stolen, ending the session. Two refreshes
  racing would look exactly like that — `session.js` shares one in-flight
  refresh.
- **Offline is not signed out.** A refresh that cannot reach the server keeps the
  session and surfaces a `NETWORK` error. Only the server rejecting the refresh
  token ends it (`SESSION_EXPIRED`), and the sign-in screen then says why.
- **Email links open web pages, not the app.** Confirming an email and choosing
  a new password happen on pages the backend serves; the app only asks for the
  email to be sent and then signs the person in. Mail clients strip
  `aiinfluencer://` links, and a page also works when the email is read on a
  computer. There are no deep-link routes for them.

Errors are deliberately vague about whether an account exists — "that email and
password combination is not right", and forgot-password / resend always report
success. Both prevent account enumeration. Do not "improve" them.

## Data

The server scopes every read and write to the signed-in user; nothing in the app
sends a user id.

| Module | API |
|---|---|
| `core/data/influencers.js` | `/api/influencers` (+ the gallery attached) |
| `core/data/generations.js` | `/api/generations/*` — the gallery |
| `core/data/jobs.js` | `/api/jobs/*` — the queue, and change polling |
| `core/data/settings.js` | `/api/studio-settings`, `/api/creation-params` |
| `core/data/assets.js` | `/api/storage/*` — uploads, signed URLs, ingest |

Modules translate API rows (snake_case, asset ids) into the objects screens use
(`mainImage`, `generationHistory`…) and keep the durable `*AssetId` alongside.

**Creating an influencer is one call** (`influencers.create(record, {
linkAssetIds, creationParams })`): the record, the files the wizard stored before
it existed, and what it was generated from, saved in one transaction.

### Files

The S3 bucket is private. A file is handed out as a presigned GET minted after
the server checks the caller owns it. **Never persist a presigned URL.**

- `resolveUrls` asks in batches of 100, the server's cap.
- Every upload sends its exact size first (`getByteSize`); the server signs it
  into the upload URL.
- Display URLs live ten minutes; the store re-signs the ones near expiry every
  three minutes and on returning to the foreground (`useAssetUrlRefresh`).
  Anything handed to KIE goes through `urlForGeneration`, re-signed for two hours.
- Generated media is copied into S3 by the server (`ingest`), so a phone that
  dies mid-download does not lose paid work.

## Generation

```
screen  →  @core/services/generation      (facade — import from HERE only)
             └─ providers/kie.js           (the only provider)
                  └─ /api/kie              (session checked, key server-side)
                       └─ api.kie.ai
```

Model ids live only in `core/config/generation.js` and
`core/config/videoModels.js`. **Never hard-code a model id in a screen.**

### Reference-image limits — `core/videoRefs.js`

Vendors cap reference images at one or two, so something is always dropped.
`selectVideoReferences()` ranks: main image → **product** → character sheet →
close-up → feature sheet. Trim by the model's `maxImages`, and **only describe
products the model actually receives** — tagging a trimmed product makes the
model invent one.

### The generation queue — `core/data/jobs.js`

| Fact from KIE | Consequence |
|---|---|
| States `waiting`/`queuing`/`generating`/`success`/`fail` | The first three mean "still working" |
| **Result URLs expire 24 h after completion** | A finished job is not safe until ingested |
| **No list-tasks endpoint** | The `generation_jobs` row is the only way back; losing it loses the job |
| 20 creates / 10 s; 429 on excess | Polls are serial and back off |

- **Every launch path records the job before polling** (`recordJobs` in the
  provider, retried): from that moment the credits are spent.
- **Only the server writes a job's state.** Polling calls `/api/jobs/sync`, where
  the server asks KIE and records KIE's answer; the app cannot report a result.
  A finished job is final — a late answer never rewrites it.
- **A slow job is not a failed job.** Foreground polling throws `STILL_RUNNING`,
  rendered as "still generating", never an error. The create wizard, reference
  sheets and main-image regeneration keep watching the task
  (`src/hooks/usePendingResult.js`) so the result lands where it was asked for.
- **Change notifications are polled.** `subscribe(userId, handler)` delivers
  `{ eventType: 'UPDATE', new: row }` for each changed job; one shared poller asks
  `/api/jobs/changes` every 5 s while anything is subscribed. A change can arrive
  twice — handlers must treat repeats as no-ops.
- **Who collects a result:** the screen that watched it, the Queue tab's Save, or
  the backend worker (which also sweeps finished, uncollected jobs after a 3-min
  grace). Collection is idempotent on the server, and the gallery holds one entry
  per file, so they can race safely.
- **"Clear finished" keeps unsaved results**, and removing one asks first.

## Errors

Every failure a person sees is a sentence from `core/errors.js`, never a raw
`e.message`.

- **Screens show errors through `userMessage(e, fallback)` or `showError(title,
  e, fallback)`** (`src/lib/alerts.js`). `showError` drops repeats and ignores an
  ended session.
- **Throw `AppError` for anything written for people.** API calls throw
  `ApiError` from `apiFetch`, which times out after 30 s and names a missing
  `EXPO_PUBLIC_API_BASE` as such.
- **A session that ends is not an error message.** `NOT_AUTHENTICATED` from our
  API (after one refresh-and-retry) calls `notifySessionEnded()`; `AuthContext`
  signs out and the sign-in screen shows the notice.
- **The generator's refusals are not our API's.** `refusal(res)` in the provider
  rethrows our API's error as written and words KIE's numeric codes with
  `generatorMessage()`.
- **"Save or share" goes through `shareMedia`** (`src/lib/share.js`).
- `src/components/ErrorBoundary.js` wraps the app.

## Running it

```bash
npx expo start          # then press `a` for a booted Android emulator
npx expo run:android    # native build; needs ANDROID_HOME and a booted device
```

A development build made before `expo-secure-store` was added crashes on launch
until rebuilt with `npx expo run:android`. With `mobile/.env` blank the app opens
on a "Not configured" screen rather than crashing.

`npx expo export --platform android --no-bytecode` proves the whole app still
bundles.

## Things not to do

- **Don't add UI that isn't actually wired.**
- **Don't report a slow generation as an error.** See `STILL_RUNNING`.
- **Don't store a bare KIE result URL** — ingest it first.
- **Never copy logic out of `@core` into a screen.**
- **Don't save on every keystroke.** Commit when editing ends (`DraftInput` in
  `ProfileTab`) or after a pause (studio settings in `VideosTab`).
- **Don't delete a file a running job may still need** — check `hasActiveJobs`
  first; KIE downloads references when a job starts.
- **Don't start a second token refresh** outside `session.js`.

## Known gaps (real, unfixed)

- Image generation **cannot be cancelled** — `generateThreeImages` takes no
  `isCancelled`.
- `GalleryTab` instantiates one `expo-video` player per tile; heavy with a large
  history.
- `pickImageWithPrompt` may never resolve if the Android alert is dismissed by
  tapping outside.
- Studio settings with no UI: `aspect`, `outputs`, `envCustom`, `voiceCustom`,
  `additionalNotes`.
- Files the create wizard stored for an influencer that was never saved belong to
  no influencer, so nothing sweeps them until the account is deleted.
- A job removed on one device stays on another until that device reloads the
  queue — the change feed reports updates, not deletions.
