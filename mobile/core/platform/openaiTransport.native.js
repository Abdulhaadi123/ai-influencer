/**
 * OpenAI transport — REACT NATIVE implementation.
 *
 * Calls api.openai.com directly, like the KIE transport. Same trade, same
 * warning: EXPO_PUBLIC_* is inlined into the bundle at build time, so this key
 * ships inside the app and can be extracted from the .apk. Use a key with a
 * spending limit set, and rotate it if a build ever leaves your control.
 *
 * The feature is optional by design — with no key set, hasOpenAiKey() returns
 * false and the suggestion UI never appears.
 */

const API_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY || ''

export function hasOpenAiKey() {
  return API_KEY.length > 0
}

/**
 * @param {object} body    chat/completions request body
 * @param {AbortSignal} [signal]  so a stale request can be cancelled mid-flight
 */
export function openAiFetch(body, signal) {
  if (!API_KEY) return Promise.reject(new Error('No OpenAI key configured.'))

  return fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
}
