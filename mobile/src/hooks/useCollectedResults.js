/**
 * Show results the server's worker collected while the app was open.
 *
 * A screen that saves its own result files the gallery entry itself. The
 * worker collects the rest — typically a job the app saw finish and then
 * stopped watching — and those would otherwise stay out of the gallery until
 * the next full reload.
 *
 * The signal is the queue row gaining an asset. The worker writes the gallery
 * row a moment after that, so the lookup retries briefly before giving up; if
 * the entry is already on screen, adopting it is a no-op.
 *
 * This hook is mounted for the whole signed-in session, so it is also where the
 * app tells the change poller (core/data/jobs.js) when it goes to the background
 * and comes back: a backgrounded app asks the server nothing.
 */

import { useEffect } from 'react'
import { AppState } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { useInfluencers } from '@core/store'
import { subscribe, setPollingPaused } from '@core/data/jobs'

const RETRY_DELAYS_MS = [500, 3000, 8000]

export function useCollectedResults() {
  const { userId } = useAuth()
  const { adoptGeneration } = useInfluencers()

  useEffect(() => {
    if (!userId) return
    const timers = new Set()

    // Each stored result is looked up once while this is mounted.
    const seen = new Set()

    const unsubscribe = subscribe(userId, payload => {
      const row = payload?.new
      // Keyed on the row HAVING an asset, not on it changing from none: the
      // table keeps its default replica identity (migration 0003), so an UPDATE
      // event carries no previous values to compare against.
      if (payload?.eventType !== 'UPDATE' || !row?.asset_id || !row.influencer_id) return
      if (seen.has(row.asset_id)) return
      seen.add(row.asset_id)

      let attempt = 0
      const schedule = () => {
        const timer = setTimeout(async () => {
          timers.delete(timer)
          const found = await adoptGeneration({ influencerId: row.influencer_id, assetId: row.asset_id })
            .catch(() => false)
          attempt += 1
          if (!found && attempt < RETRY_DELAYS_MS.length) schedule()
        }, RETRY_DELAYS_MS[attempt])
        timers.add(timer)
      }
      schedule()
    })

    return () => {
      unsubscribe()
      timers.forEach(clearTimeout)
    }
  }, [userId, adoptGeneration])
}

/** Pause the change poller while the app is not in front; resume (and ask at once) when it is. */
export function usePollingWhileForeground() {
  useEffect(() => {
    setPollingPaused(AppState.currentState !== 'active')
    const sub = AppState.addEventListener('change', state => setPollingPaused(state !== 'active'))
    return () => { sub.remove(); setPollingPaused(false) }
  }, [])
}
