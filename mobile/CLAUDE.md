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

**`storage.*` is only for device preferences** — the theme, and `pack_offer_seen`
(the Get credits offer has been shown on this install). No user data and no
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

- `core/auth/index.js` — sign up, sign in, sign out, forgot password, resend
  the verification email, change password, delete account
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

- **Sign-up ends on its own page.** When the server says a confirmation email is needed,
  `SignUpScreen` *replaces* itself with `VerifyEmailScreen` (an animated tick — `SuccessTick`, SVG, still for
  reduce-motion — "Email sent", the address, **Go to sign in**, resend). Going back must not land on the filled-in form.
  The pages the email link opens (`backend/api/_lib/pages.js`, `successBlock`) draw the same tick.
- **Every password field has an eye** (`PillInput` with `secureTextEntry`, so Settings' dialogs too), and the auth
  fields type from the left (`inputLeft`) — they used to be centred, which made typing begin mid-field.
- **The suggestion card says something about the text**, not only offers a rewrite: `improvePrompt` returns
  `{ suggestion, notice }` (a refusal, `CONTENT_BLOCKED`, is returned as a `blocked` notice, not thrown).

Sign-in errors are deliberately vague — "that email and password combination is
not right" — and resend always reports success. Do not "improve" those. Sign-up and
forgot-password are the exceptions (the owner's decision): an address that already
has an account is refused at sign-up (`EMAIL_TAKEN`), and one with no account at
forgot-password (`ACCOUNT_NOT_FOUND`, with a **Sign up** link) — said on the form,
not answered with "check your email".

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

**The Queue and the Gallery are paged** (`core/data/paging.js`, pure and tested).
Continue from a row's server `cursor`, never from `createdAt` (milliseconds; rows
saved together share a microsecond). The Queue (`src/hooks/useQueuePages.js`) holds
the pages scrolled to, merges a fresh first page on top when the change feed reports
something, and takes its totals from `summary`, not from the rows held. The Gallery
keeps "All" in `generationHistory` and a filter's own pages in `galleryExtra`, so
"All" never shows a gap. The app holds only what was scrolled to: a question about
the whole gallery (is this file in it?) goes to the server (`isInGallery`).

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
- **A big picture always gets its small preview.** A generated image is a 2K file of
  several megabytes (a PNG was 9.7 MB before image jobs asked KIE for JPEG); on a phone
  connection a frame drawn only from it sat empty for ten seconds or more, while the
  gallery showed the same picture at once from its preview. So `MediaImage` takes a
  `previewUri` and draws it underneath until the full file has loaded, and every large
  view passes one: the Create preview, the Profile hero (`mainThumb`), the reference
  sheets (the asset's `thumbUrlFor`), the full-screen viewer and the gallery lightbox
  (`thumbUrl`). For a result that has only just finished there is no stored preview yet:
  `quickPreview({ sourceUrl, taskId })` asks the server for one made from KIE's link
  (backend `api/storage/quick-preview.js`, about a second), and `waitForPreview(assetId)`
  picks up the stored one after `ingest`. Whichever arrives first stays.

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

**An image does not mean the same thing to every model.** Kling's `image_urls`
are the first and last FRAMES; Seedance's `reference_image_urls` and Veo's
`REFERENCE_2_VIDEO` mode are references in the sense this app means. Each entry
in `videoModels.js` maps the request onto its own model's fields, and
`maxImages: 0` (MiniMax text-to-video) means the model cannot be shown the
influencer at all — the studio warns before anyone spends credits on it.

### Scene and script — `core/prompts/videoPrompt.js`

Two different inputs. `dialogue` is what she SAYS; `scene` is what is SEEN —
where it happens and what she does. The scene's action sentences become timed
beats inside the shots ("she holds it up at 3s" → a beat at 0:03) and its
descriptive sentences become the setting, unless a location preset was chosen,
in which case they read as DIRECTION instead.

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

## Credits

Generations cost credits, bought in packs through RevenueCat (`react-native-purchases`). The
server owns every number (backend/README.md "Credits"); the app only shows them and starts
purchases.

| Piece | Where |
|---|---|
| Store, SDK, purchase | `core/platform/purchases.native.js` (web: a stand-in) — the only file that touches the SDK |
| Balance, prices, packs (from `GET /api/billing/me`) | `core/data/billing.js` (a tiny shared store) + `useCredits` |
| What is shown, in what order, what a generation costs | `core/billing/packs.js` — plain logic with tests: `npm test` |
| "Not enough credits" (402 `INSUFFICIENT_CREDITS`) | announced once from `providers/kie.js` → `core/billing/outOfCredits.js` → one alert with a way to the Credits screen (`useBilling`) |
| The screen, the header chip, the cost line before Generate | `CreditsScreen`, `CreditsChip` (navigation), `CostNote` |
| The packs the store offers, and buying one (shared by every screen that sells) | `src/hooks/usePackStore.js` |
| The first-time offer: when it opens, what a pack is said to give | `core/billing/offer.js` (tests), `useOfferPacks`, `GetCreditsScreen`, `ChoosePackScreen` |

- **The app never grants credits.** The store tells RevenueCat, RevenueCat tells the server, the
  server adds them. After a purchase the Credits screen *waits for the balance to rise*
  (`waitForCredits`); nothing it does could add one.
- **RevenueCat is always told OUR account id** (`logIn(userId)`), never an anonymous one — a
  purchase on an id the server does not know cannot be credited. `logOut` is never called.
- **Keys:** `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY` (`goog_…`) for real builds;
  `EXPO_PUBLIC_REVENUECAT_TEST_KEY` (`test_…`, simulated purchases) only in a dev build — the SDK
  crashes a release build that holds it, and `__DEV__` keeps it out of one. Both are public values.
- **Credits are shown only when they matter** (`creditsVisible`): charging is on, the account holds
  or owes some, or it is a dev build. While the server is only watching, nobody sees "0 credits".
- **The offer is an offer, not a gate.** The design's two payment screens sell a subscription plan; this
  app sells packs (one payment, credits never expire), so they are re-skinned: `GetCreditsScreen` (the
  smallest pack, Continue, "See all packs") and `ChoosePackScreen` (a chip per pack, what the pack gives,
  Continue). `useOfferPacks` opens the first ONCE per install, to an account with no credits, where credits
  are visible and the build can sell (`shouldOfferPacks`); Skip and Back leave it. Do not add Monthly /
  Yearly or "Save 20%" — there is nothing to repeat and no discount the numbers back.
- Adding the SDK needed a native rebuild (`npx expo run:android`); JS reload alone is not enough.

## The splash, the icon and the brand marks

The design (Figma, right-hand light flow) opens with two splash frames: the mark alone, then the mark
with "influenza AI". They are played in two halves that hand over to each other:

- **The phone's own launch screen** — the mark on white, set in `app.json` by the `expo-splash-screen`
  plugin (`assets/splash-icon.png`). It needs a native build (`expo prebuild` / `eas build`) to change.
- **`src/components/SplashOverlay.js`** — drawn over the app by `navigation/index.js`: the mark in the same
  place, then the wordmark, held long enough to be seen and faded away once the session is known. It calls
  `SplashScreen.hideAsync()` on its first frame; `App.js` keeps the system's one up until then.

The launcher icon (`assets/icon.png`, the adaptive foreground/monochrome) is the same mark. They were
Expo's template images before. The mark's geometry lives in `src/components/brand.js`
(and as `assets/brand/logo-mark.svg`); the PNGs are renders of it. Replace them with the designer's own export
when it exists. The Play listing's 512 px icon is `dist/play-store/icon-512.png` (not committed).

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

## Message boxes, the cost note and "Saved to Gallery"

- **Never use React Native's own `Alert`.** `import { Alert } from '../lib/dialog'` — the same
  `Alert.alert(title, message, buttons, options)` call, drawn by `DialogHost` as the app's own
  card (icon by tone, stacked buttons, Light and Dark). `showDialog({...})` is for one that wants
  more (an icon of its own, a table of `facts`). One at a time, the same words twice shown once;
  the system alert is only the fallback when no host is mounted. The pure rules are
  `core/ui/dialogModel.js`.
- **"Not enough credits"** is `showDialog` with `outOfCreditsDialog` (`core/billing/shortfall.js`):
  what it needs, what you have, how short. `CostNote` uses the same `creditShortfall`, so the card
  above Generate and the dialog never disagree.
- **A result filed in a gallery announces itself.** The store emits `emitGalleryAdded` for every
  entry newly added (`core/store.jsx` `showInGallery`: a screen's own result, one collected from
  the Queue, one the worker saved); `GalleryToastHost` shows "Video saved to Gallery" with the
  picture and a View button, and the influencer's Gallery tab carries a pulsing count until opened
  (`PulseBadge`). Nothing is announced about the gallery the person is looking at. Rules and tests:
  `core/notices/galleryNotice.js`. A screen that files results must go through `addGeneration`
  (never write `generationHistory`) or none of this happens.
- **Test tooling:** `uiautomator dump` returns nothing while anything animates forever (the badge's
  pulse), so a script driving the emulator taps by position while a badge is showing.

## Legal pages inside the app

Google Play's User Data policy asks for the privacy policy in Play Console **and** "a privacy policy link
or text within the app itself". The pages live on the website (separate project, `influenza-site`:
`/privacy/`, `/terms/`, `/support/`, `/delete-account/`); the app only links to them.

- The address table is `core/config/legal.js` (`SITE_BASE`, `legalUrl(id)`), tested in `legal.test.js`.
  If the site moves to its own domain, change `SITE_BASE` there and the URLs in Play Console.
- `openLegal(id)` (`src/lib/openLegal.js`) hands the address to the phone's browser; with no browser it
  shows the "Could not open the page" box with the address instead of doing nothing.
- Where: Settings → About (Privacy Policy, Terms of Use, Help and support), and `LegalNote` ("By … you
  agree to the Terms of Use and Privacy Policy") on the welcome and sign-up screens. Deleting an account is
  in Settings and on the website (`/delete-account/`), as Play also requires.
- The home-screen name comes from `app.json` `name` ("InfluenzaAi", the same as the Play listing); the
  `android/` folder is gitignored and rebuilt from it by EAS. Do not change `slug` or the package.

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
- **Don't add credits (or trust a balance) in the app**, and never configure RevenueCat with an anonymous id.

## Known gaps (real, unfixed)

- Image generation **cannot be cancelled** — `generateThreeImages` takes no
  `isCancelled`.
- `GalleryTab` instantiates one `expo-video` player per tile; heavy with a large
  history.
- `pickImageWithPrompt` may never resolve if the Android alert is dismissed by
  tapping outside.
- Studio settings with no UI: `aspect`, `outputs`, `envCustom`, `voiceCustom`,
  `additionalNotes` (the Scene field covers what `additionalNotes` was for).
- Files the create wizard stored for an influencer that was never saved belong to
  no influencer, so nothing sweeps them until the account is deleted.
- A job removed on one device stays on another until that device reloads the
  queue — the change feed reports updates, not deletions.
