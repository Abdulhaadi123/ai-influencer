/**
 * Whether a share is being prepared right now, and how far along it is.
 *
 * One share at a time, app-wide: Share is a button on six screens, and it used to be tapped again and again
 * while the first was still downloading with nothing on screen to say it had started. lib/share.js sets this;
 * ShareStatusHost draws it. (core/media/shareProgress.js has the words.)
 */

import { useSyncExternalStore } from 'react'

/** @typedef {{active: boolean, progress: {bytesWritten: number, totalBytes: number}|null, cancel: (() => void)|null}} ShareStatus */

/** @type {ShareStatus} */
const IDLE = Object.freeze({ active: false, progress: null, cancel: null })
let state = IDLE
const listeners = new Set()

const set = next => { state = next; listeners.forEach(l => l()) }

export const shareStatus = {
  get: () => state,
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },

  /** A share began. `cancel` stops its download. */
  start(cancel) { set({ active: true, progress: null, cancel }) },
  /** Bytes so far, as the download reports them. */
  progress(progress) { if (state.active) set({ ...state, progress }) },
  /** It is over (the sheet opened, it failed, or it was cancelled). */
  stop() { if (state.active) set(IDLE) },
}

export function useShareStatus() {
  return useSyncExternalStore(shareStatus.subscribe, shareStatus.get)
}
