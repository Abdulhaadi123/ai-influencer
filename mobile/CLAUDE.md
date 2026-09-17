@AGENTS.md

# Mobile app (React Native / Expo)

The primary app. Expo SDK 56, React Native 0.85, React 19, React Navigation 7.
Everything runs in **Expo Go** — keep it that way, because adding a
third-party native module (react-native-mmkv, for example) would force
everyone onto a custom development build before they could open the app.

## Layout — read this first

The shared, platform-agnostic logic lives at **`mobile/core/`**, INSIDE this
project, reachable through the `@core` alias:

```js
import { useInfluencers } from '@core/store'
import { generateVideo } from '@core/services/generation'
import { IMAGE_MODEL_ID } from '@core/config/generation'
```

It used to sit at the repo root, which broke `eas build` — that command
uploads only the project directory, so `../core` did not exist in the build
container and every `@core/...` import failed during "Bundle JavaScript".
Moving it inside made the app self-contained.

**The web app now imports sideways into this folder** (`web/App.jsx` does
`import { StoreProvider } from '../mobile/core/store'`). The dependency runs
web → mobile, not the other way round. Changing anything in `core/` can break
the Vite app, so check `web/` before altering a core signature.

The `@core` alias is resolved in `metro.config.js` via `resolveRequest`, not
`extraNodeModules` — an `@`-prefixed name is parsed by Metro as a scoped
package, so `@core/config/generation` would be read as scope `@core` +
package `config` and never match. There is no `watchFolders` entry; core is
inside the project root, so Metro watches it automatically.

## The platform boundary

`core/platform/` holds one file per capability. Metro picks `.native.js`
ahead of `.js` automatically — never import one variant directly.

| Capability | Web | Native |
|---|---|---|
| session storage | `authStorage.js` (memory + httpOnly cookie) | `authStorage.native.js` (SecureStore, chunked) |
| device preferences | `storage.js` (localStorage) | `storage.native.js` (expo-sqlite/kv-store) |
| API base URL | `apiUrl.js` (relative) | `apiUrl.native.js` (absolute) |
| upload to S3 | `uploader.js` (Blob PUT) | `uploader.native.js` (streamed via FileSystem) |
| media | `media.js` (canvas + `<a download>`) | `media.native.js` (expo-image-manipulator / expo-sharing) |

`kieTransport.js` and `persistMedia.js` have **no** native variant any more —
both platforms go through the authenticated API, so there was nothing
platform-specific left to split.

**`storage.*` is now only for device preferences** — the theme, essentially.
No user data and no credential may go through it. Sessions use `authStorage`;
everything else is a database row.

## Backend

`backend/` — the API and the generation worker, run with Docker on a server (or
the API alone on Vercel), reached through `EXPO_PUBLIC_API_BASE`. See
`backend/README.md`.

**No API keys ship in the app.** The KIE key and the OpenAI key used to be
inlined via `EXPO_PUBLIC_*`, which meant anyone who unpacked the .apk could
extract them. They live on the server, behind endpoints that verify a Supabase
JWT. The only values in `mobile/.env` are the Supabase URL, the anon key (public
by design), the API base and the password-reset deep link.

**EAS cloud builds do not upload `.env`** — it is gitignored. Set the same four
`EXPO_PUBLIC_*` values as EAS environment variables for each build profile, or
the build ships with them blank and opens on the "Not configured" screen.

| Endpoint | What it does |
|---|---|
| `/api/kie` | Authenticated proxy to api.kie.ai, path-allowlisted, rate limited per user |
| `/api/prompt-assist` | OpenAI rewrite; 501 when unconfigured, and the UI hides itself |
| `/api/storage/upload-url` | Presigned PUT for the exact `byteSize` (signed into the URL, so S3 refuses any other size) + the asset row, after a quota check |
| `/api/storage/confirm` | Stamps the real byte size after an upload lands |
| `/api/storage/download-url` | Batch presigned GETs, **after** an ownership check; at most 100 ids per request; `purpose: 'generation'` signs for 2 h |
| `/api/storage/ingest` | Server-side copy of a KIE result into S3 (SSRF-allowlisted on every redirect hop), quota-checked. Idempotent per result, and marks the queue row collected |
| `/api/storage/delete` | Object then row, in that order |
| `/api/influencers/delete` | Sweeps S3 before cascading the rows |
| `/api/generations/delete` | Row and file together |
| `/api/account/delete` | Every file under the user's S3 prefix, then the auth user (rows cascade) |
| `/api/auth/session` | httpOnly session cookie — **web only** |

