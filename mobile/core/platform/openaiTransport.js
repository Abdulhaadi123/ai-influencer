/**
 * OpenAI transport — WEB implementation.
 *
 * The browser must not hold the key, so the web build has no prompt assistant.
 * Returning null lets callers treat the feature as simply unavailable.
 */
export function hasOpenAiKey() { return false }

export function openAiFetch() {
  return Promise.reject(new Error('The prompt assistant is not available on web.'))
}
