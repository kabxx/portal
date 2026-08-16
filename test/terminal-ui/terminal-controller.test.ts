import test from 'node:test'
import assert from 'node:assert/strict'

import { TerminalController } from '../../src/terminal-ui/terminal-controller.ts'
import {
  describeInputPanel,
  estimateDisplayWidth,
  formatLiveCommandTitle,
  renderBubbleBody,
  truncateAnsiLine,
  wrapSingleLine,
} from '../../src/terminal-ui/terminal-screen.tsx'
import { ThreadManager } from '../../src/threads/thread-manager.ts'
import { createFakeRuntime } from '../helpers/fakes.ts'
import { createTestSurfacePort } from '../helpers/surface-port.ts'
import { SETUP_HANDSHAKE_PROMPT } from '../../src/runtime/setup-handshake.ts'

test('TerminalController stores the startup welcome in the home timeline', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()
  ui.renderWelcome({
    browserStatus: 'connecting',
    directory: 'C:\\Users\\JXZ\\Desktop\\code\\portal',
    version: '1.0.0',
  })

  const welcome = ui.getState().timeline.at(-1)
  assert.ok(welcome)
  assert.equal(welcome.label, 'portal')
  assert.deepEqual(welcome.welcome, {
    browserStatus: 'connecting',
    directory: 'C:\\Users\\JXZ\\Desktop\\code\\portal',
    version: '1.0.0',
  })

  manager.switchThread(thread.id)
  ui.showThreadTimeline(thread.id)
  assert.equal(ui.getState().timeline.length, 0)
  ui.showHomeTimeline()
  assert.deepEqual(ui.getState().timeline.at(-1)?.welcome, welcome.welcome)
})

test('TerminalController updates the existing welcome when the browser connects', () => {
  const ui = new TerminalController()
  const events: string[] = []
  ui.setScreenResetter(() => events.push('reset'))
  ui.subscribe(() => events.push('notify'))
  ui.renderWelcome({
    browserStatus: 'connecting',
    directory: 'C:\\Users\\JXZ\\Desktop\\code\\portal',
    version: '1.0.0',
  })
  const welcomeId = ui.getState().timeline.at(-1)?.id
  events.length = 0

  ui.setBrowserConnected(true)

  const state = ui.getState()
  assert.deepEqual(events, ['notify'])
  assert.equal(state.timeline.length, 1)
  assert.equal(state.timeline[0]?.id, welcomeId)
  assert.equal(state.timeline[0]?.welcome?.browserStatus, 'connected')
  assert.equal(state.timelineVersion, 0)

  events.length = 0
  ui.setBrowserConnected(false)
  assert.deepEqual(events, ['reset', 'notify'])
  assert.equal(
    ui.getState().timeline[0]?.welcome?.browserStatus,
    'disconnected'
  )
  assert.equal(ui.getState().timelineVersion, 1)
})

test('TerminalController exposes the active thread through bound thread state', () => {
  const manager = new ThreadManager()
  manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime({
      assistantText: 'Summarize the latest release notes.',
    }),
    createdAt: 1,
  })

  const ui = new TerminalController()
  ui.bindSurfacePort(createTestSurfacePort(manager))

  assert.equal(ui.promptLabel(manager), 'gemini > ')
  assert.equal(ui.promptLabel(), 'gemini > ')
})

test('TerminalController caches home and thread timelines independently', () => {
  const manager = new ThreadManager()
  const first = manager.addThread({
    id: manager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const second = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 2,
  })
  const ui = new TerminalController()

  ui.renderInfo('home', 'home entry')
  manager.switchThread(first.id)
  ui.showThreadTimeline(first.id)
  ui.renderInfo('/thread agent', 'Thread t-1 is ready')
  manager.switchThread(second.id)
  ui.showThreadTimeline(second.id)
  ui.renderInfo('thread', 'second entry')
  manager.switchThread(first.id)
  ui.showThreadTimeline(first.id)

  assert.deepEqual(
    ui.getState().timeline.map((entry) => entry.body),
    ['Thread t-1 is ready']
  )
  ui.showHomeTimeline()
  assert.deepEqual(
    ui.getState().timeline.map((entry) => entry.body),
    ['home entry']
  )
})

