/**
 * Live prompt suggestion, debounced.
 *
 * Watches what the user is typing and asks the prompt assistant for a stronger
 * version. It never touches the user's text — the caller decides what to do
 * with the suggestion.
 *
 * Three things matter here and all of them are about not being annoying or
 * expensive:
 *   • DEBOUNCE — a request per keystroke would be costly and rate-limited, so
 *     it waits until typing pauses.
 *   • CANCEL — typing again aborts the in-flight request, so a slow earlier
 *     response can never overwrite a newer one.
 *   • CACHE — the same text is never sent twice, which matters when the user
 *     edits and undoes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { improvePrompt, isAvailable, MIN_LENGTH } from '@core/services/promptAssist'

const DEBOUNCE_MS = 900

export function usePromptSuggestion(text, kind = 'appearance') {
  const [suggestion, setSuggestion] = useState(null)
  const [loading, setLoading] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const cacheRef = useRef(new Map())
  const abortRef = useRef(null)
  const timerRef = useRef(null)

  const available = isAvailable()
  const trimmed = (text || '').trim()

  // A fresh edit means an old dismissal no longer applies.
  useEffect(() => { setDismissed(false) }, [trimmed])

  useEffect(() => {
    if (!available || trimmed.length < MIN_LENGTH) {
      setSuggestion(null)
      setLoading(false)
      return
    }

    const cached = cacheRef.current.get(trimmed)
    if (cached !== undefined) {
      setSuggestion(cached)
      setLoading(false)
      return
    }

    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setLoading(true)
      try {
        const result = await improvePrompt(trimmed, { kind, signal: controller.signal })
        if (controller.signal.aborted) return
        cacheRef.current.set(trimmed, result)
        setSuggestion(result)
      } catch (e) {
        if (e?.name !== 'AbortError') {
          // A failing assistant must never block writing a prompt, so this is
          // logged and the UI simply shows nothing.
          console.warn('[promptAssist]', e?.message ?? e)
          setSuggestion(null)
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(timerRef.current)
  }, [trimmed, kind, available])

  // Abort anything in flight when the screen goes away.
  useEffect(() => () => {
    clearTimeout(timerRef.current)
    abortRef.current?.abort()
  }, [])

  const dismiss = useCallback(() => setDismissed(true), [])

  return {
    suggestion: dismissed ? null : suggestion,
    loading: loading && !dismissed,
    dismiss,
    available,
  }
}
