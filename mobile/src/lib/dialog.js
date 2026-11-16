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
 *
 * ── On an iPhone it is the system alert ──────────────────────────────────────
 *
 * A Modal on iOS is a screen presented by the one beneath it, and a screen that is already
 * presenting one cannot present a second. DialogHost is a Modal mounted next to the navigator, so
 * while any other Modal is up (the gallery viewer, the outfit sheet, Settings' dialogs, the report
 * sheet) its card would never appear, and the queue would wait for ever for an answer to a box
 * nobody can see: "Delete?" in the gallery viewer, "Use as main image?" in the outfit sheet. The
 * system alert is drawn in a window of its own, above everything, and runs a button's action only
 * once it has gone, so a picker or share sheet opened from one has room to appear. The queue and its
 * rules stay the same; only the drawing differs (a fact table becomes lines of the message).
 */

import { Alert as SystemAlert, Platform } from 'react-native'

import { createDialogQueue, dialogFromAlert } from '@core/ui/dialogModel'

/** Whether DialogHost draws the dialogs (Android), or the system alert does (iPhone; see above). */
export const DRAWS_OWN_DIALOGS = Platform.OS !== 'ios'

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

/**
 * A dialog as the system alert. `answered`, if given, runs once when it is closed — by a button
 * (before that button's own action, as DialogHost does) or, on Android, by a tap outside.
 */
function systemAlert(dialog, answered) {
  const lines = [dialog.message, ...(dialog.facts || []).map(f => `${f.label}: ${f.value}`)].filter(Boolean).join('\n')
  const styleOf = { cancel: 'cancel', danger: 'destructive' }
  let closed = false
  const close = () => { if (!closed) { closed = true; answered?.() } }
  SystemAlert.alert(
    dialog.title,
    lines || undefined,
    dialog.actions.map(a => ({ text: a.label, style: styleOf[a.kind] || 'default', onPress: () => { close(); a.onPress?.() } })),
    { cancelable: dialog.dismissable, onDismiss: () => { close(); dialog.onDismiss?.() } },
  )
}

/** iPhone: the dialog at the head of the queue, as the system alert; the next one once it is answered. */
let onScreen = null
function presentHead() {
  const dialog = queue.current
  if (!dialog || dialog === onScreen) return
  onScreen = dialog
  systemAlert(dialog, () => {
    onScreen = null
    queue.close()
    presentHead()
  })
}

/**
 * @param {import('@core/ui/dialogModel').Dialog & {icon?: string}} dialog
 */
export function showDialog(dialog) {
  if (!DRAWS_OWN_DIALOGS) {
    if (queue.push(dialog) === 'shown') presentHead()
    return
  }
  if (listeners.size === 0) { systemAlert(dialog); return }
  if (queue.push(dialog) !== 'dropped') notify()
}

/** The system alert's call, answered by the app's own dialog. */
export const Alert = {
  alert(title, message, buttons, options) {
    showDialog(dialogFromAlert(title, message, buttons, options))
  },
}