test('TerminalController discards live tools when switching timelines', () => {
  const manager = new ThreadManager()
  const first = manager.addThread({
    id: 't-a',
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const second = manager.addThread({
    id: 't-b',
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 2,
  })
  const ui = new TerminalController()
  ui.bindSurfacePort(createTestSurfacePort(manager))

  manager.switchThread(first.id)
  ui.showThreadTimeline(first.id)
  ui.setThreadBusy(first.id, true)
  ui.renderToolCall(first, 'run_command', '{}', 'call-a')
  ui.renderToolProgress(
    first,
    'run_command',
    { type: 'start', startedAt: 1000 },
    'call-a'
  )
  ui.renderToolProgress(
    first,
    'run_command',
    { type: 'output', stream: 'stdout', text: 'output from a' },
    'call-a'
  )
  assert.equal(ui.getState().liveCommand?.body, 'output from a')

  manager.switchThread(second.id)
  ui.showThreadTimeline(second.id)
  assert.equal(ui.getState().busy, false)
  assert.equal(ui.getState().liveCommand, null)

  ui.setThreadBusy(second.id, true)
  ui.renderAssistantStream(second, 'reply from b')
  ui.renderThreadError(first, 'thread', 'failure from a')
  assert.equal(ui.getState().liveAssistant?.body, 'reply from b')
  assert.equal(
    ui.getState().timeline.some(({ body }) => body === 'failure from a'),
    false
  )

  manager.switchThread(first.id)
  ui.showThreadTimeline(first.id)
  assert.equal(ui.getState().busy, true)
  assert.equal(ui.getState().liveCommand, null)
  assert.equal(ui.getState().timeline.at(-1)?.body, 'failure from a')
})

test('TerminalController preserves inactive live assistant state across switches', () => {
  const manager = new ThreadManager()
  const first = manager.addThread({
    id: 't-a',
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const second = manager.addThread({
    id: 't-b',
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 2,
  })
  const ui = new TerminalController()
  ui.bindSurfacePort(createTestSurfacePort(manager))

  manager.switchThread(first.id)
  ui.showThreadTimeline(first.id)
  ui.renderAssistantStream(first, 'first chunk')
  manager.switchThread(second.id)
  ui.showThreadTimeline(second.id)
  ui.renderAssistantStream(first, 'latest background chunk')

  assert.equal(ui.getState().liveAssistant, null)
  manager.switchThread(first.id)
  ui.showThreadTimeline(first.id)
  assert.equal(ui.getState().liveAssistant?.body, 'latest background chunk')
})

test('foreground busy state cannot clear a running thread', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: 't-a',
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()
  ui.bindSurfacePort(createTestSurfacePort(manager))
  ui.showThreadTimeline(thread.id)

  ui.setThreadBusy(thread.id, true)
  ui.setBusy(true)
  ui.setBusy(false)

  assert.equal(ui.getState().busy, true)
  ui.setThreadBusy(thread.id, false)
  assert.equal(ui.getState().busy, false)
})

test('TerminalController resets the screen before notifying a timeline switch and restores cached bubbles', () => {
  const manager = new ThreadManager()
  const first = manager.addThread({
    id: manager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const second = manager.addThread({
    id: manager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime(),
    createdAt: 2,
  })
  const ui = new TerminalController()
  manager.switchThread(first.id)
  ui.showThreadTimeline(first.id)
  ui.renderInfo('thread', 'first bubble')

  const events: string[] = []
  ui.setScreenResetter(() => events.push('reset'))
  ui.subscribe(() => events.push('notify'))

  manager.switchThread(second.id)
  ui.showThreadTimeline(second.id)
  assert.deepEqual(events, ['reset', 'notify'])

  events.length = 0
  manager.switchThread(first.id)
  ui.showThreadTimeline(first.id)

  assert.deepEqual(events, ['reset', 'notify'])
  assert.deepEqual(
    ui.getState().timeline.map((entry) => entry.body),
    ['first bubble']
  )
})

test('TerminalController appends resumed history after the ready message', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.showThreadTimeline(thread.id)
  ui.renderInfo('/thread resume', 'Thread t-1 is ready.')
  let notifications = 0
  ui.subscribe(() => {
    notifications += 1
  })
  ui.renderConversationHistory(thread, [
    {
      id: 'user-1',
      parentId: null,
      role: 'user',
      text: 'previous question',
      format: 'plain',
      createdAt: 1,
    },
    {
      id: 'assistant-1',
      parentId: 'user-1',
      role: 'assistant',
      text: '**previous answer**',
      format: 'markdown',
      createdAt: 2,
    },
  ])

  assert.deepEqual(
    ui.getState().timeline.map(({ tone, body, format }) => ({
      tone,
      body,
      format,
    })),
    [
      { tone: 'info', body: 'Thread t-1 is ready.', format: 'plain' },
      { tone: 'user', body: 'previous question', format: 'plain' },
      {
        tone: 'assistant',
        body: '**previous answer**',
        format: 'markdown',
      },
    ]
  )
  assert.equal(notifications, 1)
})

test('TerminalController hides resume internals and restores tool calls', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.showThreadTimeline(thread.id)
  ui.renderConversationHistory(thread, [
    {
      id: 'setup',
      parentId: null,
      role: 'user',
      text: '# System\n# Tools\n# Setup Handshake',
      format: 'plain',
      createdAt: 1,
    },
    {
      id: 'ready',
      parentId: 'setup',
      role: 'assistant',
      text: 'READY',
      format: 'markdown',
      createdAt: 2,
    },
    {
      id: 'question',
      parentId: 'ready',
      role: 'user',
      text: 'Inspect the project.',
      format: 'plain',
      createdAt: 3,
    },
    {
      id: 'tool-call',
      parentId: 'question',
      role: 'assistant',
      text: 'I will inspect it.\n<tool name="run_command">{"command":"dir"}</tool>',
      format: 'markdown',
      createdAt: 4,
    },
    {
      id: 'tool-result',
      parentId: 'tool-call',
      role: 'user',
      text: '### Tool Result ###\n{"exitCode":0,"stdout":"ok"}',
      format: 'plain',
      createdAt: 5,
    },
    {
      id: 'final',
      parentId: 'tool-result',
      role: 'assistant',
      text: 'Inspection complete.',
      format: 'markdown',
      createdAt: 6,
    },
  ])

  const timeline = ui.getState().timeline
  assert.deepEqual(
    timeline.map(({ tone }) => tone),
    ['user', 'assistant', 'tool_call', 'assistant']
  )
  assert.equal(timeline[0]?.body, 'Inspect the project.')
  assert.equal(timeline[1]?.body, 'I will inspect it.')
  assert.match(timeline[2]?.body ?? '', /command: dir/)
  assert.equal(timeline[2]?.label, 'run_command · call')
  assert.equal(timeline[3]?.body, 'Inspection complete.')
})

test('TerminalController restores non-terminal history tool blocks as assistant text', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()
  const response = [
    'I will inspect it.',
    '<tool name="run_command">',
    '{"command":"dir"}',
    '</tool>',
    'The results are in.',
  ].join('\n')

  ui.renderConversationHistory(thread, [
    {
      id: 'question',
      parentId: null,
      role: 'user',
      text: 'Inspect the project.',
      format: 'plain',
      createdAt: 1,
    },
    {
      id: 'answer',
      parentId: 'question',
      role: 'assistant',
      text: response,
      format: 'markdown',
      createdAt: 2,
    },
  ])

  const timeline = ui.getState().timeline
  assert.deepEqual(
    timeline.map(({ tone }) => tone),
    ['user', 'assistant']
  )
  assert.equal(timeline[1]?.body, response)
  const rendered = renderBubbleBody(timeline[1].body, 'markdown', 100)
  assert.match(rendered, /<tool name="run_command">/)
  assert.match(rendered, /{"command":"dir"}/)
  assert.match(rendered, /<\/tool>/)
  assert.match(rendered, /The results are in\./)
})

test('TerminalController keeps READY when no setup prompt is present', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderConversationHistory(thread, [
    {
      id: 'question',
      parentId: null,
      role: 'user',
      text: 'Say READY.',
      format: 'plain',
      createdAt: 1,
    },
    {
      id: 'answer',
      parentId: 'question',
      role: 'assistant',
      text: 'READY',
      format: 'markdown',
      createdAt: 2,
    },
  ])

  assert.deepEqual(
    ui.getState().timeline.map(({ tone, body }) => ({ tone, body })),
    [
      { tone: 'user', body: 'Say READY.' },
      { tone: 'assistant', body: 'READY' },
    ]
  )
})

test('TerminalController hides the chat handshake and accepted READY response', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderConversationHistory(thread, [
    {
      id: 'setup',
      parentId: null,
      role: 'user',
      text: SETUP_HANDSHAKE_PROMPT,
      format: 'plain',
      createdAt: 1,
    },
    {
      id: 'ready',
      parentId: 'setup',
      role: 'assistant',
      text: 'ready - complete',
      format: 'markdown',
      createdAt: 2,
    },
    {
      id: 'question',
      parentId: 'ready',
      role: 'user',
      text: 'Hello.',
      format: 'plain',
      createdAt: 3,
    },
  ])

  assert.deepEqual(
    ui.getState().timeline.map(({ tone, body }) => ({ tone, body })),
    [{ tone: 'user', body: 'Hello.' }]
  )
})