## Authentication

Supabase Auth. The app never sees a password beyond passing it to
`supabase.auth` over TLS — no hashing here, no password column in our schema,
nothing written to disk or logged.

- `core/auth/index.js` — sign up / in / out, reset, change password, resend and
  complete email confirmation
- `core/auth/AuthContext.jsx` — the session as React state; `useAuth()`
- The navigator swaps entirely on `isSignedIn`, so no screen inside the tabs
  ever renders without a session.

Two things that look like details and are not:

- **`initialising` is separate from signed-out.** Reading the session from the
  Keychain takes a moment; treating that moment as "signed out" flashes the
  sign-in screen at every returning user.
- **`recovering` is separate from signed-in.** A password-reset link produces a
  real session. Without that flag the navigator drops the user into the app with
  their old password still working.

**Two deep links come from emails**, each with its own screen, and both exact
URLs must be in Supabase's Redirect URLs: `aiinfluencer://reset-password`
(`ResetPasswordScreen`) and `aiinfluencer://confirm-email`
(`ConfirmEmailScreen`). Sign-up used to share the reset link, so confirming an
account opened "Choose a new password". Supabase confirms the address before the
link reaches the app; the code only signs the user in. So a code that cannot be
used on this phone still means "confirmed — sign in", never "failed".

Errors are deliberately vague about whether an account exists — "that email and
password combination is not right", and `requestPasswordReset` always reports
success. Both prevent account enumeration. Do not "improve" them.

**Emails are not sent from here, or from our backend.** `resetPasswordForEmail`
asks Supabase to send; Supabase relays through SendGrid, configured as custom
SMTP in its dashboard. There is deliberately no SMTP client anywhere in this
repo — see `backend/README.md`. If a reset email does not arrive, the fault is
in the Supabase SMTP settings or the sender domain's DNS, never in this code.

## Data

Every row belongs to one user, and **Row Level Security enforces it in the
database**, not in application code. Reads therefore do not filter by user —
adding `.eq('user_id', …)` would imply the filter is what protects the data.
Writes do stamp the owner, because the insert policy requires it.

**The owner comes from `requireUserId()`** (`core/supabase.js`), which reads the
session on the device. Never use `supabase.auth.getUser()` for it: that is a
network call, and on a dropped connection it answered "no user" — the app signed
people out mid-typing and lost the queue row for a job KIE had already charged.

Some writes are closed to clients entirely (migration `0003`), because they must
go through the API to keep storage consistent: `assets` rows are created and
deleted only by the server, and a client may change only their `influencer_id`
(to an influencer it owns); `influencers` are deleted only through
`/api/influencers/delete`, which sweeps S3 first.

| Module | Table |
|---|---|
| `core/data/influencers.js` | `influencers` (+ attaches `generations`) |
| `core/data/generations.js` | `generations` — the gallery |
| `core/data/jobs.js` | `generation_jobs` — the queue, with Realtime |
| `core/data/settings.js` | `studio_settings`, `creation_params` |
| `core/data/assets.js` | `assets` — S3 keys and their owners |

Schema and policies live in `supabase/migrations/`.

### Files

The S3 bucket is private; nothing is publicly readable. A file is handed out as
a presigned GET that expires in minutes, minted only after the `assets` row is
confirmed to belong to the caller. **Never persist a presigned URL** — storing
one recreates the exact bug this replaced, where records outlived their links.

`resolveUrls` asks for signed URLs in batches of 100, the server's cap. A single
request for everything worked until an account passed 100 files, then every
image in the app went blank at once.

Every upload sends its exact size first (`getByteSize` in `platform/uploader*`),
because the server signs it into the upload URL.

Display URLs live ten minutes, so the store re-signs the ones close to expiry
every three minutes and on returning to the foreground (`refreshUrls`, driven by
`useAssetUrlRefresh`). Anything handed to KIE goes through `urlForGeneration`
inside the provider, which re-signs it for two hours — KIE fetches inputs when a
task starts, which can be long after it was queued.

