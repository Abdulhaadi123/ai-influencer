/**
 * An image from our storage (or a generator's result link), cached by WHAT it is, not by its URL.
 *
 * Every stored file is shown through a presigned URL that is re-signed every few minutes, and a
 * re-signed URL is a different string. React Native's <Image> caches by URL, so each refresh looked
 * like a new picture and the full file — a 2K PNG is several megabytes — was downloaded again,
 * on every screen, for as long as the app was open. That is most of why images "took forever".
 *
 * expo-image takes a `cacheKey` separate from the URL. Here it is the asset id (core/data/assets.js
 * assetIdForUrl), which never changes, so a picture is fetched once and then comes from memory or
 * disk, through any number of re-signs and across launches. A URL with no asset behind it (a
 * generator's result link, shown before it is stored) is cached by its own URL, which is stable.
 *
 * The disk cache is cleared on sign-out (navigation/index.js), so nothing one person generated is
 * left on the device for the next.
 */

import { useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { Image } from 'expo-image'

import { assetIdForUrl, isThumbUrl } from '@core/data/assets'
import { isServable } from '../lib/seedMedia'

/**
 * expo-image's source for a media URL, or null when it cannot be shown. A file's small preview has a
 * key of its own (`asset:<id>:thumb`), so a grid's preview and the full picture opened from it are
 * never mistaken for each other in the cache.
 */
export function mediaImageSource(uri) {
  if (!isServable(uri)) return null
  const assetId = assetIdForUrl(uri)
  if (!assetId) return { uri }
  return { uri, cacheKey: isThumbUrl(uri) ? `asset:${assetId}:thumb` : `asset:${assetId}` }
}

/**
 * @param {{uri: string|null|undefined, style?: any, contentFit?: 'cover'|'contain'|'fill'|'none'|'scale-down',
 *          transition?: number, loadingIndicator?: boolean, accessibilityLabel?: string}} props
 *        loadingIndicator  show a spinner until the first frame arrives — for a big picture the
 *                          person is waiting on (a blank frame looked like a failure)
 */
export default function MediaImage({ uri, style, contentFit = 'cover', transition = 150, loadingIndicator = false, ...rest }) {
  const source = mediaImageSource(uri)
  const key = source ? source.cacheKey ?? source.uri : null
  // Which picture has loaded — not a boolean, so a different picture shows the spinner again
  // while a re-signed URL for the same one does not.
  const [loadedKey, setLoadedKey] = useState(null)

  if (!source) return <View style={style} />

  const image = (
    <Image
      source={source}
      style={loadingIndicator ? StyleSheet.absoluteFill : style}
      contentFit={contentFit}
      cachePolicy="memory-disk"
      // Re-signing changes the URL but not the picture; keyed on the asset, the view is reused
      // instead of fading the same image in again.
      recyclingKey={key}
      transition={transition}
      onLoad={loadingIndicator ? () => setLoadedKey(key) : undefined}
      onError={loadingIndicator ? () => setLoadedKey(key) : undefined}
      {...rest}
    />
  )
  if (!loadingIndicator) return image

  return (
    <View style={[style, styles.frame]}>
      {image}
      {loadedKey === key ? null : (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <ActivityIndicator color="#FFFFFF" />
        </View>
      )}
    </View>
  )
}

/** Forget every cached picture — on sign-out, so the next person on this device starts clean. */
export function clearMediaImageCache() {
  Image.clearMemoryCache().catch(() => {})
  Image.clearDiskCache().catch(() => {})
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center' },
})