test('TerminalController keeps a later READY response when the handshake reply is missing', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderConversationHistory(thread, [
    {
      id: 'setup',
      parentId: null,
      role: 'user',
      text: SETUP_HANDSHAKE_PROMPT,
      format: 'plain',
      createdAt: 1,
    },
    {
      id: 'question',
      parentId: 'setup',
      role: 'user',
      text: 'Can you help?',
      format: 'plain',
      createdAt: 2,
    },
    {
      id: 'answer',
      parentId: 'question',
      role: 'assistant',
      text: 'I am ready to help.',
      format: 'markdown',
      createdAt: 3,
    },
  ])

  assert.deepEqual(
    ui.getState().timeline.map(({ tone, body }) => ({ tone, body })),
    [
      { tone: 'user', body: 'Can you help?' },
      { tone: 'assistant', body: 'I am ready to help.' },
    ]
  )
})

test('TerminalController renders tool call and tool result with different tones', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })

  const ui = new TerminalController()
  ui.renderToolCall(
    thread,
    'run_command',
    JSON.stringify({
      tool: 'run_command',
      params: {
        command: 'dir',
      },
    })
  )
  ui.renderToolResult(thread, 'run_command', 'success', {
    cwd: 'C:\\repo',
    exitCode: 0,
    timedOut: false,
    stdout: 'ok',
    stderr: '',
    truncated: false,
  })

  const state = ui.getState()
  assert.equal(state.timeline[0]?.tone, 'tool_call')
  assert.equal(state.timeline[0]?.label, 'run_command · call')
  assert.match(state.timeline[0]?.body ?? '', /shell:/)
  assert.doesNotMatch(state.timeline[0]?.body ?? '', /"tool"/)
  assert.equal(state.timeline[1]?.tone, 'tool_result')
  assert.equal(state.timeline[1]?.label, 'run_command · result')
  assert.equal(state.timeline[1]?.body.includes('stdout:'), false)
  assert.equal(state.timeline[1]?.body.includes('cwd:'), false)
})

