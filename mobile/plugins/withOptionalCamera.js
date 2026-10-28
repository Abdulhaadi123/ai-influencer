/**
 * Expo config plugin: the camera is optional.
 *
 * The app asks for the CAMERA permission (expo-image-picker, to take a reference photo), and a manifest
 * that asks for it without saying more is read by Google Play as "this app needs a camera, with
 * autofocus": the implied features android.hardware.camera and android.hardware.camera.autofocus are
 * REQUIRED unless declared otherwise (developer.android.com/guide/topics/manifest/uses-feature-element).
 * Play then hides the app from every device without them — tablets with only a front camera, Chromebooks,
 * TVs, some cheaper phones — and counted fewer supported devices than the app needs to exclude. A photo
 * can always be chosen from the library instead, so nothing in the app needs the camera to exist.
 *
 * Explicit declarations win over implied ones, so this adds both with `required="false"`.
 */

const { withAndroidManifest } = require('expo/config-plugins')

const FEATURES = ['android.hardware.camera', 'android.hardware.camera.autofocus']

module.exports = function withOptionalCamera(config) {
  return withAndroidManifest(config, mod => {
    const manifest = mod.modResults.manifest
    const declared = manifest['uses-feature'] ?? (manifest['uses-feature'] = [])

    for (const name of FEATURES) {
      const existing = declared.find(f => f.$?.['android:name'] === name)
      if (existing) existing.$['android:required'] = 'false'
      else declared.push({ $: { 'android:name': name, 'android:required': 'false' } })
    }
    return mod
  })
}
