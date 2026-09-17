/**
 * Keep the queue current app-wide, not just while the Queue tab is open.
 *
 * Without this, the tab badge lies. Starting a video and then navigating away
 * kills the studio screen's own polling (it cancels on unmount), so nothing
 * asks KIE anything until the user happens to open the Queue tab — and the
 * badge sits on "1 running" for a job that finished ten minutes ago. Someone
 * who walked away is exactly the person the badge exists for, so it has to be
 * right without being visited.
 *
 * Deliberately slow. The Queue screen polls every 8s because someone is
 * watching it; this runs in the background behind whatever screen the user is
 * on, so it trades latency for battery and rate-limit headroom. A finished job
 * shows up within half a minute, which is well inside the time it takes to
 * notice a badge.
 *
 * Also refreshes the moment the app returns to the foreground: that is when
 * the stored state is most likely stale, because nothing polls while the app
 * is backgrounded.
 */

import { useEffect } from 'react'
import { AppState } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'

import { syncActiveJobs } from '../lib/queueSync'

const DEFAULT_INTERVAL_MS = 30000

export function useQueueSync(intervalMs = DEFAULT_INTERVAL_MS) {
  const { isSignedIn } = useAuth()

  useEffect(() => {
    // Every call here reads the user's rows and hits our authenticated API, so
    // there is nothing to do — and nothing it is allowed to do — while signed
    // out. Without this guard a signed-out app would fire a 401 every 30s.
    if (!isSignedIn) return

    syncActiveJobs()

    const id = setInterval(() => { syncActiveJobs() }, intervalMs)

    // Timers are throttled or stopped while backgrounded, so coming back is
    // its own trigger rather than something the interval can be relied on for.
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') syncActiveJobs()
    })

    return () => {
      clearInterval(id)
      sub.remove()
    }
  }, [intervalMs, isSignedIn])
}