test('TerminalController keeps a dynamic ten-line live run_command tail and reuses its id', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderToolCall(thread, 'run_command', JSON.stringify({ command: 'watch' }))
  ui.renderToolProgress(thread, 'run_command', {
    type: 'start',
    startedAt: 1000,
  })
  const liveId = ui.getState().liveCommand?.id
  assert.ok(liveId !== undefined)
  assert.equal(ui.getState().liveCommand?.body, 'Waiting for command output...')
  assert.equal(ui.getState().liveCommand?.fixedLineCount, undefined)

  ui.renderToolProgress(thread, 'run_command', {
    type: 'output',
    stream: 'stdout',
    text: 'first',
  })
  assert.equal(ui.getState().liveCommand?.body, 'first')
  assert.equal(ui.getState().liveCommand?.fixedLineCount, 1)

  ui.renderToolProgress(thread, 'run_command', {
    type: 'output',
    stream: 'stderr',
    text: 'error\n',
  })
  assert.equal(ui.getState().liveCommand?.fixedLineCount, 2)

  ui.renderToolProgress(thread, 'run_command', {
    type: 'output',
    stream: 'stdout',
    text: ' line\nnext\r',
  })
  ui.renderToolProgress(thread, 'run_command', {
    type: 'output',
    stream: 'stdout',
    text: 'replacement',
  })
  ui.renderToolProgress(thread, 'run_command', {
    type: 'output',
    stream: 'stderr',
    text: 'tail',
  })

  assert.equal(
    ui.getState().liveCommand?.body,
    'error\nfirst line\nreplacement\ntail'
  )
  assert.equal(ui.getState().liveCommand?.fixedLineCount, 4)

  ui.renderToolProgress(thread, 'run_command', {
    type: 'output',
    stream: 'stdout',
    text: `\n${Array.from({ length: 11 }, (_, index) => `line-${index}`).join('\n')}\n`,
  })

  assert.equal(
    ui.getState().liveCommand?.body,
    Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join('\n')
  )
  assert.equal(ui.getState().liveCommand?.fixedLineCount, 10)

  ui.renderToolResult(
    thread,
    'run_command',
    'success',
    { exitCode: 0, timedOut: false, truncated: false },
    'exitCode: 0'
  )
  const state = ui.getState()
  assert.equal(state.liveCommand, null)
  assert.equal(state.timeline.at(-1)?.id, liveId)
  assert.equal(state.timeline.at(-1)?.tone, 'tool_result')
})

test('TerminalController isolates stale live events by tool call id', () => {
  for (const toolName of ['run_command', 'spawn'] as const) {
    const manager = new ThreadManager()
    const thread = manager.addThread({
      id: manager.createThreadId(),
      provider: 'gemini',
      runtime: createFakeRuntime(),
      createdAt: 1,
    })
    const ui = new TerminalController()

    ui.renderToolCall(thread, toolName, '{}', 'old-call')
    ui.renderToolCall(thread, toolName, '{}', 'current-call')
    ui.renderToolProgress(
      thread,
      toolName,
      { type: 'start', startedAt: 1000 },
      'old-call'
    )
    assert.equal(ui.getState().liveCommand, null)

    ui.renderToolProgress(
      thread,
      toolName,
      { type: 'start', startedAt: 2000 },
      'current-call'
    )
    const currentId = ui.getState().liveCommand?.id
    assert.ok(currentId !== undefined)
    assert.equal(ui.getState().liveCommand?.toolCallId, 'current-call')

    ui.renderToolProgress(
      thread,
      toolName,
      { type: 'output', stream: 'stdout', text: 'stale output' },
      'old-call'
    )
    assert.doesNotMatch(ui.getState().liveCommand?.body ?? '', /stale output/)

    ui.renderToolResult(
      thread,
      toolName,
      'success',
      toolName === 'run_command'
        ? { exitCode: 0, timedOut: false, truncated: false }
        : { provider: 'gemini' },
      'old result',
      'old-call'
    )
    assert.equal(ui.getState().liveCommand?.id, currentId)

    ui.renderToolResult(
      thread,
      toolName,
      'success',
      toolName === 'run_command'
        ? { exitCode: 0, timedOut: false, truncated: false }
        : { provider: 'gemini' },
      'current result',
      'current-call'
    )
    assert.equal(ui.getState().liveCommand, null)
    assert.equal(ui.getState().timeline.at(-1)?.id, currentId)
  }
})

