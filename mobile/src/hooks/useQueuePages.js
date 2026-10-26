/**
 * The Queue's jobs, a page at a time.
 *
 * The Queue used to fetch the newest sixty jobs, all of them again on every
 * change, and draw every one at once; older jobs could not be reached at all.
 * Now it holds what has been scrolled to, page by page, and keeps it current:
 *
 *  - The first page comes with the account's totals (`summary`), which one page
 *    cannot count — "3 in progress" must not mean "3 of the 20 loaded".
 *  - Scrolling near the end fetches the next page and adds it under the rest.
 *  - A change from the server's change feed updates the row held for that job at
 *    once, and soon after the first page is fetched again and merged on top:
 *    that is how a new job appears, and how the totals move. Pages scrolled to
 *    stay (core/data/paging.js mergeHead).
 *  - Pull to refresh, Clear completed, or a different account start over.
 *
 * Every answer is checked against what was asked: one that arrives after a
 * start-over, or after a newer refresh of the top, is dropped. At most one
 * "next page" is on its way at any moment, whatever asks for it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { listJobsPage, toApp, subscribe as subscribeToJobs } from '@core/data/jobs'
import { appendPage, mergeHead, replaceRow } from '@core/data/paging'
import { userMessage } from '@core/errors'

/** Changes come in bursts (a batch of jobs finishing); one refresh of the top answers a burst. */
const HEAD_REFRESH_DELAY_MS = 400

const EMPTY = { rows: [], hasMore: false, summary: null }

export function useQueuePages(userId) {
  const [list, setList] = useState(EMPTY)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(null)

  const current = useRef(EMPTY)
  const update = useCallback(change => setList(prev => {
    const next = change(prev)
    current.current = next
    return next
  }), [])

  // Bumped by every start-over: an answer to a request sent before it is dropped.
  const epoch = useRef(0)
  // The newest refresh of the top that was sent; an older one's answer is dropped.
  const headSeq = useRef(0)
  const moreInFlight = useRef(false)
  const headTimer = useRef(null)

  const cancelHeadRefresh = useCallback(() => {
    if (headTimer.current) { clearTimeout(headTimer.current); headTimer.current = null }
  }, [])

  /** The first page again, replacing everything held. */
  const reset = useCallback(async () => {
    const mine = ++epoch.current
    headSeq.current++
    cancelHeadRefresh()
    try {
      const page = await listJobsPage({ summary: true })
      if (mine !== epoch.current) return
      update(() => ({ rows: page.jobs, hasMore: page.hasMore, summary: page.summary }))
      setLoadError(null)
      setMoreError(null)
    } catch (e) {
      if (mine === epoch.current) setLoadError(userMessage(e, 'The queue could not be loaded. Please try again.'))
    } finally {
      if (mine === epoch.current) setLoading(false)
    }
  }, [update, cancelHeadRefresh])

  /** The first page again, merged on top of what is held. */
  const refreshHead = useCallback(async () => {
    const mine = epoch.current
    const seq = ++headSeq.current
    try {
      const page = await listJobsPage({ summary: true })
      if (mine !== epoch.current || seq !== headSeq.current) return
      update(prev => {
        const merged = mergeHead(prev.rows, prev.hasMore, { rows: page.jobs, hasMore: page.hasMore })
        return { rows: merged.rows, hasMore: merged.hasMore, summary: page.summary ?? prev.summary }
      })
      setLoadError(null)
    } catch (e) {
      if (mine === epoch.current && seq === headSeq.current) {
        setLoadError(userMessage(e, 'The queue could not be loaded. Please try again.'))
      }
    }
  }, [update])

  const scheduleHeadRefresh = useCallback(() => {
    if (headTimer.current) return
    headTimer.current = setTimeout(() => {
      headTimer.current = null
      refreshHead()
    }, HEAD_REFRESH_DELAY_MS)
  }, [refreshHead])

  /** The next page, under what is held. Does nothing while one is on its way or there is no more. */
  const loadMore = useCallback(async () => {
    const { rows, hasMore } = current.current
    const cursor = rows.at(-1)?.cursor
    if (moreInFlight.current || !hasMore || !cursor) return
    moreInFlight.current = true
    const mine = epoch.current
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await listJobsPage({ cursor })
      if (mine !== epoch.current) return
      // Only where it was asked for: if the list no longer ends there, the page belongs nowhere.
      update(prev => (prev.rows.at(-1)?.cursor !== cursor ? prev
        : { ...prev, rows: appendPage(prev.rows, page.jobs), hasMore: page.hasMore }))
    } catch (e) {
      if (mine === epoch.current) setMoreError(userMessage(e, 'More could not be loaded. Please try again.'))
    } finally {
      moreInFlight.current = false
      setLoadingMore(false)
    }
  }, [update])

  /** A job removed here: gone from the list now, and the totals follow. */
  const removeRow = useCallback(id => {
    update(prev => ({ ...prev, rows: prev.rows.filter(r => r.id !== id) }))
    refreshHead()
  }, [update, refreshHead])

  // Start over for each account, and listen for changes while signed in.
  useEffect(() => {
    epoch.current++
    cancelHeadRefresh()
    update(() => EMPTY)
    setLoadError(null)
    setMoreError(null)
    if (!userId) { setLoading(false); return undefined }

    setLoading(true)
    reset()
    const unsubscribe = subscribeToJobs(userId, payload => {
      if (payload?.new?.id) update(prev => ({ ...prev, rows: replaceRow(prev.rows, toApp(payload.new)) }))
      scheduleHeadRefresh()
    })
    return () => {
      unsubscribe()
      epoch.current++
      cancelHeadRefresh()
    }
  }, [userId, reset, update, scheduleHeadRefresh, cancelHeadRefresh])

  return {
    jobs: list.rows,
    hasMore: list.hasMore,
    summary: list.summary,
    loading,
    loadError,
    loadingMore,
    moreError,
    reset,
    refreshHead,
    loadMore,
    removeRow,
  }
}
