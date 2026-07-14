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
import { DEFAULT_COMMANDS } from '../../src/cli-commands/command-set.ts'
import { createFakeRuntime } from '../helpers/fakes.ts'

test('TerminalController renders providers as a plain list', () => {
  const ui = new TerminalController()

  ui.renderProviderList(['chatgpt', 'gemini', 'deepseek', 'doubao', 'grok'])

  const state = ui.getState()
  const latest = state.timeline.at(-1)
  assert.ok(latest)
  assert.equal(latest.label, '/providers')
  assert.equal(
    latest.body,
    [
      'Providers:',
      '  chatgpt',
      '  gemini',
      '  deepseek',
      '  doubao',
      '  grok',
    ].join('\n')
  )
  assert.equal(latest.format, 'plain')
})

test('TerminalController renders compact skill names and separates invalid skills', () => {
  const ui = new TerminalController()

  ui.renderSkillList({
    skills: [
      {
        name: 'chrome-automation',
        description: 'Not shown.',
        directory: 'C:\\data\\skills\\chrome-automation',
        enabled: true,
      },
      {
        name: 'pdf-processing',
        description: 'Also not shown.',
        directory: 'C:\\data\\skills\\pdf-processing',
        enabled: false,
      },
    ],
    issues: [
      {
        directory: 'C:\\data\\skills\\broken-skill',
        message: 'Missing SKILL.md',
      },
    ],
  })

  const entries = ui.getState().timeline.slice(-2)
  assert.equal(entries[0]?.tone, 'info')
  assert.equal(
    entries[0]?.body,
    ['Skills:', '* chrome-automation', '  pdf-processing'].join('\n')
  )
  assert.equal(entries[0]?.body.includes('Not shown.'), false)
  assert.equal(entries[0]?.body.includes('C:\\data'), false)
  assert.equal(entries[1]?.tone, 'warning')
  assert.equal(
    entries[1]?.body,
    [
      'Invalid skills:',
      '  C:\\data\\skills\\broken-skill',
      '    Missing SKILL.md',
    ].join('\n')
  )
})

test('TerminalController renders the thread command namespace in help', () => {
  const ui = new TerminalController()

  ui.renderCommandHelp(DEFAULT_COMMANDS)

  const body = ui.getState().timeline.at(-1)?.body ?? ''
  assert.equal(body.startsWith('Commands:\n'), true)
  assert.ok(body.includes('/thread <subcommand>'))
  assert.ok(body.includes('/skill <subcommand>'))
  assert.equal(body.includes('/open '), false)
  assert.equal(body.includes('/switch '), false)
  assert.equal(body.includes('/capability'), false)
  assert.equal(body.includes('/clear'), false)
  const commandLines = body.split('\n').slice(1)
  const descriptionColumns = commandLines.map((line) => {
    const command = DEFAULT_COMMANDS.find((item) => {
      const usage = item.usage ?? item.name
      return line.trimStart().startsWith(usage)
    })
    assert.ok(command)
    return line.indexOf(command.description)
  })
  assert.equal(new Set(descriptionColumns).size, 1)
})

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
  ui.bindThreadManager(manager)

  assert.equal(ui.promptLabel(manager), 'gemini > ')
  assert.equal(ui.getThreadManager()?.getActiveThread()?.id, 't-1')
})

test('TerminalController exposes manual skills from the active thread snapshot', () => {
  const manager = new ThreadManager()
  const first = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({ manualSkillNames: ['first-skill'] }),
    createdAt: 1,
  })
  const second = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime({ manualSkillNames: ['second-skill'] }),
    createdAt: 2,
  })
  const ui = new TerminalController()
  ui.bindThreadManager(manager)

  assert.deepEqual(ui.getActiveManualSkillNames(), ['second-skill'])
  manager.switchThread(first.id)
  assert.deepEqual(ui.getActiveManualSkillNames(), ['first-skill'])
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
  ui.renderInfo('/thread open', 'Thread t-1 is ready')
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