test('stale command timers cannot mutate a replacement live bubble', (t) => {
  const originalNow = Date.now
  const originalSetTimeout = globalThis.setTimeout
  const callbacks = new Map<ReturnType<typeof setTimeout>, () => void>()
  let emitted = 0

  Date.now = () => 1000
  t.mock.method(
    globalThis,
    'setTimeout',
    (
      callback: (...args: unknown[]) => void,
      _delay?: number,
      ...args: unknown[]
    ) => {
      const handle = originalSetTimeout(() => {}, 0)
      callbacks.set(handle, () => callback(...args))
      return handle
    }
  )
  t.mock.method(globalThis, 'clearTimeout', () => {})

  try {
    const manager = new ThreadManager()
    const thread = manager.addThread({
      id: manager.createThreadId(),
      provider: 'gemini',
      runtime: createFakeRuntime(),
      createdAt: 1,
    })
    const ui = new TerminalController()
    ui.subscribe(() => {
      emitted += 1
    })

    ui.renderToolCall(thread, 'run_command', '{}', 'first-call')
    ui.renderToolProgress(
      thread,
      'run_command',
      { type: 'start', startedAt: 1000 },
      'first-call'
    )
    ui.renderToolProgress(
      thread,
      'run_command',
      { type: 'output', stream: 'stdout', text: 'first output' },
      'first-call'
    )
    const staleTimer = [...callbacks.values()][0]
    assert.ok(staleTimer)

    ui.renderToolCall(thread, 'run_command', '{}', 'second-call')
    ui.renderToolProgress(
      thread,
      'run_command',
      { type: 'start', startedAt: 1000 },
      'second-call'
    )
    ui.renderToolProgress(
      thread,
      'run_command',
      { type: 'output', stream: 'stdout', text: 'second output' },
      'second-call'
    )
    const currentTimer = [...callbacks.values()][1]
    assert.ok(currentTimer)

    const beforeStaleTimer = emitted
    staleTimer()
    assert.equal(emitted, beforeStaleTimer)
    assert.equal(ui.getState().liveCommand?.body, 'second output')

    currentTimer()
    assert.equal(emitted, beforeStaleTimer + 1)
    assert.equal(ui.getState().liveCommand?.toolCallId, 'second-call')
  } finally {
    Date.now = originalNow
  }
})

test('stale spawn heartbeats cannot reschedule after replacement', (t) => {
  const originalSetTimeout = globalThis.setTimeout
  const callbacks = new Map<ReturnType<typeof setTimeout>, () => void>()
  let emitted = 0

  t.mock.method(
    globalThis,
    'setTimeout',
    (
      callback: (...args: unknown[]) => void,
      _delay?: number,
      ...args: unknown[]
    ) => {
      const handle = originalSetTimeout(() => {}, 0)
      callbacks.set(handle, () => callback(...args))
      return handle
    }
  )
  t.mock.method(globalThis, 'clearTimeout', () => {})

  try {
    const manager = new ThreadManager()
    const thread = manager.addThread({
      id: manager.createThreadId(),
      provider: 'gemini',
      runtime: createFakeRuntime(),
      createdAt: 1,
    })
    const ui = new TerminalController()
    ui.subscribe(() => {
      emitted += 1
    })

    ui.renderToolCall(thread, 'spawn', '{}', 'first-spawn')
    ui.renderToolProgress(
      thread,
      'spawn',
      { type: 'start', startedAt: 1000 },
      'first-spawn'
    )
    const staleHeartbeat = [...callbacks.values()][0]
    assert.ok(staleHeartbeat)

    ui.renderToolCall(thread, 'spawn', '{}', 'second-spawn')
    ui.renderToolProgress(
      thread,
      'spawn',
      { type: 'start', startedAt: 2000 },
      'second-spawn'
    )
    const currentHeartbeat = [...callbacks.values()][1]
    assert.ok(currentHeartbeat)

    const beforeStaleHeartbeat = emitted
    staleHeartbeat()
    assert.equal(emitted, beforeStaleHeartbeat)
    assert.equal(ui.getState().liveCommand?.toolCallId, 'second-spawn')

    currentHeartbeat()
    assert.equal(emitted, beforeStaleHeartbeat + 1)
    assert.equal(callbacks.size, 3)
  } finally {
    t.mock.restoreAll()
  }
})

test('TerminalController clears a live run_command bubble when cancelled', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderToolCall(thread, 'run_command', '{}', 'cancelled-call')
  ui.renderToolProgress(
    thread,
    'run_command',
    { type: 'start', startedAt: Date.now() },
    'cancelled-call'
  )
  assert.equal(ui.getState().liveCommand?.toolCallId, 'cancelled-call')
  ui.clearLiveCommand(thread, 'different-call')
  assert.equal(ui.getState().liveCommand?.toolCallId, 'cancelled-call')
  ui.clearLiveCommand(thread)

  assert.equal(ui.getState().liveCommand, null)
})

test('TerminalController keeps a live spawn bubble until its result replaces it', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderToolCall(
    thread,
    'spawn',
    JSON.stringify({
      tool: 'spawn',
      params: { prompt: 'inspect the child task' },
    })
  )
  ui.renderToolProgress(thread, 'spawn', {
    type: 'start',
    startedAt: 1000,
  })

  const liveId = ui.getState().liveCommand?.id
  assert.ok(liveId !== undefined)
  assert.equal(ui.getState().liveCommand?.toolName, 'spawn')
  assert.equal(ui.getState().liveCommand?.fixedLineCount, undefined)
  assert.match(ui.getState().liveCommand?.body ?? '', /Waiting for child agent/)

  ui.renderToolResult(
    thread,
    'spawn',
    'success',
    { provider: 'gemini' },
    'Spawn completed.'
  )

  const state = ui.getState()
  assert.equal(state.liveCommand, null)
  assert.equal(state.timeline.at(-1)?.id, liveId)
  assert.equal(state.timeline.at(-1)?.label, 'spawn · result')
})

