/**
 * Live prompt suggestion, debounced.
 *
 * Watches what the user is typing and asks the prompt assistant for a stronger
 * version. It never touches the user's text — the caller decides what to do
 * with the suggestion.
 *
 * Four things matter here and all of them are about not being annoying or
 * expensive:
 *   • DEBOUNCE — a request per keystroke would be costly and rate-limited, so
 *     it waits until typing pauses.
 *   • CANCEL — typing again aborts the in-flight request, so a slow earlier
 *     response can never overwrite a newer one.
 *   • CACHE — the same text is never sent twice, which matters when the user
 *     edits and undoes.
 *   • IGNORE — text the user did not write is not worth a request. Two cases
 *     produced one each, so a single edit could cost two calls:
 *
 *       Accepting a suggestion replaces the field with the suggestion, which
 *       looked like a fresh edit and sent the model its own output to improve.
 *
 *       A field restored from storage (the studio's saved script and scene)
 *       arrives after mount, which looked like typing and fired a request for
 *       text the user had not touched — on merely opening the tab.
 *
 *     Callers pass both through `ignore()`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { improvePrompt, isAvailable, MIN_LENGTH } from '@core/services/promptAssist'

import { nextAction, CLEAR, SHOW } from './promptSuggestionPolicy'

const DEBOUNCE_MS = 900

export function usePromptSuggestion(text, kind = 'appearance') {
  const [suggestion, setSuggestion] = useState(null)
  const [loading, setLoading] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const cacheRef = useRef(new Map())
  const abortRef = useRef(null)
  const timerRef = useRef(null)
  /** Text this hook must not send: accepted suggestions, and restored values. */
  const ignoredRef = useRef(null)
  ignoredRef.current ??= new Set()

  const available = isAvailable()
  const trimmed = (text || '').trim()

  // A fresh edit means an old dismissal no longer applies.
  useEffect(() => { setDismissed(false) }, [trimmed])

  useEffect(() => {
    const decision = nextAction({
      text: trimmed,
      available,
      minLength: MIN_LENGTH,
      ignored: ignoredRef.current.has(trimmed),
      cached: cacheRef.current.get(trimmed),
    })

    if (decision.action === CLEAR) {
      setSuggestion(null)
      setLoading(false)
      return
    }
    if (decision.action === SHOW) {
      setSuggestion(decision.suggestion)
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

  /**
   * "This text did not come from the user, so do not offer to improve it."
   *
   * Call it with a suggestion as it is accepted, and with a value restored from
   * storage as it arrives. Safe to call with anything, including undefined.
   */
  const ignore = useCallback(value => {
    const t = (value || '').trim()
    if (!t) return
    ignoredRef.current.add(t)
    // A pending request for this exact text is no longer wanted.
    clearTimeout(timerRef.current)
    abortRef.current?.abort()
    setSuggestion(null)
    setLoading(false)
  }, [])

  return {
    suggestion: dismissed ? null : suggestion,
    loading: loading && !dismissed,
    dismiss,
    ignore,
    available,
  }
}
