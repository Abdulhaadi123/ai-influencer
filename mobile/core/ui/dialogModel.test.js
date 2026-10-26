// The dialogs: how a system-alert call becomes one, which look it gets, and the queue.
// Run with:  node --test core/ui

import test from 'node:test'
import assert from 'node:assert/strict'

import { actionsFrom, toneFor, isDismissable, dialogFromAlert, createDialogQueue } from './dialogModel.js'

const kinds = actions => actions.map(a => `${a.label}:${a.kind}`)

// ── Buttons ──────────────────────────────────────────────────────────────────

test('no buttons is one OK', () => {
  for (const none of [undefined, null, [], 'x', 5, {}]) assert.deepEqual(kinds(actionsFrom(none)), ['OK:primary'])
})

test('Cancel goes last whatever order it was given in, and the first plain button is the main one', () => {
  assert.deepEqual(kinds(actionsFrom([{ text: 'Not now', style: 'cancel' }, { text: 'Get credits' }])), ['Get credits:primary', 'Not now:cancel'])
  assert.deepEqual(kinds(actionsFrom([{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive' }])), ['Delete:danger', 'Cancel:cancel'])
})

test('a second plain button is the quieter choice; the picker\'s three-way choice keeps its order', () => {
  assert.deepEqual(
    kinds(actionsFrom([{ text: 'Take photo' }, { text: 'Choose from library' }, { text: 'Cancel', style: 'cancel' }])),
    ['Take photo:primary', 'Choose from library:secondary', 'Cancel:cancel'],
  )
})

test('a button with no text is OK, and what it does is kept', () => {
  const onPress = () => {}
  const [a] = actionsFrom([{ onPress }, null].filter(Boolean))
  assert.equal(a.label, 'OK')
  assert.equal(a.onPress, onPress)
  assert.equal(actionsFrom([{ text: '   ' }])[0].label, 'OK')
})

// ── Look ─────────────────────────────────────────────────────────────────────

test('a destructive button makes it a warning about something that cannot be undone', () => {
  assert.equal(toneFor('Remove from queue?', [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive' }]), 'danger')
  assert.equal(toneFor('Sign out', [{ text: 'Sign out', style: 'destructive' }]), 'danger')
})

test('the titles the app really uses get the look they should', () => {
  const warning = ['Regeneration failed', 'Unable to save', 'Could not send your report', 'Not saved', 'Not available', 'Camera access required', 'Photo access required']
  const success = ['Saved', 'Password updated', 'Account deleted', 'Thank you', 'Credits added']
  const info = ['Add image', 'Sign in', '']
  for (const t of warning) assert.equal(toneFor(t), 'warning', t)
  for (const t of success) assert.equal(toneFor(t), 'success', t)
  for (const t of info) assert.equal(toneFor(t), 'info', t)
})

test('a failure outranks a success word in the same title ("Not saved")', () => {
  assert.equal(toneFor('Not saved'), 'warning')
  assert.equal(toneFor('Could not be saved'), 'warning')
})

test('a dialog can be closed from outside unless the call said it must be answered', () => {
  assert.equal(isDismissable(undefined), true)
  assert.equal(isDismissable({}), true)
  assert.equal(isDismissable({ cancelable: true }), true)
  assert.equal(isDismissable({ cancelable: false }), false)
})

// ── A system-alert call ──────────────────────────────────────────────────────

test('Alert.alert(title, message, buttons, options) becomes one description', () => {
  const onDone = () => {}
  const d = dialogFromAlert('Credits added', 'Your balance has risen.', [{ text: 'OK', onPress: onDone }], { cancelable: false })
  assert.equal(d.tone, 'success')
  assert.equal(d.title, 'Credits added')
  assert.equal(d.message, 'Your balance has risen.')
  assert.equal(d.dismissable, false)
  assert.deepEqual(kinds(d.actions), ['OK:primary'])
  assert.equal(d.actions[0].onPress, onDone)
})

test('a call with only a title, or a message that is not text, has no message line', () => {
  assert.equal(dialogFromAlert('Add image', undefined, []).message, undefined)
  assert.equal(dialogFromAlert('Add image', null, []).message, undefined)
  assert.equal(dialogFromAlert('Add image', '', []).message, undefined)
  assert.equal(dialogFromAlert(undefined, 'x').title, '')
})

// ── The queue ────────────────────────────────────────────────────────────────

const dlg = (title, message) => ({ tone: 'info', title, message, actions: actionsFrom(), dismissable: true })

test('one at a time, in order, and the next appears when one is closed', () => {
  const q = createDialogQueue()
  assert.equal(q.push(dlg('A')), 'shown')
  assert.equal(q.push(dlg('B')), 'queued')
  assert.equal(q.push(dlg('C')), 'queued')
  assert.equal(q.current.title, 'A')
  assert.equal(q.waiting, 2)
  assert.equal(q.close().title, 'B')
  assert.equal(q.close().title, 'C')
  assert.equal(q.close(), null)
  assert.equal(q.current, null)
  assert.equal(q.close(), null, 'closing with nothing open is harmless')
})

test('the same box twice is shown once: three images refused at once give one "Not enough credits"', () => {
  const q = createDialogQueue()
  assert.equal(q.push(dlg('Not enough credits', 'Get a credit pack')), 'shown')
  assert.equal(q.push(dlg('Not enough credits', 'Get a credit pack')), 'dropped')
  assert.equal(q.push(dlg('Other')), 'queued')
  assert.equal(q.push(dlg('Other')), 'dropped', 'also when it is waiting')
  assert.equal(q.waiting, 1)
})

test('once it has been closed the same box can be shown again', () => {
  const q = createDialogQueue()
  q.push(dlg('A', 'x'))
  q.close()
  assert.equal(q.push(dlg('A', 'x')), 'shown')
})

test('boxes with the same title but different words are different boxes', () => {
  const q = createDialogQueue()
  q.push(dlg('Unable to save', 'No connection.'))
  assert.equal(q.push(dlg('Unable to save', 'The name is too long.')), 'queued')
})
