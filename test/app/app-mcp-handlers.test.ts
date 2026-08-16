import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMcpHandlers,
  type McpHandlerDependencies,
} from '../../src/app/app-mcp-handlers.ts'

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
  let stopResult: 'stopped' | 'not_found' | 'timeout' = 'stopped'
  // This focused fake implements only the job dependencies exercised here.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const dependencies = {
    surface: {
      listJobs: () => jobs,
      stopJob: async () => stopResult,
    },
    foregroundOperations: new Set(),
    isForegroundOperationActive: () => false,
  } as unknown as McpHandlerDependencies
  const handlers = createMcpHandlers(dependencies)

  assert.deepEqual(await handlers.listJobs(), { jobs })
  assert.deepEqual(await handlers.stopJob('j-1'), {
    stopped: true,
    jobId: 'j-1',
  })
  stopResult = 'not_found'
  await assert.rejects(handlers.stopJob('j-1'), /Unknown or finished job: j-1/)
  stopResult = 'timeout'
  await assert.rejects(
    handlers.stopJob('j-1'),
    /Timed out waiting for j-1 to stop/
  )
})
