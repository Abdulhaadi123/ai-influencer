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

**2. Give the build the API key.**

`mobile/.env` is gitignored, so EAS never uploads it. The key has to be stored
as a build secret instead — this keeps it out of the repo:

```bash
npx eas-cli secret:create --scope project --name EXPO_PUBLIC_KIE_API_KEY --value "PASTE_THE_KEY_FROM_mobile/.env"
```

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
- **No backend.** The app calls `api.kie.ai` directly, so nothing needs
  deploying and no server has to stay up.

Verified by running `expo prebuild` locally and reading the generated
`AndroidManifest.xml`.

---

## Updating a build

Changing JS only? Rebuild and resend the link — or set up EAS Update to push
changes to installed apps without a new build.

Changing `app.json`, permissions, or native dependencies always needs a fresh
build.

---

## Security note, before you send that link to anyone

The KIE API key is compiled **into** the app. Anyone who installs the `.apk`
can extract it and spend the account's credits, and revoking it means rotating
the key and shipping a new build.

That is fine for handing to colleagues. Do not post the build link publicly.