test('live command titles show elapsed seconds and truncate to the bubble width', () => {
  assert.equal(
    formatLiveCommandTitle('run_command', 1000, 13500),
    'run_command · running · 12s'
  )
  assert.equal(estimateDisplayWidth(truncateAnsiLine('abcdef', 4)), 4)
})

test('TerminalController prefers explicit tool display text', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderToolResult(
    thread,
    'future_tool',
    'success',
    { content: 'FULL TOOL CONTENT' },
    'Concise tool output'
  )

  const latest = ui.getState().timeline.at(-1)
  assert.equal(latest?.body, 'Concise tool output')
  assert.equal(latest?.label, 'future_tool · result')
  assert.equal(latest?.tone, 'tool_result')
  assert.equal(latest?.body.includes('FULL TOOL CONTENT'), false)
})

test('TerminalController summarizes named JSON tool calls', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()
  const cases = [
    {
      tool: 'attach_image',
      params: { path: 'C:\\images\\sample.png' },
      expected: 'path: C:\\images\\sample.png',
    },
    {
      tool: 'spawn',
      params: {
        provider: 'chatgpt',
        prompt: 'Inspect this.\nIgnore this line.',
      },
      expected: 'provider: chatgpt\nprompt: Inspect this.',
    },
  ] as const

  for (const item of cases) {
    const payload = JSON.stringify(item.params)
    ui.renderToolCall(thread, item.tool, payload)
    const entry = ui.getState().timeline.at(-1)
    assert.equal(entry?.label, `${item.tool} · call`)
    assert.equal(entry?.body, item.expected)
  }
})

test('TerminalController falls back to the raw payload for invalid tool params', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()
  const payload = JSON.stringify(['invalid'])

  ui.renderToolCall(thread, 'run_command', payload)

  assert.equal(ui.getState().timeline.at(-1)?.body, `payload: ${payload}`)
})

test('TerminalController renders error and unknown tool outcomes distinctly', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderToolResult(
    thread,
    'run_command',
    'error',
    { server: 'github', tool: 'create_issue', isError: true },
    'MCP tool returned an error.\nserver: github\ntool: create_issue'
  )
  let entry = ui.getState().timeline.at(-1)
  assert.equal(entry?.tone, 'error')
  assert.equal(entry?.label, 'run_command · error')

  ui.renderToolResult(
    thread,
    'run_command',
    'unknown',
    { server: 'github', tool: 'create_issue', retry: false },
    'MCP tool outcome is unknown.\nDo not retry automatically.'
  )
  entry = ui.getState().timeline.at(-1)
  assert.equal(entry?.tone, 'warning')
  assert.equal(entry?.label, 'run_command · unknown')
  assert.match(entry?.body ?? '', /Do not retry automatically/)
})

test('TerminalController summarizes apply_patch calls without file content', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderToolCall(
    thread,
    'apply_patch',
    [
      '*** Begin Patch',
      '*** Update File: C:\\repo\\sample.txt',
      '@@',
      '-private old content',
      '+private new content',
      '*** End Patch',
    ].join('\n')
  )

  const updateBody = ui.getState().timeline.at(-1)?.body ?? ''
  assert.equal(updateBody, 'update: C:\\repo\\sample.txt')
  assert.equal(updateBody.includes('private old content'), false)
  assert.equal(updateBody.includes('private new content'), false)

  ui.renderToolCall(
    thread,
    'apply_patch',
    [
      '*** Begin Patch',
      '*** Add File: C:\\repo\\created.txt',
      '+private new file content',
      '*** End Patch',
    ].join('\n')
  )

  assert.equal(
    ui.getState().timeline.at(-1)?.body,
    'add: C:\\repo\\created.txt'
  )
})

test('TerminalController keeps a live assistant bubble until the final assistant message is committed', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderAssistantStream(thread, 'partial reply')
  let state = ui.getState()
  assert.equal(state.liveAssistant?.body, 'partial reply')
  assert.equal(state.liveAssistant?.format, 'markdown')
  assert.equal(state.timeline.length, 0)

  ui.renderAssistantMessage(thread, 'partial reply completed')
  state = ui.getState()
  assert.equal(state.liveAssistant, null)
  assert.equal(state.timeline[0]?.tone, 'assistant')
  assert.equal(state.timeline[0]?.body, 'partial reply completed')
  assert.equal(state.timeline[0]?.format, 'markdown')
})

test('TerminalController does not render a tool-only stream as assistant text', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'grok',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderAssistantStream(
    thread,
    '<tool name="run_command">\n{"command":"dir"}\n</tool>'
  )

  assert.equal(ui.getState().liveAssistant, null)
})

