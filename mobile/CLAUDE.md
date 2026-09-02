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
| storage | `storage.js` (localStorage) | `storage.native.js` (expo-sqlite/kv-store) |
| KIE transport | `kieTransport.js` (via `/api/kie` proxy) | `kieTransport.native.js` (direct to api.kie.ai) |
| OpenAI transport | `openaiTransport.js` (disabled) | `openaiTransport.native.js` (direct) |
| media | `media.js` (canvas + `<a download>`) | `media.native.js` (expo-image-manipulator / expo-sharing) |
| persist media | `persistMedia.js` (passthrough) | `persistMedia.native.js` (downloads to documents dir) |

`apiUrl.js` has **no** native variant — it is imported only by the two
web-only modules above. There is no `app.js` / `app.native.js`.

Storage is deliberately **synchronous** on both platforms — expo-sqlite's
`getItemSync`/`setItemSync`, not AsyncStorage — because the app reads storage
inside `useState` initialisers. Do not "fix" it to be async.

## Backend: there isn't one

This app calls **`api.kie.ai` directly**. There is no proxy in front of it and
nothing to deploy.

The key comes from `EXPO_PUBLIC_KIE_API_KEY` in `mobile/.env`, and Expo
inlines `EXPO_PUBLIC_*` variables into the JS bundle at build time — so **the
key ships inside the .apk/.ipa** and can be extracted by anyone who unpacks
it. Revoking it means rotating the key AND shipping a new build. See
`SHARING.md`. `EXPO_PUBLIC_OPENAI_API_KEY` (optional, powers the prompt
suggestions) carries the same warning.

Note that `metro.config.js` forces the *direct* transport on
`expo start --web` too, so a web export of THIS app would put the key in a
browser bundle. That target is for debugging only.

## Generation

```
screen  →  @core/services/generation      (facade — import from HERE only)
             └─ providers/kie.js           (the only provider)
                  └─ api.kie.ai            (bundled key)
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

### The generation queue — `core/jobQueue.js`

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
| Webhooks exist via `callBackUrl` | Unusable — needs a public HTTPS endpoint, and there is no backend |
| 20 creates / 10 s; 429 on excess | `refreshJobs` walks jobs serially; polls back off exponentially |
| `progress` is sora2-only | Progress bars stay synthetic |

**A slow job is not a failed job.** When foreground polling stops watching it
throws `STILL_RUNNING`, which every screen renders as "still generating, see
the Queue tab" — never as an error. Do not collapse that back into a generic
catch.

## Running it

```bash
npx expo start          # then press `a` for a booted Android emulator
npx expo run:android    # native build; needs ANDROID_HOME and a booted device
```

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

## Known gaps (real, unfixed)

- No way to **delete** or **rename** an influencer.
- Image generation **cannot be cancelled** — `CreateScreen`'s `cancelledRef`
  is never set true and `generateThreeImages` takes no `isCancelled`.
- `GalleryTab` instantiates one `expo-video` player per tile; heavy with a
  large history.
- `pickImageWithPrompt` never resolves if the Android alert is dismissed by
  tapping outside.
- The queue refreshes only while the app is **open** — every 30s app-wide via
  `useQueueSync`, every 8s on the Queue tab itself, and on foreground. There
  is no background fetch or push notification, so a job that finishes while
  the app is closed is only noticed on next launch. Real push would need a
  development build and a backend.
- Studio settings with no UI: `aspect`, `outputs`, `envCustom`, `voiceCustom`,
  `additionalNotes`.