Generated media is ingested server-side from the KIE URL, so the bytes never
round-trip through the device and a phone that dies mid-generation does not lose
paid work. User-picked files upload directly to S3 from the device, so a 60 MB
video never has to fit through a serverless function.

## Generation

```
screen  →  @core/services/generation      (facade — import from HERE only)
             └─ providers/kie.js           (the only provider)
                  └─ /api/kie              (JWT verified, key server-side)
                       └─ api.kie.ai
```

Model ids live only in `core/config/generation.js` (defaults) and
`core/config/videoModels.js` (the selectable alternatives). **Never hard-code
a model id in a screen.**

### Reference-image limits — `core/videoRefs.js`

Vendors cap how many reference images a video request may carry, and the cap
is small: three of the ten models take two, the other seven take exactly one.
There are almost always more images available than fit, so something is always
dropped.

`selectVideoReferences()` decides what survives, by rank:
main image → **product** → character sheet → close-up → feature sheet.
The product outranks the identity sheets deliberately — a promo with a soft
face is still a promo; one with no product is worthless.

Two rules follow from this:

- Trim by the model's declared `maxImages`, never a hard-coded number.
- **Only describe products the model actually receives.** `VideosTab` passes
  just the surviving products into `buildVideoPrompt`. Tagging a product whose
  image was trimmed makes the model invent one, and the clip looks fine — that
  is precisely how this bug went unnoticed.

### The generation queue — `core/data/jobs.js`

KIE is asynchronous: `createTask` returns a taskId and the work happens on
their side, for anywhere from twenty seconds to many minutes.

Every launch path writes its taskId to the queue **before polling starts**, so
a job survives navigation, backgrounding and a cold start. The Queue tab lists
them and can collect a result at any time.

Facts from KIE's docs that the design depends on:

| Fact | Consequence |
|---|---|
| States are `waiting`/`queuing`/`generating`/`success`/`fail` | The first three all mean "still working" |
| **Result URLs expire 24 h after completion** | A finished job is not safe until `persistMedia` has run; past 24 h it is marked Expired |
| **No list-tasks endpoint** — `recordInfo` takes one taskId | The local queue is the ONLY index; losing it loses the job |
| Webhooks exist via `callBackUrl` | Not used — `backend/server/worker.js` polls instead |
| 20 creates / 10 s; 429 on excess | `refreshJobs` walks jobs serially; polls back off exponentially |
| `progress` is sora2-only | Progress bars stay synthetic |

**A slow job is not a failed job.** When foreground polling stops watching it
throws `STILL_RUNNING`, which every screen renders as "still generating" —
never as an error. Do not collapse that back into a generic catch. The create
wizard, the reference sheets and main-image regeneration watch the taskId
(`src/hooks/usePendingResult.js`), so a slow result still lands where it was
asked for; collecting it from the Queue would only file it in the gallery.

Recording a job retries (`recordJobs` in the provider) instead of failing on the
first error — from that moment the credits are spent, and the row is the only
way back to the result.

**Who collects a result.** The screen that watched it, the Queue tab's Save, or
the worker — which also sweeps finished jobs nobody collected after a 3-minute
grace period. Collection is idempotent on the server (`backend/api/_lib/
results.js` plus the unique index in `supabase/migrations/0002`), and gallery
entries are one per asset (unique index, migration `0003`), so the three can
race without duplicating anything. Screens do not call `markCollected`; ingest
marks the row.

**A settled job is final.** `applyStatus` never rewrites a finished row: a late
poll once put the KIE link back on a job the server had already collected, and
deleting that result then let the worker collect it again. Deleting a file also
clears the link on its job server-side (`forgetSource`). "Clear finished" keeps
results not yet saved, and removing one asks first — its row is the only way
back to it.

## Errors

Every failure a person sees is a sentence from `core/errors.js`, never a raw
`e.message`. The rules:

