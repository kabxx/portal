import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { ThreadCommand } from '../../../src/cli-commands/commands/command-thread.ts'
import type { CliCommandContext } from '../../../src/cli-commands/core/command-types.ts'
import type { ProviderId } from '../../../src/providers/provider-id.ts'
import { ThreadManager } from '../../../src/threads/thread-manager.ts'
import { ThreadStore } from '../../../src/threads/thread-store.ts'
import { TerminalController } from '../../../src/terminal-ui/terminal-controller.ts'
import { createFakeRuntime } from '../../helpers/fakes.ts'
import { latestTimelineEntry } from '../../helpers/ui.ts'
import type { SkillLibrary } from '../../../src/skills/skill-library.ts'
import type { McpLibrary } from '../../../src/mcp/mcp-library.ts'

function getLatestTimelineEntry(ui: TerminalController) {
  const entry = latestTimelineEntry(ui)
  assert.ok(entry)
  return entry
}

async function createCommandContext() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-thread-command-'))
  const ui = new TerminalController()
  const threadManager = new ThreadManager()
  const threadStore = new ThreadStore(path.join(dir, 'threads.db'))
  const createdThreads: Array<{ provider: ProviderId; model: string | null }> =
    []
  const resumedUrls: string[] = []
  const reloadedThreadIds: string[] = []
  const context: CliCommandContext = {
    readline: {} as CliCommandContext['readline'],
    threadManager,
    threadStore,
    skillLibrary: {} as SkillLibrary,
    mcpLibrary: {} as McpLibrary,
    ui,
    browserProfileDir: 'C:\\profiles\\chrome',
    providers: ['chatgpt', 'gemini', 'deepseek', 'doubao', 'grok', 'glm'],
    resolveProvider: (value) => {
      const normalized = value.trim().toLowerCase()
      return context.providers.includes(normalized as ProviderId)
        ? (normalized as ProviderId)
        : null
    },
    createThread: async (provider, model) => {
      createdThreads.push({ provider, model })
    },
    resumeThread: async (conversationUrl) => {
      resumedUrls.push(conversationUrl)
    },
    reloadThread: async (threadId) => {
      reloadedThreadIds.push(threadId)
    },
    closeThread: async (threadId) => await threadManager.closeThread(threadId),
    addSkill: async () => {
      throw new Error('not used in thread command tests')
    },
    submitThreadInput: async () => {},
    listCommands: () => [ThreadCommand],
  }

  return {
    context,
    createdThreads,
    resumedUrls,
    reloadedThreadIds,
    threadManager,
    threadStore,
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
  assert.match(entry.body, /open <provider> \[model-number\]/)
  assert.match(entry.body, /resume <conversation-url\|#history-id>/)
  assert.match(entry.body, /reload/)
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
    body: 'Missing provider. Usage: /thread open <provider> [model-number]',
    format: 'plain',
  })

  await ThreadCommand.execute(context, ['open', 'unknown'])
  assert.equal(getLatestTimelineEntry(ui).body, 'Unknown provider: unknown')

  await ThreadCommand.execute(context, ['open', 'chatgpt', 'pro'])
  assert.equal(
    getLatestTimelineEntry(ui).body,
    'chatgpt does not support model "pro".'
  )
  assert.deepEqual(createdThreads, [])
})

test('ThreadCommand open forwards supported provider models', async () => {
  const { context, createdThreads } = await createCommandContext()

  await ThreadCommand.execute(context, ['open', 'gemini', '3+extended'])
  await ThreadCommand.execute(context, ['open', 'chatgpt', '2+1'])
  await ThreadCommand.execute(context, ['open', 'deepseek', '2'])
  await ThreadCommand.execute(context, ['open', 'doubao', '3'])
  await ThreadCommand.execute(context, ['open', 'grok'])
  await ThreadCommand.execute(context, ['open', 'glm', '2'])

  assert.deepEqual(createdThreads, [
    { provider: 'gemini', model: '3+extended' },
    { provider: 'chatgpt', model: '2+1' },
    { provider: 'deepseek', model: '2' },
    { provider: 'doubao', model: '3' },
    { provider: 'grok', model: null },
    { provider: 'glm', model: '2' },
  ])
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
