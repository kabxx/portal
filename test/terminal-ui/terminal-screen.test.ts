import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToString, stripAnsiSequences, Text } from '@kabxx/ink'
import { createBuiltinCommandTestRuntime } from '../helpers/builtin-command-runtime.ts'

import {
  INPUT_CURSOR,
  buildLiveFrameSignature,
  buildWelcomeRows,
  calculateBubbleWidth,
  canSubmitInput,
  clearInput,
  completeSlashCommand,
  deleteBackwardAtCursor,
  deleteForwardAtCursor,
  deletePreviousWord,
  estimateDisplayWidth,
  formatInputAroundCursor,
  formatInputAroundCursorWithSyntax,
  formatInputForDisplay,
  insertAtCursor,
  isNewlineKey,
  isSubmitKey,
  moveCursorHorizontal,
  moveCursorToLineBoundary,
  moveCursorVertical,
  normalizePastedInput,
  renderBubbleBody,
  renderTimelineEntryToAnsi,
  resolveTranscriptWriterForOutput,
  wrapAnsiLine,
  resolveInputSyntaxHighlight,
  resolveSubmittedInputValue,
  createTranscriptSyncScheduler,
  shouldClearInputForCtrlC,
  shouldInterruptForKey,
  shouldNavigateInputHistory,
  syncTranscriptAfterRenderFlush,
  truncateMiddleLine,
} from '../../src/terminal-ui/terminal-screen.tsx'
import type { KeyModifiers } from '../../src/terminal-ui/terminal-screen.tsx'
import { TerminalTranscriptWriter } from '../../src/terminal-ui/terminal-transcript-writer.ts'

const commandFixture = createBuiltinCommandTestRuntime()
const COMMAND_SESSION = commandFixture.session
const COMPLETION_SNAPSHOT = commandFixture.completionSnapshot

test.after(async () => await commandFixture.close())

test('interactive Ink output owns the live frame instead of transcript replay', () => {
  const writer = new TerminalTranscriptWriter(() => '')

  assert.equal(resolveTranscriptWriterForOutput(writer, true), null)
  assert.equal(resolveTranscriptWriterForOutput(writer, false), writer)
  assert.equal(resolveTranscriptWriterForOutput(writer, undefined), writer)
})

function key(modifiers: Partial<KeyModifiers> = {}): KeyModifiers {
  return {
    return: false,
    ctrl: false,
    shift: false,
    meta: false,
    ...modifiers,
  }
}

test('transcript sync waits for Ink to flush before writing and committing layout', async () => {
  const flush = Promise.withResolvers<void>()
  const events: string[] = []

  const pending = syncTranscriptAfterRenderFlush({
    waitUntilRenderFlush: async () => {
      events.push('wait')
      await flush.promise
      events.push('flushed')
    },
    isCancelled: () => false,
    sync: () => events.push('sync'),
    commitLayout: () => events.push('commit'),
  })

  await Promise.resolve()
  assert.deepEqual(events, ['wait'])

  flush.resolve()
  assert.equal(await pending, 'synced')
  assert.deepEqual(events, ['wait', 'flushed', 'sync', 'commit'])
})

test('cancelled transcript sync neither writes nor commits its layout', async () => {
  const flush = Promise.withResolvers<void>()
  let cancelled = false
  let writes = 0
  let commits = 0

  const pending = syncTranscriptAfterRenderFlush({
    waitUntilRenderFlush: async () => await flush.promise,
    isCancelled: () => cancelled,
    sync: () => {
      writes += 1
    },
    commitLayout: () => {
      commits += 1
    },
  })

  cancelled = true
  flush.resolve()

  assert.equal(await pending, 'cancelled')
  assert.equal(writes, 0)
  assert.equal(commits, 0)
})

test('transcript sync rejects a live frame that changes before flush', async () => {
  const flush = Promise.withResolvers<void>()
  let liveFrame = 'before'
  let writes = 0
  let commits = 0

  const pending = syncTranscriptAfterRenderFlush({
    waitUntilRenderFlush: async () => await flush.promise,
    isCancelled: () => liveFrame !== 'before',
    sync: () => {
      writes += 1
    },
    commitLayout: () => {
      commits += 1
    },
  })

  liveFrame = 'after'
  flush.resolve()

  assert.equal(await pending, 'cancelled')
  assert.equal(writes, 0)
  assert.equal(commits, 0)
})