- **Screens show errors through `userMessage(e, fallback)` or `showError(title,
  e, fallback)`** (`src/lib/alerts.js`). The fallback names the action ("The
  video could not be generated"); it only shows when the error carries nothing
  better. `showError` also drops repeats of the same alert and ignores an ended
  session.
- **Throw `AppError` for anything written for people.** `userMessage` shows it
  as is, shows a plain `Error`'s message, and hides JavaScript's own errors
  (`TypeError`…) behind the fallback.
- **Database calls throw `dbError(action, error)`**, API calls throw `ApiError`
  from `apiFetch` (which also times out after 30 s and names a missing
  `EXPO_PUBLIC_API_BASE` as such).
- **Offline is not signed out.** When the token cannot be refreshed for lack of
  a connection, `getAccessToken` and `requireUserId` throw a `NETWORK` error and
  the session is kept. Only a token Supabase rejects signs the user out.
- **A session that ends is not an error message.** `NOT_AUTHENTICATED` from our
  API, or a rejected JWT, calls `notifySessionEnded()`; `AuthContext` signs out
  and the sign-in screen shows the notice. Only our own `code` triggers it — a
  bare 401 from anything else does not.
- **The generator's refusals are not our API's.** In `providers/kie.js`,
  `refusal(res)` rethrows our API's error as written and words the generator's
  numeric codes with `generatorMessage()`. A job the generator failed throws its
  reason — it is never `STILL_RUNNING`. An input that could not be prepared
  throws before the job starts, so it is never charged for.
- **"Save or share" goes through `shareMedia`** (`src/lib/share.js`);
  `downloadImage` throws instead of failing silently.
- `src/components/ErrorBoundary.js` wraps the app, so a render crash is a
  recoverable screen rather than a blank one.

The backend mirrors this: endpoints answer failures through `sendServerError`
(`backend/api/_lib/errors.js`), which turns a missing configuration into
`503 SERVER_NOT_CONFIGURED`, an unreachable dependency into
`503 UPSTREAM_UNAVAILABLE`, and anything else into the endpoint's own sentence
with `code: 'INTERNAL'`. `requireUser` answers `503 AUTH_UNAVAILABLE` — not 401 —
when Supabase cannot be asked.

## Running it

```bash
npx expo start          # then press `a` for a booted Android emulator
npx expo run:android    # native build; needs ANDROID_HOME and a booted device
```

A development build installed before `expo-secure-store` was added crashes on
launch until it is rebuilt with `npx expo run:android` — a native module needs a
native rebuild, not a JS reload. With `mobile/.env` blank the app opens on a
"Not configured" screen rather than crashing.

`npx expo export --platform android --no-bytecode` is a fast way to prove the
whole app still bundles. Bytecode generation fails on Windows when the temp
path contains a `~` short name; that is environmental, not a code fault.

## Things not to do

- **Don't add UI that isn't actually wired.** Removing controls that looked
  functional but did nothing has been a recurring cleanup theme here.
- **Don't report a slow generation as an error.** See `STILL_RUNNING` above.
- **Don't store a bare KIE result URL.** It dies within 24 hours — run it
  through `persistMedia` first.
- **Never copy logic out of `@core` into a screen.** If something in core is
  web-coupled, fix it behind `core/platform/` instead.
- **Don't save on every keystroke.** Commit when editing ends (`DraftInput` in
  `ProfileTab`) or after a pause (studio settings in `VideosTab`). Per-keystroke
  saves raced each other and put back text the user had typed past.
- **Don't delete a file a running job may still need.** KIE downloads references
  when a job starts, which can be minutes after it was queued — check
  `hasActiveJobs` first.

## Known gaps (real, unfixed)

- Image generation **cannot be cancelled** — `CreateScreen`'s `cancelledRef`
  is never set true and `generateThreeImages` takes no `isCancelled`.
- `GalleryTab` instantiates one `expo-video` player per tile; heavy with a
  large history.
- `pickImageWithPrompt` never resolves if the Android alert is dismissed by
  tapping outside.
- The app still polls KIE while open — every 30s via `useQueueSync`, every 8s
  while the Queue tab is focused, and on foreground. With the Docker worker
  running this is redundant for collection; it remains so a serverless
  deployment with no worker keeps working.
- Studio settings with no UI: `aspect`, `outputs`, `envCustom`, `voiceCustom`,
  `additionalNotes`.
- Files the create wizard stored for an influencer that was never saved belong
  to no influencer, so nothing sweeps them until the account is deleted.
- A job removed on one device stays on another until that device reloads the
  queue: DELETE events are not broadcast (migration `0003` explains why).
