# Getting the app onto phones

Expo Go is a dead end for this project: it only runs the SDK version the app
stores currently ship, and it needs a Metro dev server on the same network.
A **build** removes both problems — it is a real, standalone app that anyone
can install, works on mobile data, and keeps working when this machine is off.

Everything below runs from the `mobile/` folder.

---

## Android — a `.apk` anyone can install (free)

**1. Make a free Expo account** at https://expo.dev, then log in:

```bash
npx eas-cli login
```

**2. Tell the build where the backend is.**

`mobile/.env` is gitignored, so EAS never uploads it. The app needs one value —
the backend's address — set as an EAS environment variable for the profile you
build with. It is not a secret; no key of any kind goes into the app.

```bash
npx eas-cli env:create --name EXPO_PUBLIC_API_BASE --value "https://api.your-domain.com" --environment preview --visibility plaintext
```

Without it the build installs fine and opens on a "Not configured" screen.

**3. Build it:**

```bash
npx eas-cli build --profile preview --platform android
```

First run asks a couple of setup questions (creating the project on your
account, generating a keystore) — accept the defaults. The build runs on
Expo's servers and takes roughly 10–20 minutes.

**4. Share it.** You get a URL like `https://expo.dev/accounts/.../builds/...`
with a **Download** button. Send that link to anyone. They open it on their
Android phone, download the `.apk`, and install it.

Android will warn about installing outside the Play Store — that is normal for
a direct `.apk`; they tap through it.

---

## iPhone — needs a paid Apple account

This is the honest part: **Apple does not allow installing apps outside the App
Store without a paid Apple Developer account ($99/year).** There is no free
equivalent of the Android `.apk` route.

With an Apple Developer account:

```bash
npx eas-cli build --profile preview --platform ios
```

then distribute through **TestFlight**, which handles up to 10,000 testers:

```bash
npx eas-cli submit --platform ios
```

Without a paid account, the options for iPhone are Expo Go (blocked by the SDK
mismatch) or a simulator on a Mac. Android is the practical route today.

---

## What the build already has configured

- **`preview` profile** in `eas.json` → a plain `.apk` for Android, internal
  distribution for iOS. No app store involved.
- **Permissions**, in `app.json`. These matter only in a real build — Expo Go
  supplies its own, which is why the app worked there without them:
  - `CAMERA`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `INTERNET`
  - iOS `NSCameraUsageDescription` / `NSPhotoLibraryUsageDescription`, written
    by the `expo-image-picker` plugin
- **A backend is required.** Accounts, data, files and generation all go
  through `backend/`, which must be deployed and reachable at
  `EXPO_PUBLIC_API_BASE` — see `backend/README.md`.

Verified by running `expo prebuild` locally and reading the generated
`AndroidManifest.xml`.

---

## Updating a build

Changing JS only? Rebuild and resend the link — or set up EAS Update to push
changes to installed apps without a new build.

Changing `app.json`, permissions, or native dependencies always needs a fresh
build.

---

## Security note

The app contains no API key, database credential or storage key — only the
backend's address. Everything else is behind sign-in on the server, so a build
link can be shared without handing anyone the account's credits.
