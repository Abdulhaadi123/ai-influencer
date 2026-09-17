/**
 * Showing a failure as an alert.
 *
 * Every screen goes through here so the wording comes from one place
 * (userMessage in @core/errors) and two habits are handled once:
 *
 *   • The same alert is not stacked. Editing a field while offline saves on
 *     change, and each failed save used to raise its own identical alert.
 *   • An ended session is not shown at all. The auth provider signs out and the
 *     sign-in screen explains; an alert on top would say it twice.
 */

import { Alert } from 'react-native'

import { userMessage, isSessionEnded } from '@core/errors'

const REPEAT_WINDOW_MS = 4000
const lastShown = new Map()

/**
 * @param {string} title     what was being attempted ("Could not save")
 * @param {unknown} error
 * @param {string} fallback  for an error that carries nothing worth reading
 */
export function showError(title, error, fallback) {
  if (isSessionEnded(error)) return

  const message = userMessage(error, fallback)
  const key = `${title}\n${message}`
  const now = Date.now()
  if (now - (lastShown.get(key) || 0) < REPEAT_WINDOW_MS) return
  lastShown.set(key, now)

  Alert.alert(title, message)
}