test('TerminalController keeps only assistant text before a streaming tool call', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'grok',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderAssistantStream(
    thread,
    'I will update the file.\n<tool name="apply_patch">\n*** Begin Patch\n</tool>'
  )

  assert.equal(ui.getState().liveAssistant?.body, 'I will update the file.')
})

test('TerminalController restores a non-terminal tool block to the assistant stream', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'grok',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()
  const response = [
    'I will update the file.',
    '<tool name="apply_patch">',
    '*** Begin Patch',
    '</tool>',
    'The patch is ready.',
  ].join('\n')

  ui.renderAssistantStream(thread, response)

  assert.equal(ui.getState().liveAssistant?.body, response)
  const streamed = renderBubbleBody(
    ui.getState().liveAssistant?.body ?? '',
    'markdown',
    100
  )
  assert.match(streamed, /<tool name="apply_patch">/)
  assert.match(streamed, /\*\*\* Begin Patch/)
  assert.match(streamed, /<\/tool>/)
  assert.match(streamed, /The patch is ready\./)

  ui.renderAssistantMessage(thread, response)

  const final = ui.getState().timeline.at(-1)
  assert.equal(final?.body, response)
  assert.equal(final?.body.includes('\\<tool'), false)
  assert.equal(renderBubbleBody(final?.body ?? '', 'markdown', 100), streamed)
})

test('TerminalController leaves ordinary streaming Markdown unchanged', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderAssistantStream(thread, '**partial reply**')

  assert.equal(ui.getState().liveAssistant?.body, '**partial reply**')
})

test('TerminalController keeps an incomplete final tool tag visible after a tool call', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderToolCall(thread, 'run_command', '{"command":"pwd"}')
  ui.renderAssistantMessage(thread, '<tool>\n')

  const entries = ui.getState().timeline
  assert.equal(entries[0]?.tone, 'tool_call')
  assert.equal(entries[1]?.tone, 'assistant')
  assert.equal(entries[1]?.body, '<tool>\n')
  assert.match(renderBubbleBody(entries[1].body, 'markdown', 100), /<tool>/)
})

test('TerminalController coalesces rapid live assistant updates', async () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()
  let notifications = 0
  ui.subscribe(() => {
    notifications += 1
  })

  ui.renderAssistantStream(thread, 'first chunk')
  ui.renderAssistantStream(thread, 'second chunk')

  assert.equal(notifications, 1)
  assert.equal(ui.getState().liveAssistant?.body, 'second chunk')

  ui.renderAssistantMessage(thread, 'final answer')
  assert.equal(notifications, 2)

  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(notifications, 2)
})

test('TerminalController commits an interrupted live assistant before the next user message', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderUserMessage(thread, 'first prompt')
  ui.renderAssistantStream(thread, 'interrupted partial reply')
  const interruptedLiveId = ui.getState().liveAssistant?.id

  ui.commitLiveAssistant(thread)
  ui.renderWarning('thread', 'Cancelled current message.')
  ui.renderUserMessage(thread, 'second prompt')
  ui.renderAssistantStream(thread, 'new partial reply')

  const state = ui.getState()
  assert.equal(state.liveAssistant?.body, 'new partial reply')
  assert.deepEqual(
    state.timeline.map((entry) => [entry.tone, entry.body]),
    [
      ['user', 'first prompt'],
      ['assistant', 'interrupted partial reply'],
      ['warning', 'Cancelled current message.'],
      ['user', 'second prompt'],
    ]
  )
  assert.equal(state.timeline[1]?.id, interruptedLiveId)
})

test('describeInputPanel shows cursor and allows input while the runtime is busy', () => {
  const display = describeInputPanel(
    {
      browserConnected: true,
      busy: true,
      lastToolName: null,
      phase: 'working',
      lastAction: 'Creating a gemini thread.',
      footerHint: '',
      prompt: {
        active: false,
        label: 'gemini > ',
        hint: '',
      },
      liveAssistant: null,
      liveCommand: null,
      timelineVersion: 0,
      timeline: [],
    },
    'hello',
    'waiting..'
  )

  assert.deepEqual(display, {
    bodyColor: undefined,
    bodyText: 'hello',
    labelText: 'gemini [busy] > ',
    labelColor: 'yellow',
    showCursor: true,
  })
})

test('TerminalController keeps the full timeline instead of truncating older entries', () => {
  const ui = new TerminalController()

  for (let index = 0; index < 130; index += 1) {
    ui.renderInfo('thread', `message ${index}`)
  }

  const state = ui.getState()
  assert.equal(state.timeline.length, 130)
  assert.equal(state.timeline[0]?.body, 'message 0')
  assert.equal(state.timeline.at(-1)?.body, 'message 129')
})

test('estimateDisplayWidth counts emoji as two columns', () => {
  assert.equal(estimateDisplayWidth('😆'), 2)
  assert.equal(estimateDisplayWidth('a😆b'), 4)
})

test('wrapSingleLine wraps before an emoji that would overflow the bubble width', () => {
  assert.deepEqual(wrapSingleLine('1234😆', 5), ['1234', '😆'])
})

