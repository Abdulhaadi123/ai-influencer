/**
 * Keep the roster's signed media URLs from expiring on screen.
 *
 * Every image and video URL is a presigned link that stops working ten minutes
 * after it was signed. This re-signs the ones close to expiry on a timer while
 * signed in, and straight away on returning to the foreground — the moment they
 * are most likely to have died, since timers do not run in the background.
 */

import { useEffect } from 'react'
import { AppState } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { useInfluencers } from '@core/store'
import { URL_REFRESH_INTERVAL_MS } from '@core/data/assets'

export function useAssetUrlRefresh() {
  const { isSignedIn } = useAuth()
  const { refreshUrls } = useInfluencers()

  useEffect(() => {
    if (!isSignedIn) return

    const run = () => {
      refreshUrls().catch(e => console.warn('[urls] refresh failed:', e?.message ?? e))
    }

    const id = setInterval(run, URL_REFRESH_INTERVAL_MS)
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') run()
    })

    return () => {
      clearInterval(id)
      sub.remove()
    }
  }, [isSignedIn, refreshUrls])
}