test('TerminalController keeps running state and live tools isolated by thread', () => {
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
  ui.bindThreadManager(manager)

  manager.switchThread(first.id)
  ui.showThreadTimeline(first.id)
  ui.setThreadBusy(first.id, true)
  ui.renderToolProgress(first, 'run_command', {
    type: 'start',
    startedAt: 1000,
  })
  ui.renderToolProgress(first, 'run_command', {
    type: 'output',
    stream: 'stdout',
    text: 'output from a',
  })

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
  assert.equal(ui.getState().liveCommand?.body, 'output from a')
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
  ui.bindThreadManager(manager)

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
  ui.bindThreadManager(manager)
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
      text: 'I will inspect it.\n<tool>{"tool":"run_command","params":{"command":"dir"}}</tool>\nThe results are in.',
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
    ['user', 'assistant', 'tool_call', 'assistant', 'assistant']
  )
  assert.equal(timeline[0]?.body, 'Inspect the project.')
  assert.equal(timeline[1]?.body, 'I will inspect it.')
  assert.match(timeline[2]?.body ?? '', /command: dir/)
  assert.equal(timeline[2]?.label, 'run_command · call')
  assert.equal(timeline[3]?.body, 'The results are in.')
  assert.equal(timeline[4]?.body, 'Inspection complete.')
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

test('TerminalController keeps a two-line live run_command tail and reuses its id', () => {
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
    JSON.stringify({ tool: 'run_command', params: { command: 'watch' } })
  )
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

  assert.equal(ui.getState().liveCommand?.body, 'replacement\nstderr: tail')

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

test('TerminalController clears a live run_command bubble when cancelled', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderToolProgress(thread, 'run_command', {
    type: 'start',
    startedAt: Date.now(),
  })
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
  assert.match(
    ui.getState().liveCommand?.body ?? '',
    /Waiting for child worker/
  )

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
    'load_skill',
    'success',
    { name: 'pdf-processing', instructions: 'FULL SKILL CONTENT' },
    'Loaded skill: pdf-processing'
  )

  const latest = ui.getState().timeline.at(-1)
  assert.equal(latest?.body, 'Loaded skill: pdf-processing')
  assert.equal(latest?.label, 'load_skill · result')
  assert.equal(latest?.tone, 'tool_result')
  assert.equal(latest?.body.includes('FULL SKILL CONTENT'), false)
})

test('TerminalController summarizes every remaining tool call without raw envelopes', () => {
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
    {
      tool: 'load_skill',
      params: { name: 'hybrid-catgirl' },
      expected: 'name: hybrid-catgirl',
    },
    {
      tool: 'mcp_search_tool',
      params: { server: 'github', tool: 'create_issue' },
      expected: 'server: github\ntool: create_issue',
    },
    {
      tool: 'mcp_call_tool',
      params: {
        server: 'github',
        tool: 'create_issue',
        arguments: { title: 'Bug' },
      },
      expected:
        'server: github\ntool: create_issue\narguments: {"title":"Bug"}',
    },
  ] as const

  for (const item of cases) {
    ui.renderToolCall(
      thread,
      item.tool,
      JSON.stringify({ tool: item.tool, params: item.params })
    )
    const entry = ui.getState().timeline.at(-1)
    assert.equal(entry?.label, `${item.tool} · call`)
    assert.equal(entry?.body, item.expected)
    assert.doesNotMatch(entry?.body ?? '', /"params"|"tool":/)
  }
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
    'mcp_call_tool',
    'error',
    { server: 'github', tool: 'create_issue', isError: true },
    'MCP tool returned an error.\nserver: github\ntool: create_issue'
  )
  let entry = ui.getState().timeline.at(-1)
  assert.equal(entry?.tone, 'error')
  assert.equal(entry?.label, 'mcp_call_tool · error')

  ui.renderToolResult(
    thread,
    'mcp_call_tool',
    'unknown',
    { server: 'github', tool: 'create_issue', retry: false },
    'MCP tool outcome is unknown.\nDo not retry automatically.'
  )
  entry = ui.getState().timeline.at(-1)
  assert.equal(entry?.tone, 'warning')
  assert.equal(entry?.label, 'mcp_call_tool · unknown')
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

test('TerminalController keeps streaming tool tags visible as assistant text', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'grok',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderAssistantStream(thread, '<tool>\n{"tool":"run_command"}\n</tool>')

  assert.equal(
    ui.getState().liveAssistant?.body,
    '\\<tool>\n{"tool":"run_command"}\n\\</tool>'
  )
})