test('TerminalController requestInput and submitInput resolve through prompt state', async () => {
  const ui = new TerminalController()

  const pendingAnswer = ui.requestInput(
    'portal > ',
    'Type a task or enter a slash command.'
  )
  assert.equal(ui.getState().prompt.active, true)

  assert.equal(ui.submitInput('/help'), true)
  assert.equal(ui.submitInput('second input'), false)
  const answer = await pendingAnswer

  assert.equal(answer, '/help')
  assert.equal(ui.getState().prompt.active, false)
})

test('TerminalController preflights changed input independently', async () => {
  const ui = new TerminalController()
  const checks: Array<{
    value: string
    release: () => void
  }> = []
  const pendingAnswer = ui.requestInput(
    'portal > ',
    'Type a task or enter a slash command.',
    async (value) => {
      const deferred = Promise.withResolvers<void>()
      checks.push({ value, release: deferred.resolve })
      await deferred.promise
    }
  )

  const first = ui.preflightInput('first input')
  const second = ui.preflightInput('second input')

  assert.deepEqual(
    checks.map(({ value }) => value),
    ['first input', 'second input']
  )
  checks[1]!.release()
  assert.equal(await second, true)
  checks[0]!.release()
  assert.equal(await first, true)

  assert.equal(ui.submitInput('second input'), true)
  assert.equal(await pendingAnswer, 'second input')
})

test('TerminalController cancelPendingInput rejects the prompt and resets prompt state', async () => {
  const ui = new TerminalController()

  const pendingAnswer = ui.requestInput(
    'portal > ',
    'Type a task or enter a slash command.'
  )
  const error = new Error('Portal is exiting.')

  ui.cancelPendingInput(error)

  await assert.rejects(pendingAnswer, error)
  assert.equal(ui.getState().prompt.active, false)
})

test('live assistant with 40-line markdown response pushes input beyond typical terminal viewport', () => {
  const LONG_MD = [
    '# 项目架构说明',
    '',
    '## 1. 概述',
    '',
    '这是一个基于 TypeScript + Playwright 的浏览器代理 CLI 项目。',
    '',
    '## 2. 核心模块',
    '',
    '- `src/runtime/` — runtime 主循环、Turn/Item 事件和恢复策略',
    '- `src/providers/` — 封装不同网页 AI provider 的浏览器交互细节',
    '- `src/tools/` — 定义本地 Tool，解析命名 `<tool>` 调用并执行',
    '- `src/threads/` — thread-first runtime facade',
    '- `src/cli-commands/` — 交互式 CLI 命令系统',
    '- `src/threads/` — ThreadHandle / ThreadRecord / TurnRecord 状态模型',
    '',
    '## 3. 启动流程',
    '',
    '1. 解析 CLI 参数',
    '2. 启动/连接浏览器（通过 CDP）',
    '3. 创建 provider thread',
    '4. 为该 thread 绑定对应 provider runtime',
    '5. 注入 system prompt',
    '6. 进入 REPL 循环',
    '',
    '## 4. 工具协议',
    '',
    '所有工具使用命名 `<tool>` 标签；JSON 工具承载参数对象，Freeform 工具承载原始文本：',
    '',
    '```xml',
    '&lt;tool name="run_command"&gt;',
    '{"command": "dir", "cwd": "C:\\\\project"}',
    '&lt;/tool&gt;',
    '```',
    '',
    '当前支持三个核心工具：`attach_image`、`run_command`、`apply_patch`。',
    '',
    '## 5. 注意事项',
    '',
    '- Adapter 禁止依赖自然语言文案做 selector 或状态判定',
    '- 优先使用 `data-test-id`、DOM 结构、稳定属性等非语言信号',
    '- 登录态保存在 `data/` 目录，是持久化的',
    '- `temp/` 目录对排障很重要，不要随意清理',
  ].join('\n')

  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  // Simulate streaming: send progressive chunks
  const chunks = LONG_MD.split('\n')
  for (let i = 0; i < chunks.length; i++) {
    const soFar = chunks.slice(0, i + 1).join('\n')
    ui.renderAssistantStream(thread, soFar)
  }

  const streamingState = ui.getState()
  const liveBody = streamingState.liveAssistant?.body ?? ''

  // Commit to timeline
  ui.renderAssistantMessage(thread, LONG_MD)
  const finalState = ui.getState()
  const timelineBody = finalState.timeline.at(-1)?.body ?? ''

  // The live assistant during streaming has 41 raw lines (from split).
  // Ink renders each line + the bubble frame (top label + bottom border
  // = +2 extra rows). So the live bubble alone takes ~43 terminal rows.
  //
  // A typical terminal is 40-60 rows. With just this one response
  // (no prior messages), the input bar is already at row 43+ — either
  // at the very bottom or below the viewport.
  //
  // Root cause: the live assistant bubble height is proportional to
  // the markdown text length. There is no height cap or scroll view.
  assert.ok(
    liveBody.split('\n').length > 35,
    `Expected >35 raw lines, got ${liveBody.split('\n').length}`
  )
  assert.equal(finalState.liveAssistant, null)
  assert.equal(timelineBody.split('\n').length, liveBody.split('\n').length)
  assert.equal(finalState.timeline.length, 1)
})
