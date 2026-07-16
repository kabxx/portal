import test from 'node:test'
import assert from 'node:assert/strict'

import {
  KEYBINDING_ACTIONS,
  createDefaultKeybindings,
  createKeybindingSnapshot,
  normalizeInputEvent,
  parseKeybindingConfig,
  resolveKeybindingAction,
} from '../../src/keybindings/keybinding-config.ts'

test('platform defaults use the native newline convention plus Ctrl+J', () => {
  assert.deepEqual(createDefaultKeybindings('win32')['input.newline'], [
    'shift+enter',
    'ctrl+j',
  ])
  assert.deepEqual(createDefaultKeybindings('linux')['input.newline'], [
    'shift+enter',
    'ctrl+j',
  ])
  assert.deepEqual(createDefaultKeybindings('darwin')['input.newline'], [
    'alt+enter',
    'ctrl+j',
  ])
})

test('partial configs merge defaults and normalize case and modifier order', () => {
  const config = parseKeybindingConfig(
    { 'input.newline': ['SHIFT+CTRL+Enter'] },
    'linux'
  )

  assert.deepEqual(config['input.newline'], ['ctrl+shift+enter'])
  assert.deepEqual(config['app.interrupt'], ['ctrl+c'])
  assert.deepEqual(Object.keys(config), [...KEYBINDING_ACTIONS])
})

test('empty arrays unbind optional actions but submit remains mandatory', () => {
  assert.deepEqual(
    parseKeybindingConfig({ 'input.complete': [] })['input.complete'],
    []
  )
  assert.throws(
    () => parseKeybindingConfig({ 'input.submit': [] }),
    /input\.submit must contain at least one key/
  )
})

test('invalid actions, keys, duplicates, conflicts, chords, and printable keys fail', () => {
  assert.throws(
    () => parseKeybindingConfig({ 'input.unknown': ['ctrl+x'] }),
    /Unsupported keybinding actions/
  )
  assert.throws(
    () => parseKeybindingConfig({ 'input.complete': ['f1'] }),
    /Unknown key/
  )
  assert.throws(
    () => parseKeybindingConfig({ 'input.complete': ['ctrl+x', 'CTRL+X'] }),
    /Duplicate keybinding/
  )
  assert.throws(
    () => parseKeybindingConfig({ 'input.complete': ['ctrl+c'] }),
    /assigned to both app\.interrupt and input\.complete/
  )
  assert.throws(
    () => parseKeybindingConfig({ 'input.complete': ['ctrl+k ctrl+c'] }),
    /chords and whitespace are not supported/
  )
  assert.throws(
    () => parseKeybindingConfig({ 'input.complete': ['x'] }),
    /Unmodified printable keys are not supported/
  )
  assert.throws(
    () => parseKeybindingConfig({ 'input.complete': ['space'] }),
    /Unmodified printable keys are not supported/
  )
  assert.deepEqual(
    parseKeybindingConfig({ 'input.complete': ['ctrl+space'] })[
      'input.complete'
    ],
    ['ctrl+space']
  )
})

test('legacy and structured Ctrl+J resolve to the same action before Enter', () => {
  const snapshot = createKeybindingSnapshot(createDefaultKeybindings('win32'))

  assert.equal(resolveKeybindingAction(snapshot, '\n', {}), 'input.newline')
  assert.equal(
    resolveKeybindingAction(snapshot, '\n', { ctrl: true }),
    'input.newline'
  )
  assert.equal(
    resolveKeybindingAction(snapshot, 'j', { ctrl: true }),
    'input.newline'
  )
  assert.equal(
    resolveKeybindingAction(snapshot, '\r', { return: true }),
    'input.submit'
  )
})

test('modified Enter, release, repeat, and multi-character events normalize safely', () => {
  assert.equal(
    normalizeInputEvent('', { return: true, shift: true }),
    'shift+enter'
  )
  assert.equal(
    normalizeInputEvent('', { return: true, meta: true }),
    'alt+enter'
  )
  assert.equal(
    normalizeInputEvent('x', { ctrl: true, eventType: 'repeat' }),
    'ctrl+x'
  )
  assert.equal(
    normalizeInputEvent('x', { ctrl: true, eventType: 'release' }),
    null
  )
  assert.equal(normalizeInputEvent('pasted text', {}), null)
})

test('event resolution uses exact modifiers and covers every default action', () => {
  const snapshot = createKeybindingSnapshot(createDefaultKeybindings('linux'))
  const events = [
    ['app.interrupt', 'c', { ctrl: true }],
    ['app.exit', 'd', { ctrl: true }],
    ['input.submit', '', { return: true }],
    ['input.newline', '', { return: true, shift: true }],
    ['input.complete', '', { tab: true }],
    ['input.clear', 'u', { ctrl: true }],
    ['input.deleteWordBackward', 'w', { ctrl: true }],
    ['input.deleteBackward', '', { backspace: true }],
    ['input.deleteForward', '', { delete: true }],
    ['input.lineStart', '', { home: true }],
    ['input.lineEnd', '', { end: true }],
    ['input.moveLeft', '', { leftArrow: true }],
    ['input.moveRight', '', { rightArrow: true }],
    ['input.moveUp', '', { upArrow: true }],
    ['input.moveDown', '', { downArrow: true }],
  ] as const

  for (const [action, input, key] of events) {
    assert.equal(resolveKeybindingAction(snapshot, input, key), action)
  }
  assert.equal(
    resolveKeybindingAction(snapshot, '', { return: true, ctrl: true }),
    null
  )
})
