import test from 'node:test'
import assert from 'node:assert/strict'

import { ThreadCommand } from '../../../src/cli-commands/commands/command-thread.ts'
import type { ProviderId } from '../../../src/providers/provider-id.ts'
import type { ResolvedProviderModel } from '../../../src/providers/provider-model-catalog.ts'
import {
  ThreadCloseCleanupError,
  ThreadManager,
} from '../../../src/threads/thread-manager.ts'
import { TerminalController } from '../../../src/terminal-ui/terminal-controller.ts'
import {
  createCliCommandContext,
  TEST_PROVIDER_IDS,
} from '../../helpers/cli-command-context.ts'
import { createFakeRuntime } from '../../helpers/fakes.ts'
import { latestTimelineEntry } from '../../helpers/ui.ts'
import type { ThreadCreationMode } from '../../../src/threads/thread-creation-mode.ts'

const fixtureCleanups = new Set<() => void>()

test.afterEach(() => {
  for (const cleanup of fixtureCleanups) cleanup()
  fixtureCleanups.clear()
})

function getLatestTimelineEntry(ui: TerminalController) {
  const entry = latestTimelineEntry(ui)
  assert.ok(entry)
  return entry
}

async function createCommandContext() {
  const ui = new TerminalController()
  const threadManager = new ThreadManager()
  const createdThreads: Array<{
    provider: ProviderId
    model: ResolvedProviderModel | null
    mode: ThreadCreationMode
  }> = []
  const resumedUrls: string[] = []
  const reloadedThreadIds: string[] = []
  const { context, cleanup } = createCliCommandContext({
    threadManager,
    ui,
    browserProfileDir: 'C:\\profiles\\chrome',
    providers: TEST_PROVIDER_IDS,
    createThread: async (provider, model, mode = 'agent') => {
      createdThreads.push({ provider, model, mode })
    },
    resumeThread: async (conversationUrl) => {
      resumedUrls.push(conversationUrl)
    },
    reloadThread: async (threadId) => {
      reloadedThreadIds.push(threadId)
    },
    addSkill: async () => {
      throw new Error('not used in thread command tests')
    },
    submitThreadInput: async () => {},
    listCommands: () => [ThreadCommand],
  })
  fixtureCleanups.add(cleanup)

  return {
    context,
    createdThreads,
    resumedUrls,
    reloadedThreadIds,
    threadManager,
    threadStore: context.threadStore,
    ui,
  }
}

