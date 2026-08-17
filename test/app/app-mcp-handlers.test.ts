import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMcpHandlers,
  type McpHandlerDependencies,
} from '../../src/app/app-mcp-handlers.ts'
import type { CommandJobService } from '../../src/cli-commands/core/command-services.ts'

test('MCP handler factory exposes the provider catalog without eager work', async () => {
  // This focused fake implements only the catalog dependency path.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const dependencies = {
    surface: { listProviders: () => ['grok', 'chatgpt'] },
    foregroundOperations: new Set(),
    isForegroundOperationActive: () => false,
  } as unknown as McpHandlerDependencies

  const handlers = createMcpHandlers(dependencies)
  const result = await handlers.listProviders()

  assert.ok(result.providers.includes('grok'))
  assert.ok(result.providers.includes('chatgpt'))
})

test('MCP handlers map thread state at the surface boundary', async () => {
  const thread = {
    id: 'thread-1',
    provider: 'grok',
    title: 'Smoke',
    runtime: { conversationUrl: 'https://grok.com/c/example' },
    turnCount: 2,
    createdAt: 10,
    updatedAt: 20,
  }
  // This focused fake implements only the thread-summary dependency path.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const dependencies = {
    surface: {
      getThread: (threadId: string) =>
        threadId === thread.id
          ? {
              id: thread.id,
              provider: thread.provider,
              title: thread.title,
              conversationUrl: thread.runtime.conversationUrl,
              busy: true,
              turnCount: thread.turnCount,
              createdAt: thread.createdAt,
              updatedAt: thread.updatedAt,
            }
          : null,
    },
    foregroundOperations: new Set(),
    isForegroundOperationActive: () => false,
  } as unknown as McpHandlerDependencies
  const handlers = createMcpHandlers(dependencies)

  assert.deepEqual(await handlers.getThread(thread.id), {
    id: 'thread-1',
    provider: 'grok',
    title: 'Smoke',
    conversationUrl: 'https://grok.com/c/example',
    busy: true,
    turnCount: 2,
    createdAt: 10,
    updatedAt: 20,
  })
  await assert.rejects(handlers.getThread('missing'), /Unknown thread: missing/)
})

test('MCP handlers list and stop run_command jobs', async () => {
  const jobs = [
    {
      id: 'j-1',
      pid: 123,
      command: 'work',
      cwd: 'C:\\workspace',
      shell: 'powershell' as const,
      startedAt: 1,
      state: 'running' as const,
    },
  ]
  let stopResult: 'stopped' | 'not-found' | 'timeout' = 'stopped'
  let receivedStopSignal: AbortSignal | null = null
  // This focused fake implements only the job dependencies exercised here.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const dependencies = {
    surface: {
      listProviders: () => [],
    },
    runCommandJobs: {
      list: () => jobs,
      stop: async (_id, signal) => {
        receivedStopSignal = signal
        return stopResult
      },
    } satisfies CommandJobService,
    foregroundOperations: new Set(),
    isForegroundOperationActive: () => false,
  } as unknown as McpHandlerDependencies
  const handlers = createMcpHandlers(dependencies)

  assert.deepEqual(await handlers.listJobs!(), { jobs })
  const signal = new AbortController().signal
  assert.deepEqual(await handlers.stopJob!('j-1', signal), {
    stopped: true,
    jobId: 'j-1',
  })
  assert.equal(receivedStopSignal, signal)
  stopResult = 'not-found'
  await assert.rejects(
    handlers.stopJob!('j-1', signal),
    /Unknown or finished job: j-1/
  )
  stopResult = 'timeout'
  await assert.rejects(
    handlers.stopJob!('j-1', signal),
    /Timed out waiting for j-1 to stop/
  )
})
