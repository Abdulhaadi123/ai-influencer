/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Dialogs — one message box for the whole app, drawn by the app.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every message box used to be the system alert: a grey Android box over a page that looks nothing
 * like the app, the same for "Remove from queue?" as for "Not enough credits". They are drawn by
 * DialogHost (components/DialogHost.js) now, mounted once above the navigator, in the app's own
 * card — with an icon for what kind of message it is, an optional table of figures, and buttons
 * stacked the way the rest of the app stacks them.
 *
 *   • `Alert.alert(title, message, buttons, options)` is the system alert's own call, unchanged,
 *     so a screen switches by changing one import — it is the whole migration.
 *   • `showDialog({...})` is for a dialog that wants more than that: an icon of its own, facts.
 *
 * One dialog at a time, the rest in turn; the same words twice are shown once
 * (core/ui/dialogModel.js). With no host mounted — the splash, a crash early in start-up — the
 * system alert is used, so a message is never lost.
 */

import { Alert as SystemAlert } from 'react-native'

import { createDialogQueue, dialogFromAlert } from '@core/ui/dialogModel'

const queue = createDialogQueue()
const listeners = new Set()
const notify = () => { for (const l of [...listeners]) l() }

/** For DialogHost: hear about changes, and read the dialog on screen (the same object until it changes). */
export const subscribeDialogs = listener => { listeners.add(listener); return () => listeners.delete(listener) }
export const currentDialog = () => queue.current

/** Close the dialog on screen; the next one, if any, takes its place. */
export function closeDialog() {
  queue.close()
  notify()
}

/** The system alert, for when nothing is mounted to draw the real one. */
function systemFallback(dialog) {
  const lines = [dialog.message, ...(dialog.facts || []).map(f => `${f.label}: ${f.value}`)].filter(Boolean).join('\n')
  const styleOf = { cancel: 'cancel', danger: 'destructive' }
  SystemAlert.alert(
    dialog.title,
    lines || undefined,
    dialog.actions.map(a => ({ text: a.label, style: styleOf[a.kind] || 'default', onPress: a.onPress })),
    { cancelable: dialog.dismissable, onDismiss: dialog.onDismiss },
  )
}

/**
 * @param {import('@core/ui/dialogModel').Dialog & {icon?: string}} dialog
 */
export function showDialog(dialog) {
  if (listeners.size === 0) { systemFallback(dialog); return }
  if (queue.push(dialog) !== 'dropped') notify()
}

/** The system alert's call, answered by the app's own dialog. */
export const Alert = {
  alert(title, message, buttons, options) {
    showDialog(dialogFromAlert(title, message, buttons, options))
  },
}