test('ThreadCommand shows subcommand help when no subcommand is provided', async () => {
  const { context, ui } = await createCommandContext()

  const result = await ThreadCommand.execute(context, [])

  assert.equal(result.continue, true)
  const entry = getLatestTimelineEntry(ui)
  assert.equal(entry.label, '/thread')
  assert.equal(entry.tone, 'info')
  assert.match(entry.body, /open <provider> \[model-key\] \[option-key\]/)
  assert.match(entry.body, /chat <provider> \[model-key\] \[option-key\]/)
  assert.match(entry.body, /resume <conversation-url\|#history-id>/)
  assert.match(entry.body, /reload/)
  assert.match(entry.body, /close \[thread-id\]/)
  assert.match(entry.body, /detach/)
  assert.match(entry.body, /capability \[name\] \[action\]/)
})

test('ThreadCommand reload requires an active thread and forwards its id', async () => {
  const { context, reloadedThreadIds, threadManager, ui } =
    await createCommandContext()

  await ThreadCommand.execute(context, ['reload'])
  assert.deepEqual(getLatestTimelineEntry(ui), {
    tone: 'warning',
    label: '/thread reload',
    body: 'No active thread.',
    format: 'plain',
  })

  const thread = threadManager.addThread({
    id: 't-reload',
    provider: 'deepseek',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  await ThreadCommand.execute(context, ['reload'])
  assert.deepEqual(reloadedThreadIds, [thread.id])
})

test('ThreadCommand reload renders action failures', async () => {
  const { context, threadManager, ui } = await createCommandContext()
  threadManager.addThread({
    id: 't-reload-failure',
    provider: 'deepseek',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  context.reloadThread = async () => {
    throw new Error('reload failed')
  }

  await ThreadCommand.execute(context, ['reload'])

  assert.deepEqual(getLatestTimelineEntry(ui), {
    tone: 'warning',
    label: '/thread reload',
    body: 'reload failed',
    format: 'plain',
  })
})

test('ThreadCommand reload reports runtimes without reload support', async () => {
  const { context, threadManager, ui } = await createCommandContext()
  threadManager.addThread({
    id: 't-reload-unsupported',
    provider: 'deepseek',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  delete context.reloadThread

  await ThreadCommand.execute(context, ['reload'])

  assert.deepEqual(getLatestTimelineEntry(ui), {
    tone: 'warning',
    label: '/thread reload',
    body: 'Thread reload is not available in this runtime.',
    format: 'plain',
  })
})

test('ThreadCommand rejects unknown subcommands', async () => {
  const { context, ui } = await createCommandContext()

  await ThreadCommand.execute(context, ['unknown'])

  assert.deepEqual(getLatestTimelineEntry(ui), {
    tone: 'warning',
    label: '/thread',
    body: [
      'Unknown thread subcommand: unknown',
      'Run /thread to see available subcommands.',
    ].join('\n'),
    format: 'plain',
  })
})

test('ThreadCommand open validates provider and model', async () => {
  const { context, createdThreads, ui } = await createCommandContext()

  await ThreadCommand.execute(context, ['open'])
  assert.deepEqual(getLatestTimelineEntry(ui), {
    tone: 'warning',
    label: '/thread open',
    body: 'Missing provider. Usage: /thread open <provider> [model-key] [option-key]',
    format: 'plain',
  })

  await ThreadCommand.execute(context, ['open', 'unknown'])
  assert.equal(getLatestTimelineEntry(ui).body, 'Unknown provider: unknown')

  await ThreadCommand.execute(context, ['open', 'chatgpt', 'pro'])
  assert.equal(
    getLatestTimelineEntry(ui).body,
    'chatgpt does not support model "pro". Available models: chatgpt.'
  )

  await ThreadCommand.execute(context, ['open', 'deepseek', '2'])
  assert.match(getLatestTimelineEntry(ui).body, /does not support model "2"/)

  await ThreadCommand.execute(context, [
    'open',
    'deepseek',
    'expert',
    'thinking',
  ])
  assert.match(
    getLatestTimelineEntry(ui).body,
    /does not support model options/
  )

  await ThreadCommand.execute(context, [
    'open',
    'deepseek',
    'expert',
    'thinking',
    'extra',
  ])
  assert.match(getLatestTimelineEntry(ui).body, /Too many arguments/)
  assert.deepEqual(createdThreads, [])
})

test('ThreadCommand open forwards supported provider models', async () => {
  const { context, createdThreads } = await createCommandContext()

  await ThreadCommand.execute(context, [
    'open',
    'gemini',
    '3.1-pro',
    'extended',
  ])
  await ThreadCommand.execute(context, ['open', 'chatgpt', 'chatgpt'])
  await ThreadCommand.execute(context, ['open', 'deepseek', 'expert'])
  await ThreadCommand.execute(context, ['open', 'doubao', 'office-turbo'])
  await ThreadCommand.execute(context, ['open', 'grok'])
  await ThreadCommand.execute(context, ['open', 'glm', 'glm-5.1'])
  await ThreadCommand.execute(context, ['open', 'qwen', 'qwen3.8-max-preview'])
  await ThreadCommand.execute(context, ['open', 'kimi', 'k2.6'])

  assert.deepEqual(createdThreads, [
    {
      provider: 'gemini',
      model: {
        key: '3.1-pro',
        option: 'extended',
        adapterValue: '3+extended',
      },
      mode: 'agent',
    },
    {
      provider: 'chatgpt',
      model: { key: 'chatgpt', option: null, adapterValue: '1' },
      mode: 'agent',
    },
    {
      provider: 'deepseek',
      model: { key: 'expert', option: null, adapterValue: '2' },
      mode: 'agent',
    },
    {
      provider: 'doubao',
      model: { key: 'office-turbo', option: null, adapterValue: '3' },
      mode: 'agent',
    },
    { provider: 'grok', model: null, mode: 'agent' },
    {
      provider: 'glm',
      model: { key: 'glm-5.1', option: null, adapterValue: '2' },
      mode: 'agent',
    },
    {
      provider: 'qwen',
      model: {
        key: 'qwen3.8-max-preview',
        option: null,
        adapterValue: '2',
      },
      mode: 'agent',
    },
    {
      provider: 'kimi',
      model: { key: 'k2.6', option: null, adapterValue: '1' },
      mode: 'agent',
    },
  ])
})

test('ThreadCommand chat shares named model validation and forwards chat mode', async () => {
  const { context, createdThreads, ui } = await createCommandContext()

  await ThreadCommand.execute(context, ['chat', 'chatgpt'])
  await ThreadCommand.execute(context, [
    'chat',
    'gemini',
    '3.6-flash',
    'extended',
  ])

  assert.deepEqual(createdThreads, [
    { provider: 'chatgpt', model: null, mode: 'chat' },
    {
      provider: 'gemini',
      model: {
        key: '3.6-flash',
        option: 'extended',
        adapterValue: '2+extended',
      },
      mode: 'chat',
    },
  ])

  await ThreadCommand.execute(context, [
    'chat',
    'gemini',
    '3.6-flash',
    'extended',
    'extra',
  ])
  assert.equal(getLatestTimelineEntry(ui).label, '/thread chat')
  assert.match(getLatestTimelineEntry(ui).body, /Too many arguments/)
})

test('ThreadCommand history lists recent entries and validates limits', async () => {
  const { context, threadStore, ui } = await createCommandContext()
  await threadStore.append({
    provider: 'chatgpt',
    conversationUrl: 'https://chatgpt.com/c/one',
    title: null,
    createdAt: '2026-07-07T01:00:00.000Z',
    lastUsedAt: '2026-07-07T01:00:00.000Z',
  })
  await threadStore.append({
    provider: 'gemini',
    conversationUrl: 'https://gemini.google.com/app/two',
    title: 'second prompt',
    createdAt: '2026-07-07T02:00:00.000Z',
    lastUsedAt: '2026-07-07T02:00:00.000Z',
  })

  await ThreadCommand.execute(context, ['history', '1'])
  assert.deepEqual(getLatestTimelineEntry(ui), {
    tone: 'info',
    label: '/thread history',
    body: [
      'History:',
      '#2 second prompt',
      '   Provider: gemini',
      '   Created: 2026-07-07T02:00:00.000Z',
      '   Last used: 2026-07-07T02:00:00.000Z',
      '   URL: https://gemini.google.com/app/two',
    ].join('\n'),
    format: 'plain',
  })

  await ThreadCommand.execute(context, ['history', 'abc'])
  assert.deepEqual(getLatestTimelineEntry(ui), {
    tone: 'warning',
    label: '/thread history',
    body: 'Invalid limit: abc. Usage: /thread history [limit]',
    format: 'plain',
  })
})

test('ThreadCommand resume requires hash-prefixed history ids', async () => {
  const { context, resumedUrls, threadStore, ui } = await createCommandContext()
  await threadStore.append({
    provider: 'chatgpt',
    conversationUrl: 'https://chatgpt.com/c/history-conv',
    title: null,
    createdAt: '2026-07-07T01:00:00.000Z',
  })

  await ThreadCommand.execute(context, ['resume', '#1'])
  assert.deepEqual(resumedUrls, ['https://chatgpt.com/c/history-conv'])

  await ThreadCommand.execute(context, ['resume', '#abc'])
  assert.equal(
    getLatestTimelineEntry(ui).body,
    'Invalid history id: #abc. Expected #<positive-integer>.'
  )

  await ThreadCommand.execute(context, ['resume', '#99'])
  assert.equal(getLatestTimelineEntry(ui).body, 'History entry not found: #99')

  await ThreadCommand.execute(context, ['resume', '1'])
  assert.equal(
    getLatestTimelineEntry(ui).body,
    'Unsupported conversation URL: 1'
  )

  await ThreadCommand.execute(context, ['resume', 'https://chatgpt.com/c/%ZZ'])
  assert.equal(
    getLatestTimelineEntry(ui).body,
    'Unsupported conversation URL: https://chatgpt.com/c/%ZZ'
  )
})

test('ThreadCommand resume accepts URLs and rejects duplicate open threads', async () => {
  const { context, resumedUrls, threadManager, ui } =
    await createCommandContext()

  await ThreadCommand.execute(context, [
    'resume',
    'https://gemini.google.com/app/c_abc123#ignored',
  ])
  assert.deepEqual(resumedUrls, ['https://gemini.google.com/app/abc123'])

  const existingThread = threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime({
      conversationUrl: 'https://chat.deepseek.com/a/chat/s/conv-1',
    }),
    createdAt: 1,
  })
  await ThreadCommand.execute(context, [
    'resume',
    'https://chat.deepseek.com/a/chat/s/conv-1',
  ])
  assert.equal(
    getLatestTimelineEntry(ui).body,
    `Conversation already exists as thread ${existingThread.id}. Use /thread switch ${existingThread.id} to select it.`
  )
})

test('ThreadCommand manages live thread state', async () => {
  const { context, threadManager, ui } = await createCommandContext()
  const firstThread = threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime({
      conversationUrl: 'https://chat.deepseek.com/a/chat/s/one',
    }),
    createdAt: 1,
  })
  const secondThread = threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime({
      conversationUrl: 'https://gemini.google.com/app/two',
    }),
    createdAt: 2,
  })

  await ThreadCommand.execute(context, ['list'])
  assert.equal(getLatestTimelineEntry(ui).label, '/thread list')

  await ThreadCommand.execute(context, ['status'])
  assert.equal(getLatestTimelineEntry(ui).label, '/thread status')

  await ThreadCommand.execute(context, ['switch', firstThread.id])
  assert.equal(threadManager.getActiveThread()?.id, firstThread.id)
  assert.equal(ui.getState().timeline.length, 0)

  await ThreadCommand.execute(context, ['detach'])
  assert.equal(threadManager.getActiveThread(), null)

  await ThreadCommand.execute(context, ['detach'])
  assert.deepEqual(getLatestTimelineEntry(ui), {
    tone: 'warning',
    label: '/thread detach',
    body: 'No active thread.',
    format: 'plain',
  })

  await ThreadCommand.execute(context, ['close', secondThread.id])
  assert.equal(threadManager.getThread(secondThread.id), null)
  assert.deepEqual(getLatestTimelineEntry(ui), {
    tone: 'success',
    label: '/thread close',
    body: `Closed ${secondThread.id}.`,
    format: 'plain',
  })
})

test('ThreadCommand close defaults to the active thread', async () => {
  const { context, threadManager, ui } = await createCommandContext()
  const thread = threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  ui.renderInfo('home', 'Home timeline marker.')
  ui.showThreadTimeline(thread.id)

  await ThreadCommand.execute(context, ['close'])

  assert.equal(threadManager.getThread(thread.id), null)
  assert.equal(threadManager.getActiveThread(), null)
  assert.equal(getLatestTimelineEntry(ui).body, 'Home timeline marker.')
})

test('ThreadCommand removes a logically closed timeline when cleanup fails', async () => {
  const { context, threadManager, ui } = await createCommandContext()
  const thread = threadManager.addThread({
    id: 't-cleanup-failure',
    provider: 'chatgpt',
    runtime: createFakeRuntime({
      close: async () => {
        throw new Error('cleanup failed')
      },
    }),
    createdAt: 1,
  })
  ui.renderInfo('home', 'Home timeline marker.')
  ui.showThreadTimeline(thread.id)

  await assert.rejects(
    ThreadCommand.execute(context, ['close']),
    ThreadCloseCleanupError
  )

  assert.equal(threadManager.getThread(thread.id), null)
  assert.equal(threadManager.getActiveThread(), null)
  assert.equal(getLatestTimelineEntry(ui).body, 'Home timeline marker.')
})

test('ThreadCommand close without a target requires an active thread', async () => {
  const { context, threadManager, ui } = await createCommandContext()
  let closeCallCount = 0
  context.closeThread = async () => {
    closeCallCount += 1
    return false
  }

  await ThreadCommand.execute(context, ['close'])

  assert.equal(closeCallCount, 0)
  assert.equal(threadManager.listThreads().length, 0)
  assert.deepEqual(getLatestTimelineEntry(ui), {
    tone: 'warning',
    label: '/thread close',
    body: 'No active thread.',
    format: 'plain',
  })
})

test('ThreadCommand close rejects an explicitly empty thread id', async () => {
  const { context, threadManager, ui } = await createCommandContext()
  const thread = threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  let closeCallCount = 0
  context.closeThread = async () => {
    closeCallCount += 1
    return false
  }

  await ThreadCommand.execute(context, ['close', ''])

  assert.equal(closeCallCount, 0)
  assert.equal(threadManager.getActiveThread()?.id, thread.id)
  assert.deepEqual(getLatestTimelineEntry(ui), {
    tone: 'warning',
    label: '/thread close',
    body: 'Usage: /thread close [thread-id]',
    format: 'plain',
  })
})
