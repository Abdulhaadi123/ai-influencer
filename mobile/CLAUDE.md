@AGENTS.md

# Mobile app (React Native / Expo)

The React Native port of AI Influencer Studio. The web app in `../src` keeps
working and is unaffected by anything here.

## The shared core — read this first

Business logic is NOT duplicated. It lives once in `../src/core` and both apps
import it. In this app it is reachable through the `@core` alias:

```js
import { useInfluencers } from '@core/store'
import { generateVideo } from '@core/services/generation'
import { IMAGE_MODEL_ID } from '@core/config/generation'
```

The alias is wired in `metro.config.js`, which also:
- adds `../src/core` to `watchFolders` (Metro only watches its own root),
- forces `react` / `react-native` to resolve from THIS app. The repo root has
  its own node_modules with React 18 for the Vite app; without that rule a
  file under `../src/core` would pull in the root's React and you would get
  "invalid hook call" from two Reacts being loaded.

**Never copy logic out of `@core` into this app.** If something in core is
web-coupled, fix it behind `core/platform/` instead — that is what the
boundary is for.

## The platform boundary

`../src/core/platform/` holds one file per capability, in two variants:

| Capability | Web | Native |
|---|---|---|
| storage | `storage.js` (localStorage) | `storage.native.js` (MMKV) |
| API base URL | `apiUrl.js` (relative) | `apiUrl.native.js` (absolute) |
| app reload | `app.js` | `app.native.js` (expo-updates) |
| media | `media.js` (canvas) | *not yet ported* |

Metro picks `.native.js` automatically — never import one directly.

Storage is deliberately **synchronous** on both platforms (MMKV, not
AsyncStorage) because the app reads storage inside `useState` initialisers.
Do not "fix" it to be async.

## Backend

There are no API keys in this app. It calls the same `/api/*` proxy the web
app uses, and that proxy attaches the server-side KIE key. The base URL comes
from `EXPO_PUBLIC_API_BASE`, falling back to `extra.apiBase` in `app.json`.

## Running it

```bash
npx expo start          # dev server
npx expo run:android    # development build (required — see below)
```

`react-native-mmkv` is a native module, so **Expo Go will not work** — the app
needs a development build.
