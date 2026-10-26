/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The app's dialogs — what one is, and the rules for showing several.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The pure half of src/lib/dialog.js and src/components/DialogHost.js: no React, no native
 * modules, so it is checked on its own (dialogModel.test.js).
 *
 * Every message box in the app used to be the system alert — a grey Android box over a page
 * that looks nothing like it. They are all drawn by the app now, from the same description:
 * a tone (which picks the icon and colour), a title, a line, optionally a few labelled
 * facts, and actions. `Alert.alert(title, message, buttons, options)` still works as it did,
 * and is turned into that description here.
 */

/** @typedef {'info'|'success'|'warning'|'danger'} Tone */
/** @typedef {'primary'|'secondary'|'danger'|'cancel'} ActionKind */
/** @typedef {{label: string, kind: ActionKind, onPress?: () => void}} Action */
/** @typedef {{label: string, value: string, emphasis?: boolean}} Fact */
/**
 * @typedef {object} Dialog
 * @property {Tone} tone
 * @property {string} title
 * @property {string} [message]
 * @property {Fact[]} [facts]
 * @property {Action[]} actions
 * @property {boolean} dismissable  closes on the back button and a tap outside
 * @property {() => void} [onDismiss]
 */

/**
 * The system alert's buttons ({text, style, onPress}) as actions.
 *
 * With none given there is one "OK". The order is the order given, with Cancel moved last: the
 * dialog stacks its buttons, and the way out belongs at the bottom. The first plain button is the
 * main one; a destructive one is drawn as a warning; any further plain one is a quieter choice.
 *
 * @param {Array<{text?: string, style?: 'default'|'cancel'|'destructive', onPress?: () => void}>|undefined} buttons
 * @returns {Action[]}
 */
export function actionsFrom(buttons) {
  const given = Array.isArray(buttons) && buttons.length ? buttons : [{ text: 'OK' }]
  let main = false
  const make = b => {
    const label = typeof b?.text === 'string' && b.text.trim() ? b.text : 'OK'
    if (b?.style === 'cancel') return { label, kind: 'cancel', onPress: b.onPress }
    if (b?.style === 'destructive') return { label, kind: 'danger', onPress: b.onPress }
    const kind = main ? 'secondary' : 'primary'
    main = true
    return { label, kind, onPress: b?.onPress }
  }
  const made = given.map(make)
  return [...made.filter(a => a.kind !== 'cancel'), ...made.filter(a => a.kind === 'cancel')]
}

const WARNING_TITLE = /\b(fail(ed|ure)?|could not|couldn'?t|unable|not saved|not available|error|refused|required|denied)\b/i
const SUCCESS_TITLE = /\b(saved|updated|deleted|added|thank you|sent|done|changed|removed)\b/i

/**
 * Which look a system-alert call gets, from what it says: a destructive button is a warning
 * about something that cannot be undone, a title about a failure is a warning, one about
 * something done is a success. Anything else is plain information.
 *
 * @returns {Tone}
 */
export function toneFor(title, buttons) {
  if (Array.isArray(buttons) && buttons.some(b => b?.style === 'destructive')) return 'danger'
  const t = String(title || '')
  if (WARNING_TITLE.test(t)) return 'warning'
  if (SUCCESS_TITLE.test(t)) return 'success'
  return 'info'
}

/**
 * Closing on the back button or a tap outside is the default — it is what people do to a box
 * they have read. A call that says `cancelable: false` is one that must be answered.
 */
export function isDismissable(options) {
  return options?.cancelable !== false
}

/**
 * `Alert.alert(title, message, buttons, options)` as a dialog.
 *
 * @returns {Dialog}
 */
export function dialogFromAlert(title, message, buttons, options) {
  return {
    tone: toneFor(title, buttons),
    title: String(title ?? ''),
    message: typeof message === 'string' && message ? message : undefined,
    actions: actionsFrom(buttons),
    dismissable: isDismissable(options),
    onDismiss: typeof options?.onDismiss === 'function' ? options.onDismiss : undefined,
  }
}

const keyOf = d => `${d.title}\n${d.message ?? ''}`

/**
 * One dialog at a time, the rest waiting their turn.
 *
 * A dialog that says exactly what the one on screen (or one already waiting) says is dropped:
 * a screen that raises the same box twice — three images refused at once, a failed save
 * retried — must not leave the person pressing OK three times.
 */
export function createDialogQueue() {
  /** @type {Dialog|null} */
  let current = null
  /** @type {Dialog[]} */
  const waiting = []

  return {
    /** @returns {'shown'|'queued'|'dropped'} */
    push(dialog) {
      const key = keyOf(dialog)
      if ((current && keyOf(current) === key) || waiting.some(d => keyOf(d) === key)) return 'dropped'
      if (!current) { current = dialog; return 'shown' }
      waiting.push(dialog)
      return 'queued'
    },
    /** Closes the one on screen; returns the one that takes its place, if any. */
    close() {
      current = waiting.shift() ?? null
      return current
    },
    /** The one on screen. */
    get current() { return current },
    /** How many are waiting behind it. */
    get waiting() { return waiting.length },
  }
}