test('transcript sync scheduler coalesces live updates and writes the latest request', async () => {
  const firstFlush = Promise.withResolvers<void>()
  const secondFlush = Promise.withResolvers<void>()
  const flushes = [firstFlush.promise, secondFlush.promise]
  const writes: string[] = []
  let waitCount = 0

  const scheduler = createTranscriptSyncScheduler({
    waitUntilRenderFlush: async () => {
      waitCount += 1
      await flushes[waitCount - 1]
    },
    getLiveFrameSignature: () => 'stable',
    sync: (request) => writes.push(request.completedTimeline[0]!.body),
    commitLayout: () => {},
  })

  scheduler.request({
    completedTimeline: [
      { id: 1, tone: 'info', label: '', body: 'old', format: 'plain' },
    ],
    bubbleWidth: 10,
    forceReflow: false,
    layout: { columns: 80, rows: 24 },
    liveFrameSignature: 'stable',
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  scheduler.request({
    completedTimeline: [
      { id: 1, tone: 'info', label: '', body: 'latest', format: 'plain' },
    ],
    bubbleWidth: 10,
    forceReflow: false,
    layout: { columns: 80, rows: 24 },
    liveFrameSignature: 'stable',
  })
  firstFlush.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  secondFlush.resolve()

  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  assert.equal(waitCount, 2)
  assert.deepEqual(writes, ['latest'])
  scheduler.dispose()
})

test('transcript sync scheduler retries when the live frame changes during flush', async () => {
  const firstFlush = Promise.withResolvers<void>()
  const secondFlush = Promise.withResolvers<void>()
  const flushes = [firstFlush.promise, secondFlush.promise]
  const writes: string[] = []
  let liveFrame = 'before'
  let waitCount = 0

  const scheduler = createTranscriptSyncScheduler({
    waitUntilRenderFlush: async () => {
      waitCount += 1
      await flushes[waitCount - 1]
    },
    getLiveFrameSignature: () => liveFrame,
    sync: (request) => writes.push(request.liveFrameSignature),
    commitLayout: () => {},
  })

  scheduler.request({
    completedTimeline: [],
    bubbleWidth: 10,
    forceReflow: false,
    layout: { columns: 80, rows: 24 },
    liveFrameSignature: 'before',
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  liveFrame = 'after'
  scheduler.updateLiveFrame(liveFrame)
  firstFlush.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  secondFlush.resolve()

  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  assert.equal(waitCount, 2)
  assert.deepEqual(writes, ['after'])
  scheduler.dispose()
})

test('live frame updates do not schedule transcript work without a pending request', async () => {
  let waitCount = 0
  const scheduler = createTranscriptSyncScheduler({
    waitUntilRenderFlush: async () => {
      waitCount += 1
    },
    getLiveFrameSignature: () => 'after',
    sync: () => {},
    commitLayout: () => {},
  })

  scheduler.updateLiveFrame('after')
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  assert.equal(waitCount, 0)
  scheduler.dispose()
})

test('transcript sync scheduler preserves full reflow until the latest request commits', async () => {
  const firstFlush = Promise.withResolvers<void>()
  const secondFlush = Promise.withResolvers<void>()
  const flushes = [firstFlush.promise, secondFlush.promise]
  const syncedReflows: boolean[] = []
  const committedLayouts: Array<{ columns: number; rows: number }> = []
  let waitCount = 0

  const scheduler = createTranscriptSyncScheduler({
    waitUntilRenderFlush: async () => {
      waitCount += 1
      await flushes[waitCount - 1]
    },
    getLiveFrameSignature: () => 'stable',
    sync: (request) => syncedReflows.push(request.forceReflow),
    commitLayout: (request) => committedLayouts.push(request.layout),
  })

  scheduler.request({
    completedTimeline: [],
    bubbleWidth: 100,
    forceReflow: true,
    layout: { columns: 100, rows: 30 },
    liveFrameSignature: 'stable',
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 80))
  scheduler.request({
    completedTimeline: [],
    bubbleWidth: 120,
    forceReflow: true,
    layout: { columns: 120, rows: 40 },
    liveFrameSignature: 'stable',
  })

  firstFlush.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  secondFlush.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(syncedReflows, [true])
  assert.deepEqual(committedLayouts, [{ columns: 120, rows: 40 }])
  scheduler.dispose()
})

test('disposed transcript sync scheduler ignores a pending flush', async () => {
  const flush = Promise.withResolvers<void>()
  let writes = 0
  let commits = 0
  const scheduler = createTranscriptSyncScheduler({
    waitUntilRenderFlush: async () => await flush.promise,
    getLiveFrameSignature: () => 'stable',
    sync: () => {
      writes += 1
    },
    commitLayout: () => {
      commits += 1
    },
  })

  scheduler.request({
    completedTimeline: [],
    bubbleWidth: 10,
    forceReflow: false,
    layout: { columns: 80, rows: 24 },
    liveFrameSignature: 'stable',
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  scheduler.dispose()
  flush.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  assert.equal(writes, 0)
  assert.equal(commits, 0)
})

test('transcript sync scheduler drops a request when sync fails', async () => {
  let attempts = 0
  const errors: unknown[] = []
  const scheduler = createTranscriptSyncScheduler({
    waitUntilRenderFlush: async () => {},
    getLiveFrameSignature: () => 'stable',
    sync: () => {
      attempts += 1
      throw new Error('write failed')
    },
    commitLayout: () => {},
    onError: (error) => errors.push(error),
  })

  scheduler.request({
    completedTimeline: [],
    bubbleWidth: 10,
    forceReflow: false,
    layout: { columns: 80, rows: 24 },
    liveFrameSignature: 'stable',
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 10))

  assert.equal(attempts, 1)
  assert.equal(errors.length, 1)
  assert.ok(errors[0] instanceof Error)
  assert.equal(errors[0].message, 'write failed')
  scheduler.dispose()
})

test('transcript sync scheduler reports flush failures and retries new requests', async () => {
  let shouldFail = true
  let waits = 0
  const errors: unknown[] = []
  const scheduler = createTranscriptSyncScheduler({
    waitUntilRenderFlush: async () => {
      waits += 1
      if (shouldFail) throw new Error('flush failed')
    },
    getLiveFrameSignature: () => 'stable',
    sync: () => {},
    commitLayout: () => {},
    onError: (error) => errors.push(error),
  })

  const request = {
    completedTimeline: [],
    bubbleWidth: 10,
    forceReflow: false,
    layout: { columns: 80, rows: 24 },
    liveFrameSignature: 'stable',
  }
  scheduler.request(request)
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  shouldFail = false
  scheduler.request(request)
  await new Promise<void>((resolve) => setTimeout(resolve, 10))

  assert.equal(waits, 2)
  assert.equal(errors.length, 1)
  assert.ok(errors[0] instanceof Error)
  assert.equal(errors[0].message, 'flush failed')
  scheduler.dispose()
})

test('live frame signature changes when input or hints change', () => {
  const base = {
    inputValue: '',
    inputCursor: 0,
    selectedHintCompletion: null,
    prompt: { active: true, label: 'deepseek > ', hint: '' },
    busy: false,
    connectingWelcome: null,
    liveAssistant: null,
    liveCommand: null,
    liveCommandTitle: null,
    inputHintGroup: null,
  } as const

  assert.equal(buildLiveFrameSignature(base), buildLiveFrameSignature(base))
  assert.notEqual(
    buildLiveFrameSignature(base),
    buildLiveFrameSignature({ ...base, inputValue: '/' })
  )
  assert.notEqual(
    buildLiveFrameSignature(base),
    buildLiveFrameSignature({
      ...base,
      inputHintGroup: { title: 'commands', hints: [] },
    })
  )
  assert.notEqual(
    buildLiveFrameSignature(base),
    buildLiveFrameSignature({
      ...base,
      liveCommandTitle: 'spawn · running · 1s',
    })
  )
})

test('isNewlineKey keeps plain Enter as submit', () => {
  assert.equal(isNewlineKey(key({ return: true })), false)
  assert.equal(isSubmitKey(key({ return: true })), true)
})

test('isNewlineKey treats Shift+Enter as newline', () => {
  assert.equal(isNewlineKey(key({ return: true, shift: true })), true)
  assert.equal(isSubmitKey(key({ return: true, shift: true })), false)
})

test('Ctrl+Enter is neither newline nor submit', () => {
  assert.equal(isNewlineKey(key({ return: true, ctrl: true })), false)
  assert.equal(isSubmitKey(key({ return: true, ctrl: true })), false)
})

test('clearInput clears the current input', () => {
  assert.equal(clearInput(), '')
})

test('normalizePastedInput preserves multiline layout with Unix newlines', () => {
  assert.equal(
    normalizePastedInput('first\r\n\r\n\tsecond\rthird'),
    'first\n\n\tsecond\nthird'
  )
})

test('calculateBubbleWidth uses the full terminal width without right margin', () => {
  assert.equal(calculateBubbleWidth(0), 1)
  assert.equal(calculateBubbleWidth(1), 1)
  assert.equal(calculateBubbleWidth(2), 2)
  assert.equal(calculateBubbleWidth(23), 23)
  assert.equal(calculateBubbleWidth(80), 80)
  assert.equal(calculateBubbleWidth(120), 120)
})

test('renderTimelineEntryToAnsi never exceeds the requested width', () => {
  const entry = {
    id: 1,
    tone: 'assistant' as const,
    label: 'assistant',
    body: 'abcdefghij',
    format: 'plain' as const,
  }

  for (const width of [1, 2, 3, 4, 5, 24, 80]) {
    const output = stripAnsiSequences(renderTimelineEntryToAnsi(entry, width))
    for (const line of output.trimEnd().split('\n')) {
      assert.ok(estimateDisplayWidth(line) <= width, `${width}: ${line}`)
    }
  }
})

test('formatInputForDisplay expands tabs without changing line breaks', () => {
  assert.equal(
    formatInputForDisplay('\tfirst\n\nA\tsecond'),
    '    first\n\nA   second'
  )
})

test('formatInputAroundCursor preserves tab columns on both sides', () => {
  assert.deepEqual(formatInputAroundCursor('A\t中B', 2), {
    before: 'A   ',
    cursor: '中',
    after: 'B',
    inverse: true,
  })
  assert.deepEqual(formatInputAroundCursor('A\tB', 1), {
    before: 'A',
    cursor: ' ',
    after: '  B',
    inverse: true,
  })
  assert.deepEqual(formatInputAroundCursor('end', 3), {
    before: 'end',
    cursor: INPUT_CURSOR,
    after: '',
    inverse: false,
  })
  assert.equal(INPUT_CURSOR, '█')
})

test('formatInputAroundCursorWithSyntax preserves highlighting around the cursor', () => {
  const display = formatInputAroundCursorWithSyntax('/thread list', 3, {
    start: 0,
    end: 7,
    kind: 'command',
  })

  assert.deepEqual(display, {
    before: [{ text: '/th', syntax: 'command' }],
    cursor: { text: 'r', syntax: 'command', inverse: true },
    after: [
      { text: 'ead', syntax: 'command' },
      { text: ' list', syntax: null },
    ],
  })
})

test('cursor edits insert and delete at the current grapheme boundary', () => {
  assert.deepEqual(insertAtCursor('ac', 1, '😆'), {
    value: 'a😆c',
    cursor: 3,
  })
  assert.deepEqual(deleteBackwardAtCursor('a😆c', 3), {
    value: 'ac',
    cursor: 1,
  })
  assert.deepEqual(deleteForwardAtCursor('a😆c', 1), {
    value: 'ac',
    cursor: 1,
  })
})

test('horizontal cursor movement does not split grapheme clusters', () => {
  assert.equal(moveCursorHorizontal('a😆c', 3, -1), 1)
  assert.equal(moveCursorHorizontal('a😆c', 1, 1), 3)
  assert.equal(moveCursorHorizontal('a😆c', 0, -1), 0)
  assert.equal(moveCursorHorizontal('a😆c', 4, 1), 4)
})

test('vertical cursor movement follows display columns between lines', () => {
  assert.equal(moveCursorVertical('abcd\nx\nwxyz', 3, 1), 6)
  assert.equal(moveCursorVertical('abcd\nx\nwxyz', 10, -1), 6)
  assert.equal(moveCursorVertical('ab\n中x', 2, 1), 4)
})

test('vertical cursor movement reaches the input boundary from its edge lines', () => {
  const multiline = 'abcd\nx\nwxyz'

  assert.equal(moveCursorVertical(multiline, 3, -1), 0)
  assert.equal(moveCursorVertical(multiline, 0, -1), 0)
  assert.equal(moveCursorVertical(multiline, 9, 1), multiline.length)
  assert.equal(
    moveCursorVertical(multiline, multiline.length, 1),
    multiline.length
  )

  assert.equal(moveCursorVertical('single line', 4, -1), 0)
  assert.equal(moveCursorVertical('single line', 4, 1), 11)
  assert.equal(moveCursorVertical('', 0, -1), 0)
  assert.equal(moveCursorVertical('', 0, 1), 0)
  assert.equal(moveCursorVertical('\nlast', 0, -1), 0)
  assert.equal(moveCursorVertical('first\n', 6, 1), 6)
})

test('vertical cursor movement can preserve a preferred display column', () => {
  const value = 'abcd\nx\nwxyz'
  const shortLineCursor = moveCursorVertical(value, 3, 1)

  assert.equal(shortLineCursor, 6)
  assert.equal(moveCursorVertical(value, shortLineCursor, 1, 3), 10)
})

test('line boundary movement stays within the current logical line', () => {
  const value = 'first\nsecond\nthird'

  assert.equal(moveCursorToLineBoundary(value, 9, 'start'), 6)
  assert.equal(moveCursorToLineBoundary(value, 9, 'end'), 12)
  assert.equal(moveCursorToLineBoundary(value, 5, 'start'), 0)
  assert.equal(moveCursorToLineBoundary(value, 5, 'end'), 5)
})

test('history navigation continues for loaded history until editing starts', () => {
  assert.equal(shouldNavigateInputHistory('', false), true)
  assert.equal(shouldNavigateInputHistory('loaded history', true), true)
  assert.equal(shouldNavigateInputHistory('manual draft', false), false)
})

test('deletePreviousWord deletes the word before the cursor', () => {
  assert.equal(deletePreviousWord('hello world'), 'hello')
  assert.equal(deletePreviousWord('hello world   '), 'hello')
  assert.equal(deletePreviousWord('hello'), '')
})

test('completeSlashCommand completes unique command and subcommand prefixes', () => {
  assert.equal(completeSlashCommand('/th', COMMAND_SESSION), '/thread ')
  assert.equal(
    completeSlashCommand('/thread ag', COMMAND_SESSION),
    '/thread agent '
  )
  assert.equal(
    completeSlashCommand('/thread cap', COMMAND_SESSION),
    '/thread capability '
  )
  assert.equal(completeSlashCommand('/skill a', COMMAND_SESSION), '/skill add ')
  assert.equal(completeSlashCommand('/mcp sto', COMMAND_SESSION), '/mcp stop ')
  assert.equal(completeSlashCommand('/mcp t', COMMAND_SESSION), '/mcp token ')
  assert.equal(completeSlashCommand('/mcp sta', COMMAND_SESSION), '/mcp sta')
  assert.equal(completeSlashCommand('/thread s', COMMAND_SESSION), '/thread s')
  assert.equal(
    completeSlashCommand(
      '/thread agent gemini',
      COMMAND_SESSION,
      COMPLETION_SNAPSHOT
    ),
    '/thread agent gemini '
  )
  assert.equal(completeSlashCommand('/', COMMAND_SESSION), '/')
  assert.equal(completeSlashCommand('hello /op', COMMAND_SESSION), 'hello /op')
})

test('resolveInputSyntaxHighlight only marks recognized commands', () => {
  assert.deepEqual(
    resolveInputSyntaxHighlight('/thread reload t-1', COMMAND_SESSION),
    { start: 0, end: 14, kind: 'command' }
  )
  assert.deepEqual(
    resolveInputSyntaxHighlight('/thread unknown', COMMAND_SESSION),
    { start: 0, end: 7, kind: 'command' }
  )
  assert.deepEqual(resolveInputSyntaxHighlight('  /help', COMMAND_SESSION), {
    start: 2,
    end: 7,
    kind: 'command',
  })
  assert.equal(resolveInputSyntaxHighlight('/th', COMMAND_SESSION), null)
  assert.equal(
    resolveInputSyntaxHighlight('$chrome-automation', COMMAND_SESSION),
    null
  )
})

test('welcome rows use responsive layouts without overflowing', () => {
  const details = {
    browserStatus: 'connected' as const,
    directory: 'C:\\Users\\JXZ\\Desktop\\code\\portal',
    version: '1.0.0',
  }
  const wideRows = buildWelcomeRows(details, 70)
  const narrowRows = buildWelcomeRows(details, 28)

  assert.ok(wideRows.some((row) => row.text.includes('█▀█')))
  assert.equal(
    wideRows.some((row) => row.text.includes('No active')),
    false
  )
  assert.equal(
    wideRows.some((row) => row.text.includes('/thread')),
    false
  )
  assert.ok(wideRows.every((row) => estimateDisplayWidth(row.text) <= 70))
  assert.ok(narrowRows.some((row) => row.text === 'PORTAL v1.0.0'))
  assert.equal(
    narrowRows.some((row) => row.text.includes('No active')),
    false
  )
  assert.equal(
    narrowRows.some((row) => row.text.includes('/help')),
    false
  )
  assert.ok(narrowRows.every((row) => estimateDisplayWidth(row.text) <= 28))
})

test('welcome rows describe each browser connection state', () => {
  const details = {
    directory: 'C:\\Users\\JXZ\\Desktop\\code\\portal',
    version: '1.0.0',
  }

  assert.ok(
    buildWelcomeRows({ ...details, browserStatus: 'connecting' }, 70).some(
      (row) => row.text === '◌ Browser connecting'
    )
  )
  assert.ok(
    buildWelcomeRows({ ...details, browserStatus: 'connected' }, 70).some(
      (row) => row.text === '● Browser connected'
    )
  )
  assert.ok(
    buildWelcomeRows({ ...details, browserStatus: 'disconnected' }, 70).some(
      (row) => row.text === '○ Browser disconnected'
    )
  )
})

test('truncateMiddleLine preserves both ends of long paths', () => {
  const result = truncateMiddleLine('C:\\Users\\JXZ\\Desktop\\code\\portal', 20)

  assert.ok(result.startsWith('C:\\Users'))
  assert.ok(result.endsWith('de\\portal'))
  assert.ok(result.includes('…'))
  assert.ok(estimateDisplayWidth(result) <= 20)
})

test('shouldInterruptForKey only allows Ctrl+C while busy', () => {
  assert.equal(
    shouldInterruptForKey({
      busy: false,
      input: 'c',
      inputValue: '',
      key: { ctrl: true },
    }),
    false
  )
  assert.equal(
    shouldInterruptForKey({
      busy: true,
      input: 'c',
      inputValue: 'draft',
      key: { ctrl: true },
    }),
    true
  )
})

test('shouldClearInputForCtrlC only clears non-empty input while idle', () => {
  assert.equal(
    shouldClearInputForCtrlC({
      busy: false,
      input: 'c',
      inputValue: 'draft',
      key: { ctrl: true },
    }),
    true
  )
  assert.equal(
    shouldClearInputForCtrlC({
      busy: false,
      input: 'c',
      inputValue: '',
      key: { ctrl: true },
    }),
    false
  )
  assert.equal(
    shouldClearInputForCtrlC({
      busy: true,
      input: 'c',
      inputValue: 'draft',
      key: { ctrl: true },
    }),
    false
  )
})

test('busy input accepts slash commands but keeps ordinary prompts pending', () => {
  assert.equal(canSubmitInput('/thread switch t-2', true), true)
  assert.equal(canSubmitInput('  /thread list', true), true)
  assert.equal(canSubmitInput('continue with the tests', true), false)
  assert.equal(canSubmitInput('continue with the tests', false), true)
})

test('slash command submission completes the current hint once', () => {
  assert.equal(
    resolveSubmittedInputValue('/', null, COMMAND_SESSION, COMPLETION_SNAPSHOT),
    '/help'
  )
  assert.equal(
    resolveSubmittedInputValue(
      '/thread ag',
      null,
      COMMAND_SESSION,
      COMPLETION_SNAPSHOT
    ),
    '/thread agent'
  )
  assert.equal(
    resolveSubmittedInputValue(
      '/thread agent gem',
      null,
      COMMAND_SESSION,
      COMPLETION_SNAPSHOT
    ),
    '/thread agent gemini'
  )
})

test('slash command submission uses the selected or current default hint', () => {
  assert.equal(
    resolveSubmittedInputValue(
      '/',
      '/thread ',
      COMMAND_SESSION,
      COMPLETION_SNAPSHOT
    ),
    '/thread'
  )
  assert.equal(
    resolveSubmittedInputValue(
      '/',
      '/missing ',
      COMMAND_SESSION,
      COMPLETION_SNAPSHOT
    ),
    '/help'
  )
  assert.equal(
    resolveSubmittedInputValue(
      '/thread agent ',
      '/thread agent deepseek ',
      COMMAND_SESSION,
      COMPLETION_SNAPSHOT
    ),
    '/thread agent deepseek'
  )
  assert.equal(
    resolveSubmittedInputValue(
      '/thread agent gemini ',
      '/thread agent gemini 3.1-pro ',
      COMMAND_SESSION,
      COMPLETION_SNAPSHOT
    ),
    '/thread agent gemini 3.1-pro'
  )
  assert.equal(
    resolveSubmittedInputValue(
      '/thread agent gemini ',
      null,
      COMMAND_SESSION,
      COMPLETION_SNAPSHOT
    ),
    '/thread agent gemini 3.5-flash-lite'
  )
  assert.equal(
    resolveSubmittedInputValue(
      '/thread agent gemini 3.1-pro e',
      null,
      COMMAND_SESSION,
      COMPLETION_SNAPSHOT
    ),
    '/thread agent gemini 3.1-pro extended'
  )
})

test('slash command submission preserves inputs without a selectable hint', () => {
  const values = [
    'hello',
    '$review',
    '/unknown',
    '/unknown ',
    '/help ',
    '/thread\nagent',
  ]
  for (const value of values) {
    assert.equal(
      resolveSubmittedInputValue(
        value,
        '/thread ',
        COMMAND_SESSION,
        COMPLETION_SNAPSHOT
      ),
      value
    )
  }
})

test('slash command submission matches hints for leading whitespace', () => {
  assert.equal(
    resolveSubmittedInputValue(
      '  /thr',
      null,
      COMMAND_SESSION,
      COMPLETION_SNAPSHOT
    ),
    '/thread'
  )
})

test('shouldInterruptForKey only allows Ctrl+D to exit on empty non-busy input', () => {
  assert.equal(
    shouldInterruptForKey({
      busy: false,
      input: 'd',
      inputValue: '',
      key: { ctrl: true },
    }),
    true
  )
  assert.equal(
    shouldInterruptForKey({
      busy: false,
      input: 'd',
      inputValue: 'draft',
      key: { ctrl: true },
    }),
    false
  )
  assert.equal(
    shouldInterruptForKey({
      busy: true,
      input: 'd',
      inputValue: '',
      key: { ctrl: true },
    }),
    false
  )
})

test('renderBubbleBody keeps long markdown table cells instead of truncating', () => {
  const longText =
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen'
  const rendered = renderBubbleBody(
    ['| field | value |', '|---|---|', `| long_text | ${longText} |`].join(
      '\n'
    ),
    'markdown',
    40
  )

  assert.equal(rendered.includes('…'), false)
  assert.equal(rendered.includes('fifteen'), true)
})

test('renderBubbleBody keeps Markdown blocks compact without dropping code blank lines', () => {
  const rendered = renderBubbleBody(
    [
      '# Heading',
      '',
      'Paragraph',
      '',
      '---',
      '',
      '```',
      'alpha',
      '',
      'beta',
      '```',
      '',
      '| H |',
      '| --- |',
      '| V |',
      '',
      '- first',
      '',
      '- second',
    ].join('\n'),
    'markdown',
    40
  )
  const lines = rendered.split('\n')

  assert.equal(lines[0], 'Heading')
  assert.equal(
    lines.some((line) => line.length === 0),
    false
  )

  const alphaIndex = lines.findIndex((line) => line.includes('alpha'))
  assert.notEqual(alphaIndex, -1)
  assert.equal(lines[alphaIndex + 1]?.replace(/[│\s]/gu, ''), '')
  assert.equal(lines[alphaIndex + 2]?.includes('beta'), true)

  const codeBottomIndex = lines.findIndex((line) => line.startsWith('└'))
  assert.equal(lines[codeBottomIndex + 1]?.startsWith('┌'), true)

  const firstItemIndex = lines.findIndex((line) => line === '- first')
  assert.equal(lines[firstItemIndex - 1]?.startsWith('└'), true)
})

test('renderBubbleBody colors V4A snapshot lines without changing their text', () => {
  const rendered = renderBubbleBody(
    [
      '1 file · +1 -1',
      '*** Begin Patch',
      '*** Update File: src/example.ts',
      '@@',
      ' context',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'),
    'v4a',
    80
  )

  assert.match(rendered, /\u001B\[1m1 file · \+1 -1\u001B\[22m/)
  assert.match(rendered, /\u001B\[36m\*\*\* Begin Patch\u001B\[39m/)
  assert.match(rendered, /\u001B\[33m@@\u001B\[39m/)
  assert.match(rendered, /\u001B\[31m-old\u001B\[39m/)
  assert.match(rendered, /\u001B\[32m\+new\u001B\[39m/)
})

test('renderBubbleBody expands tabs at display-column stops for plain output', () => {
  const rendered = renderBubbleBody('a\tb\r\n\tc\rd', 'plain', 40)

  assert.equal(rendered, 'a   b\n    c\nd')
  assert.equal(rendered.includes('\t'), false)
})

test('renderBubbleBody ignores ANSI CSI sequences when expanding and measuring tabs', () => {
  const rendered = renderBubbleBody('a\u001B[2K\tb', 'plain', 40)

  assert.equal(rendered, 'a   b')
  assert.equal(estimateDisplayWidth(rendered), 5)
})

test('renderBubbleBody normalizes Unicode line separators before tab expansion', () => {
  const rendered = renderBubbleBody('a\u0085\tb\u2028\tc\u2029\td', 'plain', 40)

  assert.equal(rendered, 'a\n    b\n    c\n    d')
})

test('renderBubbleBody canonicalizes C1 SGR before measuring tabs', () => {
  const rendered = renderBubbleBody('\u009B31mred\u009B0m\tb', 'plain', 40)

  assert.equal(rendered, '\u001B[31mred\u001B[0m b')
  assert.equal(estimateDisplayWidth(rendered), 5)
})

test('wrapAnsiLine keeps long OSC 8 links atomic across wrapped lines', () => {
  const uri = `https://example.com/${'secret'.repeat(30)}`
  const visible = 'Z'.repeat(100)
  const input = `\u001B]8;;${uri}\u0007${visible}\u001B]8;;\u0007`
  const lines = wrapAnsiLine(input, 20)
  const renderedLines = lines.map((line) =>
    renderToString(createElement(Text, null, line))
  )

  assert.equal(
    renderedLines.map((line) => stripAnsiSequences(line)).join(''),
    visible
  )
  assert.equal(
    renderedLines.some((line) => stripAnsiSequences(line).includes('secret')),
    false
  )
})

test('renderBubbleBody expands tabs before markdown and V4A formatting', () => {
  const markdown = renderBubbleBody(
    '```\n\tconst value = 1\n```',
    'markdown',
    40
  )
  const v4a = renderBubbleBody('1 file\r\n*** Begin Patch\r\n\t+new', 'v4a', 40)

  assert.equal(markdown.includes('\t'), false)
  assert.equal(v4a.includes('\t'), false)
  assert.match(v4a, / {4}\+new/)
})

test('Ink renders bubble control characters without terminal side effects', () => {
  const body = renderBubbleBody(
    'VT: [\u000B] FF: [\u000C]\nNEL: [\u0085] LS: [\u2028] PS: [\u2029]',
    'plain',
    80
  )
  const output = renderToString(createElement(Text, null, body))

  assert.equal(
    /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/u.test(output),
    false
  )
  assert.match(output, /VT: \[ \] FF: \[ \]/)
})

test('estimateDisplayWidth ignores default-ignorable formatting characters', () => {
  for (const character of ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF']) {
    const codePoint = character.codePointAt(0)?.toString(16).toUpperCase()
    assert.equal(estimateDisplayWidth(character), 0, `U+${codePoint}`)
  }

  assert.equal(estimateDisplayWidth('a\u200Bb\u200Cc'), 3)
})

test('estimateDisplayWidth preserves emoji clusters and Unicode space widths', () => {
  assert.equal(estimateDisplayWidth('👩‍💻'), 2)
  assert.equal(estimateDisplayWidth('🇨🇳'), 2)
  assert.equal(estimateDisplayWidth('1️⃣'), 2)
  assert.equal(estimateDisplayWidth('\u00A0\u2002\u2003\u2009'), 4)
  assert.equal(estimateDisplayWidth('\u3000'), 2)
})

test('renderBubbleBody wraps long CJK markdown table cells through markdansi', () => {
  const longText =
    '这是一段没有空格的超长中文单元格内容用来验证表格边框不会被撑破并且内容不会丢失'
  const rendered = renderBubbleBody(
    ['| item | description |', '|---|---|', `| long | ${longText} |`].join(
      '\n'
    ),
    'markdown',
    40
  )

  for (const line of rendered.split('\n')) {
    assert.equal(estimateDisplayWidth(line) <= 40, true, line)
  }
  assert.equal(rendered.includes('丢失'), true)
  assert.equal(rendered.includes('…'), false)
})

test('renderBubbleBody hard-wraps long identifiers without widening table borders', () => {
  const identifier = 'buildRuntimeRecoveryPlan、createRuntimeFromAdapter'
  const rendered = renderBubbleBody(
    [
      '| 难度 | 切入点 | 具体建议 |',
      '|---|---|---|',
      `| 简单 | 增加注释 | ${identifier} |`,
    ].join('\n'),
    'markdown',
    40
  )

  for (const line of rendered.split('\n')) {
    assert.equal(estimateDisplayWidth(line) <= 40, true, line)
  }

  const recommendationText = rendered
    .split('\n')
    .filter((line) => line.startsWith('│'))
    .map((line) => line.split('│')[3]?.trim() ?? '')
    .join('')
  assert.equal(recommendationText.includes(identifier), true)
  assert.equal(rendered.includes('…'), false)
})
