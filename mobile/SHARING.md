# Getting the app to someone else

Right now the app only runs against a Metro dev server on one machine, over
the local network. That is fine for developing, but it means the app dies the
moment that machine sleeps, and it cannot leave the Wi-Fi. To hand the app to
somebody, build it.

## Android — an .apk they can install (free)

1. Make an Expo account at https://expo.dev (free), then:

       npm install -g eas-cli
       eas login

2. Give the build the API key. `mobile/.env` is gitignored, so EAS never
   uploads it — it has to be stored as a build secret instead:

       eas secret:create --scope project --name EXPO_PUBLIC_KIE_API_KEY --value "<the key from mobile/.env>"

3. Build:

       cd mobile
       eas build --platform android --profile preview

   It builds in Expo's cloud (no Android Studio needed) and finishes with a
   download link plus a QR. Send that link. They open it on their phone, tap
   the .apk, and allow installing from an unknown source.

## iOS — harder, and it costs money

iOS will not install an app from a link. It needs either TestFlight or a
registered device, and both require an **Apple Developer Program membership
($99/year)**. With one:

       eas build --platform ios --profile preview
       eas submit --platform ios          # then invite them in TestFlight

Without a paid Apple account there is no way to put this on someone's iPhone.
If your senior is on iPhone and you do not have that membership, the options
are: they run Expo Go against your dev server while on your network, or you
share the Android build instead.

## Before you share: the key ships inside the build

`EXPO_PUBLIC_KIE_API_KEY` is compiled into the bundle, so anyone who has the
.apk can extract it and spend that KIE account's credits. Sharing it with the
person who owns the key is fine. Do not post the build anywhere public, and if
it does leak, rotate the key at kie.ai and rebuild.

## Updating them later

Once someone has a build installed, small JS changes can be pushed without a
reinstall:

    eas update --branch preview

Native changes (a new Expo module, permissions, the app icon) still need a
fresh build.