test('TerminalController escapes named freeform tool tags while streaming', () => {
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
    '<tool name="apply_patch">\n*** Begin Patch\n</tool>'
  )

  assert.equal(
    ui.getState().liveAssistant?.body,
    '\\<tool name="apply_patch">\n*** Begin Patch\n\\</tool>'
  )
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

test('renderBubbleBody keeps an escaped streaming tool tag visible', () => {
  const rendered = renderBubbleBody('\\<tool>\n', 'markdown', 100)

  assert.match(rendered, /<tool>/)
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

  ui.renderToolCall(
    thread,
    'run_command',
    '{"tool":"run_command","params":{"command":"pwd"}}'
  )
  ui.renderAssistantMessage(thread, '<tool>\n')

  const entries = ui.getState().timeline
  assert.equal(entries[0]?.tone, 'tool_call')
  assert.equal(entries[1]?.tone, 'assistant')
  assert.equal(entries[1]?.body, '\\<tool>\n')
  assert.match(renderBubbleBody(entries[1]!.body, 'markdown', 100), /<tool>/)
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

test('TerminalController renders thread status without conversation id', () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime({
      conversationId: 'hidden-conversation-id',
      conversationUrl: 'https://example.com/thread-url',
    }),
    createdAt: 1,
  })
  const ui = new TerminalController()

  ui.renderThreadStatus(thread)

  const latest = ui.getState().timeline.at(-1)
  assert.ok(latest)
  assert.equal(latest.label, '/thread status')
  assert.equal(
    latest.body,
    [
      'Thread:',
      `  id: ${thread.id}`,
      '  provider: gemini',
      '  title: (untitled)',
      '  turns: 0',
      '  url: https://example.com/thread-url',
    ].join('\n')
  )
  assert.equal(latest.format, 'plain')
})

test('TerminalController renders thread list with title and conversation url', () => {
  const manager = new ThreadManager()
  const firstThread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime({
      conversationId: 'hidden-conversation-id-1',
      conversationUrl: 'https://example.com/thread-one',
    }),
    createdAt: 1,
  })
  const activeThread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime({
      conversationId: 'hidden-conversation-id-2',
      conversationUrl: 'https://example.com/thread-two',
    }),
    createdAt: 2,
  })
  const ui = new TerminalController()
  ui.bindThreadManager(manager)

  ui.renderThreadList([
    { ...firstThread, title: 'first prompt' },
    { ...activeThread, title: null },
  ])

  const latest = ui.getState().timeline.at(-1)
  assert.ok(latest)
  assert.equal(latest.label, '/thread list')
  assert.equal(latest.format, 'plain')
  assert.equal(latest.body.startsWith('Threads:\n'), true)
  assert.equal(
    latest.body,
    [
      'Threads:',
      `  ${firstThread.id}  deepseek  0 turns`,
      '  title: first prompt',
      '  url: https://example.com/thread-one',
      '',
      `* ${activeThread.id}  gemini  0 turns`,
      '  title: (untitled)',
      '  url: https://example.com/thread-two',
    ].join('\n')
  )
})

test('TerminalController renders thread history with stable ids and last used time', () => {
  const ui = new TerminalController()

  ui.renderThreadHistory([
    {
      id: 12,
      provider: 'gemini',
      conversationUrl: 'https://gemini.google.com/app/thread',
      title: null,
      createdAt: '2026-07-07T01:00:00.000Z',
      lastUsedAt: '2026-07-08T01:00:00.000Z',
    },
  ])

  const latest = ui.getState().timeline.at(-1)
  assert.ok(latest)
  assert.equal(latest.label, '/thread history')
  assert.equal(
    latest.body,
    [
      'History:',
      '#12 (untitled)',
      '   Provider: gemini',
      '   Created: 2026-07-07T01:00:00.000Z',
      '   Last used: 2026-07-08T01:00:00.000Z',
      '   URL: https://gemini.google.com/app/thread',
    ].join('\n')
  )
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
    '- `src/tools/` — 定义本地 Tool，解析 `<tool>` 并执行',
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
    '工具调用使用 `<tool>` XML 标签包裹 JSON，Patch 工具使用命名标签承载原始 V4A 文本：',
    '',
    '```json',
    '{"tool": "run_command", "params": {"command": "dir", "cwd": "C:\\\\project"}}',
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
