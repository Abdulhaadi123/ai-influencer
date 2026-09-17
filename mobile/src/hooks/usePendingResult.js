/**
 * Wait for a generation that outlived the screen's own polling.
 *
 * When foreground polling gives up (STILL_RUNNING) the job carries on, and
 * something else moves its queue row forward — the app-wide sync, or the
 * server's worker. Every change to this user's jobs triggers a check, and one
 * that arrives mid-check runs again afterwards, so the update that finishes
 * the job is never dropped.
 *
 * Without this a slow image could only be saved from the Queue tab, which files
 * it in the gallery — not as the influencer's image or reference sheet the user
 * was generating — and people paid for a second generation instead.
 *
 * Stops on its own once the result is ready or failed; callers clear `taskId`
 * in the callbacks.
 */

import { useEffect, useRef } from 'react'

import { useAuth } from '@core/auth/AuthContext'
import { subscribe as subscribeToJobs } from '@core/data/jobs'
import { checkPendingResult } from '@core/pendingResult'

/**
 * @param {string|null} taskId  the job to wait on; null waits on nothing
 * @param {object} opts
 * @param {'image'|'video'} [opts.kind]
 * @param {string|null} [opts.influencerId]  files the stored result under this influencer
 * @param {(result: {assetId: string, url: string|null}) => void} opts.onReady
 * @param {(message: string) => void} opts.onFailed
 */
export function usePendingResult(taskId, { kind = 'image', influencerId = null, onReady, onFailed }) {
  const { userId } = useAuth()

  // The latest callbacks, without restarting the watch every time the parent renders.
  const handlers = useRef({ onReady, onFailed })
  useEffect(() => { handlers.current = { onReady, onFailed } })

  useEffect(() => {
    if (!taskId || !userId) return
    let stopped = false
    let running = false
    let again = false

    const check = async () => {
      if (stopped) return
      if (running) { again = true; return }
      running = true
      try {
        const result = await checkPendingResult(taskId, { kind, influencerId })
        if (stopped) return
        if (result.status === 'failed') {
          stopped = true
          handlers.current.onFailed?.(result.message)
        } else if (result.status === 'ready') {
          stopped = true
          handlers.current.onReady?.({ assetId: result.assetId, url: result.url })
        }
      } catch (e) {
        console.warn('[pending] could not check the job:', e?.message ?? e)
      } finally {
        running = false
        if (again && !stopped) { again = false; check() }
      }
    }

    check()
    const unsubscribe = subscribeToJobs(userId, check)
    return () => { stopped = true; unsubscribe() }
  }, [taskId, userId, kind, influencerId])
}
