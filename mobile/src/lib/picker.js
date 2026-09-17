/**
 * Media picking — a native capability with no web counterpart.
 *
 * The web app uses <input type="file"> and a drag-and-drop zone; on a phone the
 * user expects the photo library or the camera. This lives in the mobile app
 * rather than core/platform because core has no caller for it — the web screens
 * have their own file inputs.
 *
 * Both pickers return a base64 data URL so the result slots straight into the
 * shared generation pipeline, which uploads base64 to KIE.
 */

import * as ImagePicker from 'expo-image-picker'
import { File } from 'expo-file-system'
import { Alert } from 'react-native'
import { compressImage } from '@core/platform/media'

import { showError } from './alerts'

/** Matches the web studio's guard so both platforms reject the same files. */
export const MAX_VIDEO_BYTES = 60 * 1024 * 1024

async function ensurePermission(source) {
  if (source === 'camera') {
    const { granted } = await ImagePicker.requestCameraPermissionsAsync()
    if (!granted) Alert.alert('Camera access needed', 'Allow camera access to continue.')
    return granted
  }
  const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!granted) Alert.alert('Photo access needed', 'Allow photo access to continue.')
  return granted
}

/**
 * @param {'library'|'camera'} source
 * @returns {Promise<string|null>} compressed data URL, or null if cancelled
 */
export async function pickImage(source = 'library') {
  try {
    if (!(await ensurePermission(source))) return null

    const options = { mediaTypes: ['images'], allowsEditing: false, quality: 1 }
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options)

    if (result.canceled || !result.assets?.length) return null

    // Compress through the SHARED media module, same as the web app.
    return await compressImage(result.assets[0].uri)
  } catch (e) {
    console.warn('[picker] image failed:', e?.message ?? e)
    showError('Could not load image', e, 'That image could not be opened. Try a different one.')
    return null
  }
}

/** Ask camera-or-library, then pick. Cancelling resolves to null. */
export function pickImageWithPrompt() {
  return new Promise(resolve => {
    Alert.alert('Add an image', undefined, [
      { text: 'Take photo', onPress: () => resolve(pickImage('camera')) },
      { text: 'Choose from library', onPress: () => resolve(pickImage('library')) },
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
    ])
  })
}

/**
 * Pick a motion/driving video.
 *
 * Returns the file URI rather than a data URL. Base64-encoding a 60 MB video
 * inflates it to ~80 MB of JavaScript string, which on a mid-range Android
 * phone is enough to be killed by the OS — and it was pure waste, because the
 * uploader streams the file natively.
 *
 * @returns {Promise<{uri: string, name: string, size: number, contentType: string}|null>}
 * @throws {Error} with a user-facing message when the video is too large
 */
export async function pickVideo() {
  if (!(await ensurePermission('library'))) return null

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    allowsEditing: false,
    quality: 1,
  })
  if (result.canceled || !result.assets?.length) return null

  const asset = result.assets[0]
  const file = new File(asset.uri)

  const size = file.size ?? 0
  if (size > MAX_VIDEO_BYTES) {
    throw new Error(
      `Video is ${(size / 1024 / 1024).toFixed(0)} MB — over the 60 MB limit. Please trim or compress it first.`
    )
  }

  return {
    uri: asset.uri,
    name: asset.fileName || uriBasename(asset.uri),
    size,
    contentType: mimeForUri(asset.uri),
  }
}

function mimeForUri(uri) {
  const ext = (uri.split('.').pop() || '').toLowerCase()
  if (ext === 'mov') return 'video/quicktime'
  if (ext === 'webm') return 'video/webm'
  // An MP4 container. Labelled video/x-m4v it was refused by the server, which
  // only stores the types in its allow-list.
  if (ext === 'm4v') return 'video/mp4'
  return 'video/mp4'
}

function uriBasename(uri) {
  return (uri.split('/').pop() || 'video.mp4').split('?')[0]
}
