/**
 * Image picking — a native capability with no web counterpart.
 *
 * The web app uses <input type="file">; on a phone the user expects a choice
 * between the photo library and the camera. This lives in the mobile app rather
 * than in core/platform because core has no caller for it — the web wizard has
 * its own file input.
 *
 * Returns a base64 data URL (already compressed) so it slots straight into the
 * shared generation pipeline, which uploads base64 to KIE.
 */

import * as ImagePicker from 'expo-image-picker'
import { Alert } from 'react-native'
import { compressImage } from '@core/platform/media'

const PICKER_OPTIONS = {
  mediaTypes: ['images'],
  allowsEditing: false,
  quality: 1, // compress ourselves, via the shared media module
}

/**
 * @param {'library'|'camera'} source
 * @returns {Promise<string|null>} data URL, or null if cancelled / denied
 */
export async function pickImage(source = 'library') {
  try {
    if (source === 'camera') {
      const { granted } = await ImagePicker.requestCameraPermissionsAsync()
      if (!granted) {
        Alert.alert('Camera access needed', 'Allow camera access to take a reference photo.')
        return null
      }
    } else {
      const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (!granted) {
        Alert.alert('Photo access needed', 'Allow photo access to choose a reference image.')
        return null
      }
    }

    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync(PICKER_OPTIONS)
      : await ImagePicker.launchImageLibraryAsync(PICKER_OPTIONS)

    if (result.canceled || !result.assets?.length) return null

    return await compressImage(result.assets[0].uri)
  } catch (e) {
    console.warn('[pickImage] failed:', e?.message ?? e)
    Alert.alert('Could not load image', e?.message ?? 'Please try again.')
    return null
  }
}

/** Ask which source to use, then pick. Cancelling resolves to null. */
export function pickImageWithPrompt() {
  return new Promise(resolve => {
    Alert.alert('Add a reference image', undefined, [
      { text: 'Take photo', onPress: () => resolve(pickImage('camera')) },
      { text: 'Choose from library', onPress: () => resolve(pickImage('library')) },
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
    ])
  })
}
